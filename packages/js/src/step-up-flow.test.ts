import { describe, expect, it, vi } from 'vitest';
import { FapiClient } from './fapi';
import { createStepUp, heldStepUpFactors } from './step-up-flow';
import { StepUpCancelledError } from './step-up';

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

const refusal = () => json(403, { errors: [{ code: 'STEP_UP_REQUIRED', message: 'Re-authenticate.', meta: { action: 'mfa_enroll', accepted_factors: ['password', 'passkey', 'totp', 'backup_code', 'email_code'], max_age_seconds: 300 } }] });
const held = (o: { password: boolean; totp: boolean; codes: number; passkeys: number }) => ({
  '/v1/client/me': [json(200, { has_password: o.password })],
  '/v1/client/me/mfa': [json(200, { data: o.totp ? [{ type: 'totp', verified: true }] : [], backup_codes_remaining: o.codes })],
  '/v1/client/me/passkeys': [json(200, { data: Array.from({ length: o.passkeys }, (_, i) => ({ id: `pk${i}` })) })],
});

describe('heldStepUpFactors', () => {
  it('lists what the account holds, email_code always', async () => {
    const { client } = clientWith(held({ password: false, totp: true, codes: 0, passkeys: 1 }));
    expect(await heldStepUpFactors(client)).toEqual(['passkey', 'totp', 'email_code']);
  });
  it('offers phone_code with a verified phone number or a verified SMS factor', async () => {
    const withPhone = clientWith({
      '/v1/client/me': [json(200, { has_password: false, phone_numbers: [{ verified: true }] })],
      '/v1/client/me/mfa': [json(200, { data: [] })],
      '/v1/client/me/passkeys': [json(200, { data: [] })],
    });
    expect(await heldStepUpFactors(withPhone.client)).toEqual(['email_code', 'phone_code']);
    const withSms = clientWith({
      '/v1/client/me': [json(200, { has_password: false, phone_numbers: [{ verified: false }] })],
      '/v1/client/me/mfa': [json(200, { data: [{ type: 'sms', verified: true }] })],
      '/v1/client/me/passkeys': [json(200, { data: [] })],
    });
    expect(await heldStepUpFactors(withSms.client)).toEqual(['email_code', 'phone_code']);
  });
  it('is null when the account cannot be read', async () => {
    const { client } = clientWith({});
    expect(await heldStepUpFactors(client)).toBeNull();
  });
});

describe('createStepUp', () => {
  it('offers only held factors, re-verifies on the bearer route and retries the call once', async () => {
    const { client: c2, calls: calls2 } = clientWith({
      ...held({ password: false, totp: true, codes: 8, passkeys: 0 }),
      '/x': [refusal(), json(201, { ok: true })],
      '/v1/client/me/step_up': [json(200, { object: 'client', stepped_up: true, auth_time: 1, amr: ['otp'], acr: 'a', jwt: 'j', expires_in_seconds: 60 })],
    });
    const choose = vi.fn(() => ({ strategy: 'totp' as const, code: '123456' }));
    const { withStepUp } = createStepUp({ client: c2, choose });
    const res = await withStepUp(() => c2.post('/x', {}));
    expect(res.ok).toBe(true);
    expect(choose).toHaveBeenCalledWith(expect.objectContaining({ action: 'mfa_enroll', factors: ['totp', 'backup_code', 'email_code'], maxAgeSeconds: 300 }));
    expect(calls2.filter((c) => c.path === '/x')).toHaveLength(2);
    expect(calls2.find((c) => c.path === '/v1/client/me/step_up')!.body).toEqual({ strategy: 'totp', code: '123456' });
  });

  it('runs the passkey provider, re-asks after a cancelled prompt, and sends the assertion', async () => {
    const { client, calls } = clientWith({
      ...held({ password: true, totp: false, codes: 0, passkeys: 1 }),
      '/x': [refusal(), json(200, {})],
      '/v1/client/me/step_up/passkey': [json(201, { object: 'step_up_challenge', challenge: 'chal' }), json(201, { object: 'step_up_challenge', challenge: 'chal2' })],
      '/v1/client/me/step_up': [json(200, { object: 'client', stepped_up: true, auth_time: 1, amr: ['webauthn'], acr: 'a', jwt: 'j', expires_in_seconds: 60 })],
    });
    const passkeyAssertion = vi
      .fn()
      .mockRejectedValueOnce(new Error('user cancelled'))
      .mockImplementation(async (c: Record<string, unknown>) => ({ challenge: c.challenge as string, credential_id: 'cid', authenticator_data: 'ad', client_data_json: 'cdj', signature: 'sig' }));
    const errors: Array<string | undefined> = [];
    const choose = vi.fn((r: { error: { reason?: string } | null }) => {
      errors.push(r.error?.reason);
      return { strategy: 'passkey' as const };
    });
    const res = await createStepUp({ client, choose, passkeyAssertion }).withStepUp(() => client.post('/x', {}));
    expect(res.ok).toBe(true);
    expect(errors).toEqual([undefined, 'passkey_cancelled']);
    expect(calls.find((c) => c.path === '/v1/client/me/step_up')!.body).toEqual({ strategy: 'passkey', challenge: 'chal2', credential_id: 'cid', authenticator_data: 'ad', client_data_json: 'cdj', signature: 'sig' });
  });

  it('falls back to what the refusal accepts when the account cannot be read, and cancel throws', async () => {
    const { client } = clientWith({ '/x': [refusal()] });
    const choose = vi.fn(() => null);
    await expect(createStepUp({ client, choose }).withStepUp(() => client.post('/x', {}))).rejects.toBeInstanceOf(StepUpCancelledError);
    expect(choose).toHaveBeenCalledWith(expect.objectContaining({ factors: ['password', 'passkey', 'totp', 'backup_code', 'email_code'] }));
  });

  it('does not touch a call that is not a step-up refusal', async () => {
    const { client, calls } = clientWith({ '/x': [json(400, { errors: [{ code: 'VALIDATION', message: 'no' }] })] });
    const choose = vi.fn();
    const res = await createStepUp({ client, choose }).withStepUp(() => client.post('/x', {}));
    expect(res.ok).toBe(false);
    expect(choose).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });
});

describe('stepUpFactorInfo', () => {
  it('describes every known factor', async () => {
    const { STEP_UP_FACTORS, stepUpFactorInfo } = await import('./step-up-flow');
    expect(STEP_UP_FACTORS).toHaveLength(9);
    for (const f of STEP_UP_FACTORS) expect(stepUpFactorInfo(f)).toMatchObject({ factor: f, label: expect.any(String) });
    expect(stepUpFactorInfo('password')).toMatchObject({ needsInput: true, inputKind: 'password' });
    expect(stepUpFactorInfo('passkey')).toMatchObject({ needsInput: false, inputKind: 'webauthn' });
    expect(stepUpFactorInfo('duo').inputKind).toBe('redirect');
    expect(stepUpFactorInfo('push').inputKind).toBe('push');
  });

  it('falls back for a factor it does not know', async () => {
    const { stepUpFactorInfo } = await import('./step-up-flow');
    expect(stepUpFactorInfo('smart_card')).toEqual({ factor: 'smart_card', label: 'Smart card', needsInput: true, inputKind: 'otp' });
    expect(stepUpFactorInfo('constructor').label).toBe('Constructor');
  });
});
