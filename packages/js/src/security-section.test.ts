import { describe, expect, it, vi } from 'vitest';
import { FapiClient } from './fapi';
import { createSecuritySection } from './security-section';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function clientWith(routes: Record<string, Response[]>) {
  const calls: { path: string; method: string; body: any }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input).replace('https://fapi.example', '');
    calls.push({ path, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
    return routes[path]?.shift() ?? json(404, { errors: [{ code: 'NOT_FOUND', message: 'no route' }] });
  }) as unknown as typeof fetch;
  return { client: new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://fapi.example', fetchImpl, referral: false, exposeSession: false }), calls };
}
const settle = () => new Promise((r) => setTimeout(r, 0));
const refusal = () => json(403, { errors: [{ code: 'STEP_UP_REQUIRED', message: 'Re-authenticate.', meta: { action: 'mfa_enroll', accepted_factors: ['totp', 'email_code'], max_age_seconds: 300 } }] });
const session = (id: string, current = false) => ({ id, status: 'active', current, last_active_at: 1, expire_at: 2, created_at: 0, device_label: `Phone ${id}`, location: 'Berlin' });

describe('createSecuritySection', () => {
  it('lists sessions and signs one out', async () => {
    const { client, calls } = clientWith({
      '/v1/client/sessions': [json(200, { data: [session('s1', true), session('s2')] }), json(200, { data: [session('s1', true)] })],
      '/v1/client/sessions/s2/revoke': [json(200, {})],
    });
    const section = createSecuritySection({ client, kind: 'sessions' });
    await settle();
    expect(section.getView().items).toEqual([
      expect.objectContaining({ id: 's1', label: 'Phone s1', detail: 'Berlin', current: true }),
      expect.objectContaining({ id: 's2', current: false }),
    ]);
    await section.remove('s2');
    expect(calls.some((c) => c.path === '/v1/client/sessions/s2/revoke')).toBe(true);
    expect(section.getView().items).toHaveLength(1);
  });

  it('enrolls an authenticator app, re-authenticating inside when the server asks, and shows recovery codes once', async () => {
    const { client, calls } = clientWith({
      '/v1/client/me/mfa': [json(200, { data: [], backup_codes_remaining: 0 }), json(200, { data: [{ id: 'f1', type: 'totp', verified: true, created_at: 1 }], backup_codes_remaining: 10 }), json(200, { data: [], backup_codes_remaining: 10 })],
      '/v1/client/me/mfa/totp': [json(201, { id: 'f1', secret: 'SEC', uri: 'otpauth://x', qr_svg: '<svg/>' })],
      '/v1/client/me/mfa/totp/f1/verify': [refusal(), json(200, { id: 'f1', type: 'totp', verified: true, created_at: 1, backup_codes: ['aaa', 'bbb'] })],
      '/v1/client/me': [json(200, { has_password: false })],
      '/v1/client/me/passkeys': [json(200, { data: [] })],
      '/v1/client/me/step_up': [json(200, { object: 'client', stepped_up: true, auth_time: 1, amr: ['otp'], acr: 'a', jwt: 'j', expires_in_seconds: 60 })],
    });
    const choose = vi.fn(() => ({ strategy: 'email_code' as const, code: '999999' }));
    const section = createSecuritySection({ client, kind: 'mfa', choose });
    await settle();
    await section.startTotp();
    expect(section.getView()).toMatchObject({ step: 'totp_enroll', enrollment: { secret: 'SEC', requiredCodes: 1 }, fields: [{ name: 'code' }] });
    await section.submit({ code: '123456' });
    expect(choose).toHaveBeenCalledOnce();
    expect(calls.filter((c) => c.path.endsWith('/verify'))).toHaveLength(2);
    expect(section.getView()).toMatchObject({ step: 'recovery_codes', recoveryCodes: ['aaa', 'bbb'], error: null });
    section.acknowledgeCodes();
    await settle();
    expect(section.getView()).toMatchObject({ step: 'list', recoveryCodes: null });
  });

  it('reports stepUpRequired when no choose callback is given', async () => {
    const { client } = clientWith({
      '/v1/client/me/mfa': [json(200, { data: [], backup_codes_remaining: 0 })],
      '/v1/client/me/mfa/totp': [refusal()],
    });
    const section = createSecuritySection({ client, kind: 'mfa' });
    await settle();
    await section.startTotp();
    expect(section.getView()).toMatchObject({ step: 'list', stepUpRequired: true });
  });

  it('opens on change_password or set_password by whether the account has one', async () => {
    const a = clientWith({ '/v1/client/me': [json(200, { has_password: true })] });
    const withPw = createSecuritySection({ client: a.client, kind: 'password' });
    await settle();
    expect(withPw.getView()).toMatchObject({ step: 'change_password', hasPassword: true, fields: [{ name: 'current_password' }, { name: 'new_password' }] });
    const b = clientWith({ '/v1/client/me': [json(200, { has_password: false })] });
    const without = createSecuritySection({ client: b.client, kind: 'password' });
    await settle();
    expect(without.getView()).toMatchObject({ step: 'set_password', fields: [{ name: 'new_password' }] });
  });
});
