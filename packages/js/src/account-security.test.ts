import { describe, expect, it, vi } from 'vitest';
import { FapiClient } from './fapi';
import { changePassword, listTrustedDevices, revokeTrustedDevice, setPassword } from './account-security';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function clientWith(answer: (path: string, init: RequestInit) => Response) {
  const calls: { path: string; method?: string; body: any }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input).replace('https://fapi.example', '');
    calls.push({ path, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return answer(path, init);
  }) as unknown as typeof fetch;
  return { client: new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://fapi.example', fetchImpl, referral: false, exposeSession: false }), calls };
}

describe('account security helpers', () => {
  it('changePassword posts both passwords and returns the revoked count and a fresh bearer token', async () => {
    const { client, calls } = clientWith(() => json(200, { object: 'user', id: 'user_1', sessions_revoked: 2, session_token: 'a.b.c', expires_in: 60 }));
    const out = await changePassword(client, { currentPassword: 'old', newPassword: 'new' });
    expect(out).toEqual({ ok: true, userId: 'user_1', sessionsRevoked: 2, sessionToken: 'a.b.c', expiresIn: 60 });
    expect(calls[0]).toMatchObject({ path: '/v1/client/me/change_password', body: { current_password: 'old', new_password: 'new' } });
  });

  it('changePassword and setPassword surface errors', async () => {
    const { client } = clientWith(() => json(400, { errors: [{ code: 'VERIFICATION_FAILED', message: 'Your current password is incorrect.', param: 'current_password' }] }));
    const out = await changePassword(client, { currentPassword: 'x', newPassword: 'y' });
    expect(out).toMatchObject({ ok: false, status: 400 });
    expect(out.ok === false && out.errors[0]!.code).toBe('VERIFICATION_FAILED');
    const set = clientWith(() => json(403, { errors: [{ code: 'STEP_UP_REQUIRED', message: 'Re-authenticate.' }] }));
    expect(await setPassword(set.client, 'pw')).toMatchObject({ ok: false, status: 403 });
  });

  it('setPassword posts the password', async () => {
    const { client, calls } = clientWith(() => json(200, { object: 'user', id: 'user_1', has_password: true }));
    expect(await setPassword(client, 'pw')).toEqual({ ok: true, userId: 'user_1', hasPassword: true });
    expect(calls[0]).toMatchObject({ path: '/v1/client/me/set_password', body: { password: 'pw' } });
  });

  it('lists and revokes trusted devices', async () => {
    const { client, calls } = clientWith((_p, init) =>
      init.method === 'DELETE'
        ? json(200, { object: 'trusted_device', id: 'td_1', deleted: true })
        : json(200, { object: 'list', data: [{ object: 'trusted_device', id: 'td_1', device: { browser: 'Firefox' }, created_at: 1, last_used_at: null, expires_at: 3 }] }),
    );
    expect(await listTrustedDevices(client)).toEqual({ ok: true, devices: [{ id: 'td_1', device: { browser: 'Firefox' }, createdAt: 1, lastUsedAt: null, expiresAt: 3 }] });
    expect(await revokeTrustedDevice(client, 'td_1')).toEqual({ ok: true });
    expect(calls[1]).toMatchObject({ path: '/v1/client/me/trusted_devices/td_1', method: 'DELETE' });
  });
});
