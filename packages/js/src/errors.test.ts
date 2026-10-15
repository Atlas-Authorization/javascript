import { describe, expect, it, vi } from 'vitest';
import { fieldErrors } from './attempt';
import { ApiKeyRequestError, listApiKeys } from './api-keys';
import { ERROR_REASONS, catalogLocale, errorReasonKey, localizedErrorMessage } from './errors';
import { FapiClient, acceptLanguageFor } from './fapi';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('reason on Frontend API errors', () => {
  it('parses `reason` when the server sends one, and leaves it off otherwise', () => {
    const errors = fieldErrors({
      errors: [
        { code: 'INVALID', message: 'Those credentials are incorrect.', param: 'password', reason: 'form_password_incorrect' },
        { code: 'INVALID', message: 'Old server.' },
        { code: 'INVALID', message: 'Bad reason type.', reason: 42 },
      ],
    });
    expect(errors[0]).toEqual({
      code: 'INVALID',
      message: 'Those credentials are incorrect.',
      param: 'password',
      reason: 'form_password_incorrect',
    });
    expect('reason' in errors[1]!).toBe(false);
    expect('reason' in errors[2]!).toBe(false);
  });

  it('carries the reason onto ApiKeyRequestError', async () => {
    const fetchImpl = vi.fn(async () =>
      json(429, { errors: [{ code: 'RATE_LIMITED', message: 'Slow down.', reason: 'too_many_attempts' }] }),
    ) as unknown as typeof fetch;
    const client = new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://fapi.example', fetchImpl });
    const err = await listApiKeys(client).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiKeyRequestError);
    expect((err as ApiKeyRequestError).reason).toBe('too_many_attempts');
    expect((err as ApiKeyRequestError).code).toBe('RATE_LIMITED');
  });

  it('tags a network failure with the client-side `network` reason', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('offline');
    }) as unknown as typeof fetch;
    const client = new FapiClient({ publishableKey: 'pk_test_x', fetchImpl });
    const res = await client.get('/v1/client');
    expect(res.errors[0]).toMatchObject({ code: 'NETWORK', reason: 'network' });
  });
});

describe('Accept-Language', () => {
  function capture(locale?: string) {
    const calls: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push(init);
      return json(200, {});
    }) as unknown as typeof fetch;
    return { client: new FapiClient({ publishableKey: 'pk_test_x', fetchImpl, locale }), calls };
  }

  it('sends the app locale as Accept-Language', async () => {
    const { client, calls } = capture('es');
    await client.post('/v1/client/sign_ins', { identifier: 'a@b.co' });
    expect((calls[0]!.headers as Record<string, string>)['accept-language']).toBe('es');
    expect(client.locale).toBe('es');
  });

  it('sends no header without a locale, or with a malformed one', async () => {
    for (const locale of [undefined, '', 'es;q=1\r\nx: y', 'e']) {
      const { client, calls } = capture(locale);
      await client.get('/v1/client');
      expect((calls[0]!.headers as Record<string, string>)['accept-language']).toBeUndefined();
    }
  });

  it('normalises underscores', () => {
    expect(acceptLanguageFor('pt_BR')).toBe('pt-BR');
    expect(acceptLanguageFor('zh-Hant-TW')).toBe('zh-Hant-TW');
    expect(acceptLanguageFor(null)).toBeNull();
  });
});

describe('localizedErrorMessage', () => {
  const es = {
    'error.form_password_incorrect': 'La contraseña no es correcta.',
    'error.generic': 'Algo salió mal.',
  };

  it('prefers the catalog string for the reason', () => {
    expect(
      localizedErrorMessage({ reason: 'form_password_incorrect', message: 'Those credentials are incorrect.' }, es),
    ).toBe('La contraseña no es correcta.');
  });

  it('falls back to the server message for a reason the catalog lacks', () => {
    expect(localizedErrorMessage({ reason: 'brand_new_reason', message: 'Server says no.' }, es)).toBe(
      'Server says no.',
    );
  });

  it('falls back to the server message when there is no reason', () => {
    expect(localizedErrorMessage({ code: 'INVALID', message: 'Server says no.' }, es)).toBe('Server says no.');
  });

  it('treats a translate() that echoes the key as missing', () => {
    const t = (key: string) => (key === 'error.generic' ? 'Generic.' : key);
    expect(localizedErrorMessage({ reason: 'too_many_attempts', message: 'Slow down.' }, t)).toBe('Slow down.');
  });

  it('fills placeholders from meta', () => {
    const strings = { 'error.form_password_too_short': 'Mínimo {min_length} caracteres.' };
    expect(
      localizedErrorMessage({ reason: 'form_password_too_short', message: 'en', meta: { min_length: 12 } }, strings),
    ).toBe('Mínimo 12 caracteres.');
  });

  it('uses the server message when meta cannot fill a placeholder', () => {
    const strings = { 'error.form_identifier_exists': 'Inicia sesión con {methods}.' };
    expect(
      localizedErrorMessage(
        { reason: 'form_identifier_exists', message: 'Inicia sesión con Google.', meta: { providers: ['google'] } },
        strings,
      ),
    ).toBe('Inicia sesión con Google.');
  });

  it('parses meta off the wire', () => {
    const [error] = fieldErrors({
      errors: [{ code: 'PASSWORD_POLICY', message: 'm', reason: 'form_password_too_short', meta: { min_length: 8 } }],
    });
    expect(error!.meta).toEqual({ min_length: 8 });
  });

  it('is never blank', () => {
    expect(localizedErrorMessage({ reason: 'x', message: '  ' }, es)).toBe('Algo salió mal.');
    expect(localizedErrorMessage(null, {}, { 'error.generic': 'Fallback.' })).toBe('Fallback.');
    expect(localizedErrorMessage(undefined)).toBe('Something went wrong. Please try again.');
    expect(localizedErrorMessage({ message: '' }, () => '')).toBe('Something went wrong. Please try again.');
  });

  it('ignores reasons that are not plain tokens', () => {
    const tricky = { 'error.__proto__': 'nope', 'error.A B': 'nope' };
    expect(localizedErrorMessage({ reason: '__proto__', message: 'm1' }, tricky)).toBe('m1');
    expect(localizedErrorMessage({ reason: 'A B', message: 'm2' }, tricky)).toBe('m2');
  });

  it('accepts a plain string and an Error', () => {
    expect(localizedErrorMessage('Plain.', es)).toBe('Plain.');
    expect(localizedErrorMessage(new ApiKeyRequestError(400, 'X', 'Msg.', undefined, 'form_password_incorrect'), es)).toBe(
      'La contraseña no es correcta.',
    );
  });

  it('lists every reason with its key', () => {
    expect(ERROR_REASONS.length).toBeGreaterThan(0);
    for (const reason of ERROR_REASONS) expect(errorReasonKey(reason)).toBe(`error.${reason}`);
  });

  it('reads a catalog locale tag', () => {
    expect(catalogLocale({ locale: 'es-ES' })).toBe('es-ES');
    expect(catalogLocale({ 'signIn.title': 'x' })).toBeUndefined();
    expect(catalogLocale(undefined)).toBeUndefined();
  });
});
