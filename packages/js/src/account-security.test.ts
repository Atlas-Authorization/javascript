import { describe, expect, it, vi } from 'vitest';
import { FapiClient } from './fapi';
import {
  changePassword,
  getNotificationPreferences,
  listMfaFactors,
  listPasskeys,
  listSessions,
  listTrustedDevices,
  regenerateBackupCodes,
  removeMfaFactor,
  removePasskey,
  revokeAllSessions,
  revokeAccountSession,
  revokeTrustedDevice,
  setPassword,
  startSms,
  startTotp,
  unlinkExternalAccount,
  updateNotificationPreferences,
  verifySms,
  verifyTotp,
} from './account-security';

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

describe('security page helpers', () => {
  const stepUpBody = { errors: [{ code: 'STEP_UP_REQUIRED', message: 'Re-authenticate.', meta: { action: 'mfa_change', accepted_factors: ['password', 'totp'], max_age_seconds: 300 } }] };

  it('lists sessions with the current one marked, and revokes', async () => {
    const { client, calls } = clientWith((path) =>
      path === '/v1/client/sessions'
        ? json(200, { object: 'list', data: [{ id: 'sess_1', status: 'active', current: true, last_active_at: 3, expire_at: 9, created_at: 1, device_label: 'Chrome on macOS', ip_address: '1.2.3.4', sign_in_method: 'oauth', provider: 'google', amr: ['ext'] }, { id: 'sess_2', status: 'active', current: false, last_active_at: 2, expire_at: 8, created_at: 1 }] })
        : path.endsWith('/revoke_all') ? json(200, { object: 'client', sessions_revoked: 3 }) : json(200, { object: 'session', id: 'sess_2', status: 'revoked' }),
    );
    const list = await listSessions(client);
    expect(list.ok && list.sessions.map((s) => [s.id, s.current])).toEqual([['sess_1', true], ['sess_2', false]]);
    expect(list.ok && list.sessions[0]).toMatchObject({ deviceLabel: 'Chrome on macOS', ipAddress: '1.2.3.4', location: null });
    expect(list.ok && list.sessions[0]).toMatchObject({ signInMethod: 'oauth', provider: 'google', amr: ['ext'] });
    expect(list.ok && list.sessions[1]).toMatchObject({ signInMethod: null, provider: null, amr: null });
    expect(await revokeAccountSession(client, 'sess_2')).toEqual({ ok: true });
    expect(await revokeAllSessions(client)).toEqual({ ok: true, count: 3 });
    expect(calls.map((c) => `${c.method ?? 'GET'} ${c.path}`)).toEqual(['GET /v1/client/sessions', 'POST /v1/client/sessions/sess_2/revoke', 'POST /v1/client/sessions/revoke_all']);
  });

  it('lists factors and removes one', async () => {
    const { client, calls } = clientWith((_p, init) =>
      init.method === 'DELETE' ? json(200, { object: 'mfa_factor', id: 'mfa_1', deleted: true }) : json(200, { object: 'list', data: [{ id: 'mfa_1', type: 'sms', verified: true, phone: '+1 ••• 4821', created_at: 5 }], backup_codes_remaining: 8 }),
    );
    expect(await listMfaFactors(client)).toEqual({ ok: true, factors: [{ id: 'mfa_1', type: 'sms', verified: true, phone: '+1 ••• 4821', createdAt: 5 }], backupCodesRemaining: 8 });
    expect(await removeMfaFactor(client, 'mfa_1')).toEqual({ ok: true });
    expect(calls[1]).toMatchObject({ path: '/v1/client/me/mfa/mfa_1', method: 'DELETE' });
  });

  it('starts TOTP with the QR and secret, then verifies and returns the recovery codes', async () => {
    const { client, calls } = clientWith((path) =>
      path.endsWith('/verify')
        ? json(200, { object: 'mfa_factor', id: 'mfa_t', type: 'totp', verified: true, created_at: 1, backup_codes: ['aaaa-bbbb', 'cccc-dddd'] })
        : json(201, { object: 'mfa_factor', id: 'mfa_t', type: 'totp', verified: false, created_at: 1, secret: 'JBSWY3DP', uri: 'otpauth://totp/x', qr_svg: '<svg></svg>', required_codes: 2 }),
    );
    const start = await startTotp(client);
    expect(start).toEqual({ ok: true, enrollment: { factorId: 'mfa_t', secret: 'JBSWY3DP', uri: 'otpauth://totp/x', qrSvg: '<svg></svg>', requiredCodes: 2 } });
    const done = await verifyTotp(client, 'mfa_t', ['111111', '222222']);
    expect(done).toMatchObject({ ok: true, factor: { id: 'mfa_t', verified: true }, backupCodes: ['aaaa-bbbb', 'cccc-dddd'] });
    expect(calls[1]).toMatchObject({ path: '/v1/client/me/mfa/totp/mfa_t/verify', body: { codes: ['111111', '222222'] } });
  });

  it('starts and verifies texted codes; no recovery codes when the account already has them', async () => {
    const { client, calls } = clientWith((path) =>
      path.endsWith('/verify')
        ? json(200, { object: 'mfa_factor', id: 'mfa_s', type: 'sms', verified: true, created_at: 1, phone: '+1 ••• 4821' })
        : json(201, { object: 'mfa_factor', id: 'mfa_s', type: 'sms', verified: false, created_at: 1, phone: '+1 ••• 4821' }),
    );
    expect(await startSms(client, '+15551234821')).toEqual({ ok: true, factorId: 'mfa_s', phone: '+1 ••• 4821' });
    const done = await verifySms(client, 'mfa_s', '123456');
    expect(done.ok && done.backupCodes).toBeUndefined();
    expect(calls[0]!.body).toEqual({ phone: '+15551234821' });
    expect(calls[1]).toMatchObject({ path: '/v1/client/me/mfa/sms/mfa_s/verify', body: { code: '123456' } });
  });

  it('regenerates recovery codes', async () => {
    const { client } = clientWith(() => json(200, { object: 'backup_codes', codes: ['a', 'b'] }));
    expect(await regenerateBackupCodes(client)).toEqual({ ok: true, codes: ['a', 'b'] });
  });

  it('reports a step-up refusal the way requireStepUp reads it', async () => {
    const { client } = clientWith(() => json(403, stepUpBody));
    for (const out of [await startTotp(client), await removeMfaFactor(client, 'm'), await regenerateBackupCodes(client), await removePasskey(client, 'p'), await unlinkExternalAccount(client, 'e')]) {
      expect(out).toMatchObject({ ok: false, status: 403, stepUpRequired: true, stepUp: { action: 'mfa_change', acceptedFactors: ['password', 'totp'], maxAgeSeconds: 300 } });
    }
    const other = clientWith(() => json(409, { errors: [{ code: 'LAST_AUTH_METHOD', message: 'only way in' }] }));
    expect(await unlinkExternalAccount(other.client, 'e')).toMatchObject({ ok: false, status: 409, stepUpRequired: false });
  });

  it('lists and removes passkeys, unlinks an external account', async () => {
    const { client, calls } = clientWith((_p, init) =>
      init.method === 'DELETE' ? json(200, { deleted: true }) : json(200, { object: 'list', data: [{ id: 'pk_1', name: 'Phone', backed_up: true, last_used_at: null, created_at: 4, authenticator: { name: 'iCloud Keychain', icon: null } }] }),
    );
    expect(await listPasskeys(client)).toEqual({ ok: true, passkeys: [{ id: 'pk_1', name: 'Phone', backedUp: true, lastUsedAt: null, createdAt: 4, authenticator: { name: 'iCloud Keychain', icon: null } }] });
    expect(await removePasskey(client, 'pk_1')).toEqual({ ok: true });
    expect(await unlinkExternalAccount(client, 'ext 1')).toEqual({ ok: true });
    expect(calls.slice(1).map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /v1/client/me/passkeys/pk_1', 'DELETE /v1/client/me/external_accounts/ext%201']);
  });

  it('reads and patches notification preferences', async () => {
    const prefs = { object: 'notification_preferences', preferences: [{ category: 'new_device', label: 'New device', enabled: false, optional: true }] };
    const { client, calls } = clientWith(() => json(200, prefs));
    expect(await getNotificationPreferences(client)).toEqual({ ok: true, preferences: prefs.preferences });
    expect(await updateNotificationPreferences(client, { new_device: false })).toEqual({ ok: true, preferences: prefs.preferences });
    expect(calls[1]).toMatchObject({ path: '/v1/client/me/notification_preferences', method: 'PATCH', body: { preferences: { new_device: false } } });
  });
});
