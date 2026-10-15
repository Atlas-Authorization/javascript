// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ERROR_REASONS } from '@atlasauth/js';
import { enUS as enBundle, esES as esBundle, missingKeys, resolveLocale } from '@atlasauth/localizations';
import { AtlasProvider } from './AtlasProvider';
import { SignIn } from './sign-in';
import { EN_US, type Catalog } from './i18n';

const enUS = enBundle as unknown as Catalog;
const esES = esBundle as unknown as Catalog;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Server form errors render in the app's language: `<SignIn>` under
 * `<AtlasProvider locale="es">` shows the Spanish catalog string for the
 * error's `reason`, not the server's English `message`, and tells the server
 * the language (`Accept-Language`) so a reason the catalog lacks still comes
 * back localised.
 */

const FAPI = 'https://fapi.example';
const SERVER_MESSAGE = 'Server-side English sentence.';
const META = { min_length: 8, max_length: 64, history_count: 5 };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Sent {
  path: string;
  headers: Record<string, string>;
}

async function signInRefusedWith(
  error: Record<string, unknown>,
  props: { locale?: string; localization?: Catalog } = {},
): Promise<{ el: HTMLElement; sent: Sent[] }> {
  const sent: Sent[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    sent.push({ path, headers: { ...((init?.headers as Record<string, string>) ?? {}) } });
    if (path === '/v1/client') return json({ session: null, user: null });
    if (path === '/v1/client/sign_ins') return json({ errors: [error] }, 400);
    return json({});
  }) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchImpl);

  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(
      createElement(AtlasProvider, {
        publishableKey: 'pk_test_x',
        frontendApi: FAPI,
        fetchImpl,
        appearance: { instanceDesign: false },
        ...props,
        children: createElement(SignIn),
      }),
    );
  });
  unmount = () => act(() => root.unmount());

  const input = el.querySelector('input[name="identifier"]') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, 'someone@example.com');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await act(async () => {
    el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await vi.waitFor(() => expect(el.querySelector('.atlas-error')).not.toBeNull());
  return { el, sent };
}

const errorText = (el: HTMLElement) =>
  [...el.querySelectorAll('.atlas-error')].map((node) => node.textContent).join(' | ');

/** The catalog sentence for a reason with `meta` filled; the server's message if it cannot be filled. */
function expected(bundle: Catalog, reason: string): string {
  const template = bundle[`error.${reason}`]!;
  let complete = true;
  const text = template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = (META as Record<string, unknown>)[name];
    if (value === undefined) complete = false;
    return value === undefined ? match : String(value);
  });
  return complete ? text : SERVER_MESSAGE;
}

describe('every reason renders in English and Spanish', () => {
  for (const reason of ERROR_REASONS) {
    for (const [locale, bundle] of [
      ['en', enUS],
      ['es', esES],
    ] as const) {
      it(`${reason} (${locale})`, async () => {
        const { el } = await signInRefusedWith(
          { code: 'VERIFICATION_FAILED', message: SERVER_MESSAGE, reason, meta: META },
          { locale },
        );
        expect(errorText(el)).toBe(expected(bundle, reason));
      });
    }
  }

  it('the Spanish strings really differ from the English ones', () => {
    const same = ERROR_REASONS.filter((r) => enUS[`error.${r}`] === esES[`error.${r}`]);
    expect(same).toEqual([]);
  });
});

describe('fallbacks', () => {
  it('an unknown reason shows the server message', async () => {
    const { el } = await signInRefusedWith(
      { code: 'X', message: 'Mensaje del servidor.', reason: 'reason_from_the_future' },
      { locale: 'es' },
    );
    expect(errorText(el)).toBe('Mensaje del servidor.');
  });

  it('an error without a reason (older server) shows the server message', async () => {
    const { el } = await signInRefusedWith({ code: 'X', message: 'Old server says no.' }, { locale: 'es' });
    expect(errorText(el)).toBe('Old server says no.');
  });

  it('a field error is localised too', async () => {
    const { el } = await signInRefusedWith(
      { code: 'VERIFICATION_FAILED', message: SERVER_MESSAGE, reason: 'form_password_incorrect', param: 'identifier' },
      { locale: 'es' },
    );
    expect(el.querySelector('label .atlas-error')!.textContent).toBe(esES['error.form_password_incorrect']);
  });

  it('a `localization` override wins over the built-in bundle', async () => {
    const { el } = await signInRefusedWith(
      { code: 'VERIFICATION_FAILED', message: SERVER_MESSAGE, reason: 'form_password_incorrect' },
      { locale: 'es', localization: { 'error.form_password_incorrect': 'Revisa tus datos.' } },
    );
    expect(errorText(el)).toBe('Revisa tus datos.');
  });

  it('a locale without a bundle uses the (server-localised) message, not English catalog text', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { el } = await signInRefusedWith(
      { code: 'VERIFICATION_FAILED', message: '자격 증명이 올바르지 않습니다.', reason: 'form_password_incorrect' },
      { locale: 'ko' },
    );
    expect(errorText(el)).toBe('자격 증명이 올바르지 않습니다.');
  });

  it('with no locale, the English catalog string is used', async () => {
    const { el } = await signInRefusedWith({
      code: 'VERIFICATION_FAILED',
      message: SERVER_MESSAGE,
      reason: 'too_many_attempts',
    });
    expect(errorText(el)).toBe(EN_US['error.too_many_attempts']);
  });
});

describe('Accept-Language', () => {
  it('is sent with the app locale on the sign-in request', async () => {
    const { sent } = await signInRefusedWith({ code: 'X', message: 'm' }, { locale: 'es' });
    const post = sent.find((s) => s.path === '/v1/client/sign_ins')!;
    expect(post.headers['accept-language']).toBe('es');
  });

  it('comes from a localization bundle when no locale is set', async () => {
    const { sent } = await signInRefusedWith({ code: 'X', message: 'm' }, { localization: esES });
    const post = sent.find((s) => s.path === '/v1/client/sign_ins')!;
    expect(post.headers['accept-language']).toBe('es-ES');
  });

  it('is not sent without a locale', async () => {
    const { sent } = await signInRefusedWith({ code: 'X', message: 'm' });
    const post = sent.find((s) => s.path === '/v1/client/sign_ins')!;
    expect(post.headers['accept-language']).toBeUndefined();
  });
});

describe('catalog coverage', () => {
  it('every reason has a key in EN_US and the Spanish bundle', () => {
    for (const reason of ERROR_REASONS) {
      expect(EN_US[`error.${reason}`], reason).toBeTruthy();
    }
    expect(missingKeys(resolveLocale('es')!, enUS)).toEqual([]);
    expect(missingKeys(esES, EN_US)).toEqual([]);
  });
});
