import { describe, expect, it, vi } from 'vitest';
import { FapiClient } from './fapi';
import {
  enrollYubikey,
  finishDuoEnrollment,
  getResetSecurityQuestions,
  getSecurityQuestions,
  looksLikeYubicoOtp,
  pollDuo,
  prepareDuo,
  removeSecurityQuestions,
  resyncHotp,
  setSecurityQuestions,
  signInWithSmartCard,
  startDuoEnrollment,
  startHotp,
  verifyHotp,
} from './mfa-factors';

function scripted(reply: unknown = { object: 'x' }, status = 200) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', path: new URL(String(input)).pathname, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify(reply), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { client: new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://f.example', fetchImpl, referral: false }), calls };
}

describe('additional factor helpers', () => {
  it('calls the HOTP, YubiKey and Duo enrolment routes', async () => {
    const { client, calls } = scripted();
    await startHotp(client);
    await verifyHotp(client, 'mfa_1', '123456');
    await resyncHotp(client, 'mfa_1', ['111111', '222222']);
    await enrollYubikey(client, 'c'.repeat(44));
    await startDuoEnrollment(client, { returnUrl: 'https://app.example.com/done' });
    await finishDuoEnrollment(client, 'mfa_2');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /v1/client/me/mfa/hotp',
      'POST /v1/client/me/mfa/hotp/mfa_1/verify',
      'POST /v1/client/me/mfa/hotp/mfa_1/resync',
      'POST /v1/client/me/mfa/yubikey',
      'POST /v1/client/me/mfa/duo',
      'POST /v1/client/me/mfa/duo/mfa_2/verify',
    ]);
    expect(calls[1]!.body).toEqual({ code: '123456' });
    expect(calls[2]!.body).toEqual({ codes: ['111111', '222222'] });
    expect(calls[4]!.body).toEqual({ return_url: 'https://app.example.com/done' });
  });

  it('prepares and polls Duo for a sign-in attempt', async () => {
    const { client, calls } = scripted({ authorization_url: 'https://api-1.duosecurity.com/oauth/v1/authorize?x=1' });
    const { prompt } = await prepareDuo(client, 'sia_1', { returnUrl: 'https://app.example.com/' });
    expect(prompt).toEqual({ authorizationUrl: 'https://api-1.duosecurity.com/oauth/v1/authorize?x=1' });
    await pollDuo(client, 'sia_1');
    expect(calls[0]).toMatchObject({ path: '/v1/client/sign_ins/sia_1/prepare_second_factor', body: { strategy: 'duo', return_url: 'https://app.example.com/' } });
    expect(calls[1]).toMatchObject({ path: '/v1/client/sign_ins/sia_1/attempt_second_factor', body: { strategy: 'duo' } });
  });

  it('reads and writes security questions with camelCase results', async () => {
    const wire = { enabled: true, required: 3, available_questions: ['a?', 'b?', 'c?', 'd?'], answered_questions: ['a?'] };
    const { client, calls } = scripted(wire);
    expect(await getSecurityQuestions(client)).toEqual({ enabled: true, required: 3, availableQuestions: wire.available_questions, answeredQuestions: ['a?'] });
    const set = await setSecurityQuestions(client, [{ question: 'a?', answer: 'x' }]);
    expect(set.questions?.required).toBe(3);
    await removeSecurityQuestions(client);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT', 'DELETE']);
    expect(calls[1]!.body).toEqual({ answers: [{ question: 'a?', answer: 'x' }] });
    expect(await getResetSecurityQuestions(scripted({ required: true, questions: ['a?'] }).client, 'sia_9')).toEqual({ required: true, questions: ['a?'] });
  });

  it('signs in with a smart card and recognises Yubico OTPs', async () => {
    const { client, calls } = scripted({ status: 'complete' });
    expect((await signInWithSmartCard(client)).data).toMatchObject({ status: 'complete' });
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/v1/client/sign_ins/smart_card' });
    expect(looksLikeYubicoOtp(`cccccccccccc${'b'.repeat(32)}`)).toBe(true);
    expect(looksLikeYubicoOtp('123456')).toBe(false);
  });
});
