import { describe, expect, it, vi } from 'vitest';
import { FapiClient } from './fapi';
import { completePasskeySecondFactor } from './passkey-second-factor';
import { revokeAllTrustedDevices } from './account-security';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function clientWith(routes: Record<string, Response>) {
  const calls: { path: string; method?: string; body: any }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input).replace('https://fapi.example', '');
    calls.push({ path, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return routes[path] ?? json(404, { errors: [{ code: 'NOT_FOUND', message: 'no route' }] });
  }) as unknown as typeof fetch;
  return { client: new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://fapi.example', fetchImpl, referral: false, exposeSession: false }), calls };
}

const assertion = async (c: Record<string, unknown>) => ({ challenge: c.challenge as string, credential_id: 'cid', authenticator_data: 'ad', client_data_json: 'cdj', signature: 'sig' });

describe('completePasskeySecondFactor', () => {
  it('continues an existing attempt: prepare, prompt, attempt_second_factor; returns the ticket', async () => {
    const { client, calls } = clientWith({
      '/v1/client/sign_ins/sia_1/prepare_second_factor': json(201, { object: 'second_factor_challenge', challenge: 'chal_1', rpId: 'example.com' }),
      '/v1/client/sign_ins/sia_1/attempt_second_factor': json(200, { id: 'sia_1', status: 'complete', ticket: 'tkt_1' }),
    });
    const out = await completePasskeySecondFactor(client, 'sia_1', { passkeyAssertion: assertion, rememberDevice: true });
    expect(out).toEqual({ ok: true, status: 'complete', attemptId: 'sia_1', ticket: 'tkt_1' });
    expect(calls[0]!.body).toEqual({ strategy: 'passkey' });
    expect(calls[1]!.body).toEqual({
      strategy: 'passkey', challenge: 'chal_1', credential_id: 'cid', authenticator_data: 'ad', client_data_json: 'cdj', signature: 'sig', remember_device: 'true',
    });
  });

  it('a later step still owed returns no ticket', async () => {
    const { client } = clientWith({
      '/v1/client/sign_ins/sia_2/prepare_second_factor': json(201, { challenge: 'c' }),
      '/v1/client/sign_ins/sia_2/attempt_second_factor': json(200, { id: 'sia_2', status: 'needs_required_action' }),
    });
    expect(await completePasskeySecondFactor(client, 'sia_2', { passkeyAssertion: assertion })).toEqual({ ok: true, status: 'needs_required_action', attemptId: 'sia_2', ticket: null });
  });

  it('a cancelled prompt answers passkey_cancelled and posts nothing', async () => {
    const { client, calls } = clientWith({ '/v1/client/sign_ins/sia_3/prepare_second_factor': json(201, { challenge: 'c' }) });
    const out = await completePasskeySecondFactor(client, 'sia_3', { passkeyAssertion: async () => { throw new Error('cancelled'); } });
    expect(out).toMatchObject({ ok: false, errors: [{ code: 'passkey_cancelled' }] });
    expect(calls).toHaveLength(1);
  });

  it('a refused assertion surfaces the server error', async () => {
    const { client } = clientWith({
      '/v1/client/sign_ins/sia_4/prepare_second_factor': json(201, { challenge: 'c' }),
      '/v1/client/sign_ins/sia_4/attempt_second_factor': json(422, { errors: [{ code: 'VERIFICATION_FAILED', message: 'That passkey could not be verified.' }] }),
    });
    expect(await completePasskeySecondFactor(client, 'sia_4', { passkeyAssertion: assertion })).toMatchObject({ ok: false, status: 422, errors: [{ code: 'VERIFICATION_FAILED' }] });
  });
});

describe('revokeAllTrustedDevices', () => {
  it('deletes every trusted device and returns the count', async () => {
    const { client, calls } = clientWith({ '/v1/client/me/trusted_devices': json(200, { object: 'trusted_device', deleted: true, count: 3 }) });
    expect(await revokeAllTrustedDevices(client)).toEqual({ ok: true, count: 3 });
    expect(calls[0]).toMatchObject({ path: '/v1/client/me/trusted_devices', method: 'DELETE' });
  });

  it('surfaces a refusal', async () => {
    const { client } = clientWith({ '/v1/client/me/trusted_devices': json(401, { errors: [{ code: 'UNAUTHENTICATED', message: 'Sign in.' }] }) });
    expect(await revokeAllTrustedDevices(client)).toMatchObject({ ok: false, status: 401 });
  });
});
