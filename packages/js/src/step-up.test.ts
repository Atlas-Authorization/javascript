import { describe, expect, it, vi } from 'vitest';
import { FapiClient } from './fapi';
import { authenticatedWithin, sendStepUpEmailCode, sendStepUpPhoneCode, stepUp } from './step-up';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function clientWith(handler: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return handler();
  }) as unknown as typeof fetch;
  return { client: new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://fapi.example', fetchImpl, referral: false }), calls };
}

describe('step-up', () => {
  it('posts the credential and returns the fresh token and auth context', async () => {
    const body = { object: 'client', stepped_up: true, auth_time: 1_800_000_000, amr: ['pwd'], acr: 'urn:atlas:acr:step_up', jwt: 'eyJ', expires_in_seconds: 60 };
    const { client, calls } = clientWith(() => json(200, body));
    const res = await stepUp(client, { strategy: 'password', password: 'hunter2' });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual(body);
    expect(calls[0]!.url).toBe('https://fapi.example/v1/client/me/step_up');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ strategy: 'password', password: 'hunter2' });
  });

  it('a wrong credential comes back as the server error, not a throw', async () => {
    const { client } = clientWith(() => json(401, { errors: [{ code: 'UNAUTHENTICATED', message: 'Step-up re-authentication failed.' }] }));
    const res = await stepUp(client, { strategy: 'totp', code: '000000' });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    expect(res.errors[0]!.code).toBe('UNAUTHENTICATED');
  });

  it('sends the email code to the step-up endpoint', async () => {
    const { client, calls } = clientWith(() => json(201, { object: 'step_up_email_code' }));
    await sendStepUpEmailCode(client);
    expect(calls[0]!.url).toBe('https://fapi.example/v1/client/me/step_up/email_code');
  });

  it('texts the phone code through the step-up endpoint', async () => {
    const { client, calls } = clientWith(() => json(201, { object: 'step_up_challenge' }));
    await sendStepUpPhoneCode(client);
    expect(calls[0]!.url).toBe('https://fapi.example/v1/client/me/step_up/phone_code');
  });

  it('authenticatedWithin compares auth_time with the window', () => {
    const now = 1_800_000_300_000;
    expect(authenticatedWithin({ auth_time: 1_800_000_000 }, 300, now)).toBe(true);
    expect(authenticatedWithin({ auth_time: 1_799_999_999 }, 300, now)).toBe(false);
    expect(authenticatedWithin({}, 300, now)).toBe(false);
    expect(authenticatedWithin({ auth_time: '1800000000' }, 300, now)).toBe(false);
  });
});

describe('withStepUp(policy, fn)', () => {
  const refusal = { errors: [{ code: 'STEP_UP_REQUIRED', message: 'x', meta: { action: 'policy', policy: 'wire_transfer', accepted_factors: ['passkey', 'totp'], max_age_seconds: 120 } }] };

  it('runs fn once when nothing is refused', async () => {
    const { withStepUp } = await import('./step-up');
    const { client } = clientWith(() => json(200, {}));
    const fn = vi.fn(async () => 'done');
    expect(await withStepUp('wire_transfer', fn, { client, prompt: () => null })).toBe('done');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('re-authenticates with the policy and re-runs fn after a refused fetch Response', async () => {
    const { withStepUp } = await import('./step-up');
    const body = { object: 'client', stepped_up: true, auth_time: 1, amr: ['otp', 'mfa', 'totp'], acr: 'urn:atlas:acr:step_up', jwt: 'j', expires_in_seconds: 60 };
    const { client, calls } = clientWith(() => json(200, body));
    let n = 0;
    const fn = vi.fn(async () => (n++ === 0 ? json(403, refusal) : json(200, { ok: true })));
    const prompt = vi.fn((p: { acceptedFactors: string[]; policy?: string | null }) => {
      expect(p.acceptedFactors).toEqual(['passkey', 'totp']);
      expect(p.policy).toBe('wire_transfer');
      return { strategy: 'totp' as const, code: '123456' };
    });
    const res = await withStepUp('wire_transfer', fn, { client, prompt });
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ strategy: 'totp', code: '123456', policy: 'wire_transfer' });
  });

  it('understands a thrown refusal, and rethrows any other error', async () => {
    const { withStepUp } = await import('./step-up');
    const body = { object: 'client', stepped_up: true, auth_time: 1, amr: ['pwd'], acr: 'urn:atlas:acr:step_up', jwt: 'j', expires_in_seconds: 60 };
    const { client } = clientWith(() => json(200, body));
    let n = 0;
    const fn = vi.fn(async () => {
      if (n++ === 0) throw Object.assign(new Error('refused'), { code: 'STEP_UP_REQUIRED', meta: refusal.errors[0]!.meta });
      return 'after';
    });
    expect(await withStepUp('wire_transfer', fn, { client, prompt: () => ({ strategy: 'password', password: 'pw' }) })).toBe('after');
    await expect(withStepUp('p', async () => { throw new Error('network'); }, { client, prompt: () => null })).rejects.toThrow('network');
  });

  it('polls a push step-up until the device answers', async () => {
    const { withStepUp } = await import('./step-up');
    const final = { object: 'client', stepped_up: true, auth_time: 1, amr: ['mfa', 'push'], acr: 'urn:atlas:acr:step_up', jwt: 'j', expires_in_seconds: 60 };
    const replies = [json(202, { object: 'step_up_challenge', strategy: 'push', status: 'pending' }), json(200, final)];
    const { client, calls } = clientWith(() => replies.shift()!);
    let n = 0;
    const fn = vi.fn(async () => (n++ === 0 ? json(403, refusal) : json(200, {})));
    await withStepUp('wire_transfer', fn, { client, prompt: () => ({ strategy: 'push' }), pollIntervalMs: 1 });
    expect(calls).toHaveLength(2);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
