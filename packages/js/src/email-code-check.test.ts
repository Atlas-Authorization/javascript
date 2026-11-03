import { describe, expect, it, vi } from 'vitest';
import { FapiClient } from './fapi';
import { checkEmailCode, emailCodeCheckRequest, emailCodeTargetForAttempt } from './email-code-check';

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

describe('email code check', () => {
  it('maps every target to its check endpoint', () => {
    expect(emailCodeCheckRequest({ kind: 'sign_in_first_factor', attemptId: 'sia_1' }, '123456')).toEqual({
      path: '/v1/client/sign_ins/sia_1/check_first_factor',
      body: { strategy: 'email_code', code: '123456' },
    });
    expect(emailCodeCheckRequest({ kind: 'sign_in_second_factor', attemptId: 'sia_1' }, '1').path).toBe('/v1/client/sign_ins/sia_1/check_second_factor');
    expect(emailCodeCheckRequest({ kind: 'sign_up_verification', attemptId: 'sua_1' }, '1').path).toBe('/v1/client/sign_ups/sua_1/check_verification');
    expect(emailCodeCheckRequest({ kind: 'step_up' }, '1').path).toBe('/v1/client/me/step_up/check');
    expect(emailCodeCheckRequest({ kind: 'email_address', emailAddressId: 'idn_1' }, '9')).toEqual({
      path: '/v1/client/me/email_addresses/idn_1/check_verification',
      body: { code: '9' },
    });
  });

  it('posts the code and returns the check', async () => {
    const check = { object: 'email_code_check', valid: true, expires_at: '2026-10-22T10:00:00.000Z', attempts_remaining: 3 };
    const { client, calls } = clientWith(() => json(200, check));
    const res = await checkEmailCode(client, { kind: 'step_up' }, '424242');
    expect(res.ok).toBe(true);
    expect(res.data).toEqual(check);
    expect(calls[0]!.url).toBe('https://fapi.example/v1/client/me/step_up/check');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ strategy: 'email_code', code: '424242' });
  });

  it('surfaces a wrong code as the server error', async () => {
    const { client } = clientWith(() => json(400, { errors: [{ code: 'VERIFICATION_FAILED', message: 'nope' }] }));
    const res = await checkEmailCode(client, { kind: 'sign_in_first_factor', attemptId: 'sia_1' }, '000000');
    expect(res.ok).toBe(false);
    expect(res.errors[0]!.code).toBe('VERIFICATION_FAILED');
  });

  it('derives the target from the flow step', () => {
    expect(emailCodeTargetForAttempt({ id: 'sia_1', status: 'needs_first_factor' })).toEqual({ kind: 'sign_in_first_factor', attemptId: 'sia_1' });
    expect(emailCodeTargetForAttempt({ id: 'sia_1', status: 'needs_second_factor' })).toEqual({ kind: 'sign_in_second_factor', attemptId: 'sia_1' });
    expect(emailCodeTargetForAttempt({ id: 'sua_1', status: 'needs_email_verification' })).toEqual({ kind: 'sign_up_verification', attemptId: 'sua_1' });
    expect(emailCodeTargetForAttempt({ id: 'sia_1', status: 'complete' })).toBeNull();
    expect(emailCodeTargetForAttempt(null)).toBeNull();
  });
});
