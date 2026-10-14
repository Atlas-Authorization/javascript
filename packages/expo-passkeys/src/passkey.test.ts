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
