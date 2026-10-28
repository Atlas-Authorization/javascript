import { describe, expect, it } from 'vitest';
import { createFapiClient } from './client';
import {
  authenticateWithPasskey,
  registerPasskey,
  toAssertionFinishBody,
  toRegistrationFinishBody,
} from './index';
import type { ReactNativePasskey } from './passkey-native';

describe('body mapping', () => {
  it('maps a create result to the registration finish body', () => {
    const body = toRegistrationFinishBody(
      { challenge: 'chal_1' },
      { id: 'cred_1', response: { attestationObject: 'att', clientDataJSON: 'cdj' } },
      'My iPhone',
    );
    expect(body).toEqual({
      challenge: 'chal_1',
      attestation_object: 'att',
      client_data_json: 'cdj',
      name: 'My iPhone',
    });
  });

  it('maps a get result to the assertion finish body (rawId preferred)', () => {
    const body = toAssertionFinishBody(
      { challenge: 'chal_2', handle: 'h_2' },
      {
        id: 'id_2',
        rawId: 'raw_2',
        response: { authenticatorData: 'ad', clientDataJSON: 'cdj', signature: 'sig' },
      },
    );
    expect(body).toEqual({
      handle: 'h_2',
      challenge: 'chal_2',
      credential_id: 'raw_2',
      authenticator_data: 'ad',
      client_data_json: 'cdj',
      signature: 'sig',
    });
  });
});

