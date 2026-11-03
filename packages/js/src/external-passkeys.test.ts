import { describe, expect, it, vi } from 'vitest';
import { loginWithExternalPasskey, registerExternalPasskey } from './external-passkeys';
import type { WebAuthnHost } from './passkey';

const buf = (a: number[]) => new Uint8Array(a).buffer;
const endpoints = { registrationInit: '/p/reg/init', registrationFinalize: '/p/reg/fin', loginInit: '/p/log/init', loginFinalize: '/p/log/fin' };

function server() {
  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body });
    if (url === endpoints.registrationInit) return new Response(JSON.stringify({ options: { challenge: 'Y2g', rp: { id: 'a.test', name: 'A' }, user: { id: 'dTE', name: 'u', displayName: 'U' }, pubKeyCredParams: [] } }));
    if (url === endpoints.loginInit) return new Response(JSON.stringify({ handle: 'wa_1', options: { challenge: 'Y2g', rpId: 'a.test', allowCredentials: [] } }));
    if (url === '/fail') return new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 400 });
    return new Response(JSON.stringify({ ok: true }));
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const host: WebAuthnHost = {
  credentials: {
    create: vi.fn(async () => ({ rawId: buf([9]), id: 'CQ', response: { attestationObject: buf([1]), clientDataJSON: buf([2]) } }) as unknown as Credential),
    get: vi.fn(async () => ({ rawId: buf([9]), id: 'CQ', response: { authenticatorData: buf([3]), clientDataJSON: buf([4]), signature: buf([5]) } }) as unknown as Credential),
  },
};

describe('external-store passkeys', () => {
  it('registers: init -> browser create -> finalize, never sending a user id from the browser', async () => {
    const s = server();
    await registerExternalPasskey({ endpoints, fetch: s.fetchImpl, host }, { name: 'Laptop' });
    expect(s.calls.map((c) => c.url)).toEqual([endpoints.registrationInit, endpoints.registrationFinalize]);
    expect(s.calls[0]!.body).toEqual({});
    expect(s.calls[1]!.body).toMatchObject({ challenge: 'Y2g', name: 'Laptop', attestation_object: 'AQ', client_data_json: 'Ag' });
    expect(s.calls[1]!.body.user_id).toBeUndefined();
  });

  it('logs in: init -> browser get -> finalize with the handle', async () => {
    const s = server();
    await loginWithExternalPasskey({ endpoints, fetch: s.fetchImpl, host });
    expect(s.calls[1]!.url).toBe(endpoints.loginFinalize);
    expect(s.calls[1]!.body).toMatchObject({ handle: 'wa_1', challenge: 'Y2g', credential_id: 'CQ', signature: 'BQ' });
  });

  it('surfaces the backend error message', async () => {
    const s = server();
    await expect(registerExternalPasskey({ endpoints: { ...endpoints, registrationInit: '/fail' }, fetch: s.fetchImpl, host })).rejects.toThrow('nope');
  });
});