/** Route fake JSON responses by `METHOD /path`, recording every request body. */
function router(handlers: Record<string, unknown>): {
  fetchImpl: typeof fetch;
  calls: Array<{ path: string; body: unknown }>;
} {
  const calls: Array<{ path: string; body: unknown }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(typeof input === 'string' ? input : input.toString()).pathname;
    calls.push({ path, body: init?.body ? JSON.parse(init.body as string) : undefined });
    const data = handlers[path];
    return new Response(JSON.stringify(data ?? null), {
      status: data === undefined ? 404 : 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const fakePasskey: ReactNativePasskey = {
  create: async () => ({
    id: 'cred_X',
    response: { attestationObject: 'ATT', clientDataJSON: 'CDJ' },
  }),
  get: async () => ({
    id: 'cred_Y',
    rawId: 'raw_Y',
    response: { authenticatorData: 'AD', clientDataJSON: 'CDJ', signature: 'SIG' },
  }),
};

const config = { frontendApi: 'https://fapi.example.test', publishableKey: 'pk_test' };

describe('registerPasskey', () => {
  it('runs begin → ceremony → finish and posts the mapped body', async () => {
    const { fetchImpl, calls } = router({
      '/v1/client/me/passkeys/begin': { challenge: 'chal_R' },
      '/v1/client/me/passkeys/finish': { ok: true },
    });

    const result = await registerPasskey({
      config: { ...config, fetchImpl, getToken: () => 'sess.jwt' },
      passkey: fakePasskey,
      name: 'Pixel',
    });

    expect(result.ok).toBe(true);
    const finish = calls.find((c) => c.path.endsWith('/finish'));
    expect(finish?.body).toEqual({
      challenge: 'chal_R',
      attestation_object: 'ATT',
      client_data_json: 'CDJ',
      name: 'Pixel',
    });
  });
});

describe('authenticateWithPasskey', () => {
  it('returns complete with a ticket when finish carries one', async () => {
    const { fetchImpl } = router({
      '/v1/client/sign_ins/passkey/begin': { challenge: 'chal_A', handle: 'h_A' },
      '/v1/client/sign_ins/passkey/finish': { id: 'att_1', status: 'complete', ticket: 'tkt_1' },
    });

    const result = await authenticateWithPasskey({
      config: { ...config, fetchImpl },
      passkey: fakePasskey,
    });

    expect(result).toMatchObject({ status: 'complete', ticket: 'tkt_1', attemptId: 'att_1' });
  });

  it('returns needs_more when finish owes a further factor', async () => {
    const { fetchImpl } = router({
      '/v1/client/sign_ins/passkey/begin': { challenge: 'chal_A', handle: 'h_A' },
      '/v1/client/sign_ins/passkey/finish': { id: 'att_1', status: 'needs_second_factor' },
    });

    const result = await authenticateWithPasskey({
      config: { ...config, fetchImpl },
      passkey: fakePasskey,
    });

    expect(result.status).toBe('needs_more');
    expect(result.ticket).toBeUndefined();
  });
});

describe('authenticateWithPasskey — sign-in captcha', () => {
  /** begin answers in turn from `begins`; everything else as in `router`. */
  function scripted(begins: Array<{ status: number; body: unknown }>) {
    const calls: Array<{ path: string; body: unknown }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(typeof input === 'string' ? input : input.toString()).pathname;
      calls.push({ path, body: init?.body ? JSON.parse(init.body as string) : undefined });
      const reply =
        path === '/v1/client/sign_ins/passkey/begin'
          ? begins.shift()!
          : path === '/v1/client/sign_ins/passkey/finish'
            ? { status: 200, body: { id: 'att_c', status: 'complete', ticket: 'tkt_c' } }
            : path === '/v1/appearance'
              ? { status: 200, body: { captchaFlows: { signIn: { enabled: false, provider: 'turnstile', siteKey: 'site_1', widget: 'managed' } } } }
              : { status: 404, body: null };
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const beginBodies = () => calls.filter((c) => c.path === '/v1/client/sign_ins/passkey/begin').map((c) => c.body);
    return { fetchImpl, beginBodies };
  }
  const OK = { status: 200, body: { challenge: 'chal_C', handle: 'h_C' } };
  const refused = (code: string) => ({ status: 400, body: { errors: [{ code, message: 'check', param: 'captcha_token' }] } });

  it('sends a token passed up front', async () => {
    const { fetchImpl, beginBodies } = scripted([OK]);
    const result = await authenticateWithPasskey({ config: { ...config, fetchImpl }, passkey: fakePasskey, captchaToken: 'tok_up' });
    expect(result.status).toBe('complete');
    expect(beginBodies()).toEqual([{ captcha_token: 'tok_up' }]);
  });

  it('after CAPTCHA_REQUIRED asks getCaptchaToken (with the sign-in captcha settings) and retries once', async () => {
    const { fetchImpl, beginBodies } = scripted([refused('CAPTCHA_REQUIRED'), OK]);
    const asked: unknown[] = [];
    const result = await authenticateWithPasskey({
      config: { ...config, fetchImpl },
      passkey: fakePasskey,
      getCaptchaToken: async (request) => {
        asked.push(request);
        return 'tok_fresh';
      },
    });
    expect(result).toMatchObject({ status: 'complete', ticket: 'tkt_c' });
    expect(beginBodies()).toEqual([{}, { captcha_token: 'tok_fresh' }]);
    expect(asked).toEqual([
      { flow: 'signIn', refused: 'CAPTCHA_REQUIRED', captcha: { enabled: false, provider: 'turnstile', siteKey: 'site_1', widget: 'managed' } },
    ]);
  });

  it('CAPTCHA_FAILED on the up-front token: one retry with a fresh token, then the refusal', async () => {
    const { fetchImpl, beginBodies } = scripted([refused('CAPTCHA_FAILED'), refused('CAPTCHA_FAILED')]);
    const result = await authenticateWithPasskey({
      config: { ...config, fetchImpl },
      passkey: fakePasskey,
      captchaToken: 'tok_old',
      getCaptchaToken: async () => 'tok_new',
    });
    expect(beginBodies()).toEqual([{ captcha_token: 'tok_old' }, { captcha_token: 'tok_new' }]);
    expect(result.status).toBe('error');
    expect(result.errors[0]?.code).toBe('CAPTCHA_FAILED');
  });

  it('without a callback a refusal is returned as the error', async () => {
    const { fetchImpl, beginBodies } = scripted([refused('CAPTCHA_REQUIRED')]);
    const result = await authenticateWithPasskey({ config: { ...config, fetchImpl }, passkey: fakePasskey });
    expect(beginBodies()).toEqual([{}]);
    expect(result).toMatchObject({ status: 'error', errors: [{ code: 'CAPTCHA_REQUIRED' }] });
  });
});

describe('createFapiClient config', () => {
  it('throws a clear config error when frontendApi is missing', () => {
    let caught: unknown;
    try {
      createFapiClient({ publishableKey: 'pk_test' } as unknown as Parameters<typeof createFapiClient>[0]);
    } catch (error) {
      caught = error;
    }
    expect((caught as { name?: string }).name).toBe('AtlasConfigError');
    expect((caught as { code?: string }).code).toBe('FRONTEND_API_REQUIRED');
  });
});
