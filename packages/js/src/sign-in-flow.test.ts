import { describe, expect, it, vi } from 'vitest';
import { FapiClient } from './fapi';
import { createSignInFlow, createSignUpFlow } from './sign-in-flow';
import { requireStepUp, retryWithStepUp, stepUpRequirement, StepUpCancelledError } from './step-up';
import { reasonMessage } from './errors';
import { startPasswordReset } from './password-reset';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A client whose fetch answers from `routes` (path -> queue of responses) and records the calls. */
function clientWith(routes: Record<string, Response[]>) {
  const calls: { path: string; body: any }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input).replace('https://fapi.example', '');
    calls.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const next = routes[path]?.shift();
    return next ?? json(404, { errors: [{ code: 'NOT_FOUND', message: 'no route' }] });
  }) as unknown as typeof fetch;
  return { client: new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://fapi.example', fetchImpl, referral: false, exposeSession: false }), calls };
}

describe('createSignInFlow', () => {
  it('walks identifier -> captcha (with its reason) -> first factor -> second factor -> complete', async () => {
    const appearance = { captchaFlows: { signIn: { enabled: true, provider: 'atlas', widget: 'managed' } } };
    const { client, calls } = clientWith({
      '/v1/client/sign_ins': [
        json(201, { object: 'sign_in_attempt', id: null, status: 'needs_captcha', identifier: 'a@b.co', reason: 'captcha_wrong_flow', supported_first_factors: ['password'] }),
        json(201, { object: 'sign_in_attempt', id: 'sia_1', status: 'needs_first_factor', supported_first_factors: ['password', 'email_code'] }),
      ],
      '/v1/appearance': [json(200, appearance)],
      '/v1/client/sign_ins/sia_1/attempt_first_factor': [json(200, { id: 'sia_1', status: 'needs_second_factor' })],
      '/v1/client/sign_ins/sia_1/attempt_second_factor': [json(200, { id: 'sia_1', status: 'complete', created_session_id: 'sess_1', ticket: 't' })],
      '/v1/client/tickets/exchange': [json(200, {})],
    });
    const flow = createSignInFlow({ client });

    let snap = await flow.submitIdentifier('a@b.co');
    expect(snap.step).toMatchObject({ type: 'needs_captcha', flow: 'signIn', captcha: { provider: 'atlas' } });
    expect(snap.reason).toBe('captcha_wrong_flow');

    snap = await flow.submitCaptcha('atlas1.tok');
    expect(calls.find((c) => c.path === '/v1/client/sign_ins' && c.body.captcha_token)?.body).toMatchObject({ identifier: 'a@b.co', captcha_token: 'atlas1.tok' });
    expect(snap.step).toEqual({ type: 'needs_first_factor', factors: ['password', 'email_code'] });

    snap = await flow.submitPassword('pw');
    expect(snap.step.type).toBe('needs_second_factor');
    snap = await flow.submitSecondFactor('123456');
    expect(snap.step).toEqual({ type: 'complete', sessionId: 'sess_1' });
    expect(calls.at(-1)!.path).toBe('/v1/client/tickets/exchange');
  });

  it('offers a passkey second factor and completes with the assertion', async () => {
    vi.stubGlobal('PublicKeyCredential', class {});
    try {
      const { client, calls } = clientWith({
        '/v1/client/sign_ins': [json(201, { id: 'sia_p', status: 'needs_first_factor', supported_first_factors: ['password'] })],
        '/v1/client/sign_ins/sia_p/attempt_first_factor': [json(200, { id: 'sia_p', status: 'needs_second_factor' })],
        '/v1/client/sign_ins/sia_p/second_factors': [json(200, { object: 'second_factors', factors: ['totp', 'passkey'] })],
        '/v1/client/sign_ins/sia_p/prepare_second_factor': [json(201, { object: 'second_factor_challenge', challenge: 'Y2hhbA', rpId: 'example.com', allowCredentials: [], userVerification: 'required' })],
        '/v1/client/sign_ins/sia_p/attempt_second_factor': [json(200, { id: 'sia_p', status: 'complete', created_session_id: 'sess_p', ticket: 't' })],
        '/v1/client/tickets/exchange': [json(200, {})],
      });
      const flow = createSignInFlow({ client });
      await flow.submitIdentifier('a@b.co');
      const snap = await flow.submitPassword('pw');
      expect(snap.step).toMatchObject({ type: 'needs_second_factor' });
      expect((snap.step as { factors: string[] }).factors).toContain('passkey');

      const bytes = (n: number) => new Uint8Array([n]).buffer;
      const host = { credentials: { create: vi.fn(), get: vi.fn(async () => ({ rawId: bytes(1), response: { authenticatorData: bytes(2), clientDataJSON: bytes(3), signature: bytes(4) } })) } };
      const done = await flow.submitPasskeySecondFactor({ host: host as never });
      expect(done.step).toEqual({ type: 'complete', sessionId: 'sess_p' });
      expect(calls.find((c) => c.path.endsWith('/prepare_second_factor'))!.body).toEqual({ strategy: 'passkey' });
      expect(calls.find((c) => c.path.endsWith('/attempt_second_factor'))!.body).toMatchObject({ strategy: 'passkey', challenge: 'Y2hhbA', credential_id: 'AQ' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a cancelled passkey prompt keeps the step with reason passkey_cancelled', async () => {
    const { client } = clientWith({
      '/v1/client/sign_ins': [json(201, { id: 'sia_c', status: 'needs_second_factor' })],
      '/v1/client/sign_ins/sia_c/prepare_second_factor': [json(201, { object: 'second_factor_challenge', challenge: 'Y2hhbA', rpId: 'example.com' })],
    });
    const flow = createSignInFlow({ client });
    await flow.submitIdentifier('a@b.co');
    const host = { credentials: { create: vi.fn(), get: vi.fn(async () => null) } };
    const snap = await flow.submitPasskeySecondFactor({ host: host as never });
    expect(snap.step.type).toBe('needs_second_factor');
    expect(snap.reason).toBe('passkey_cancelled');
  });

  it('a wrong password keeps the step and exposes the stable reason', async () => {
    const { client } = clientWith({
      '/v1/client/sign_ins': [json(201, { id: 'sia_2', status: 'needs_first_factor', supported_first_factors: ['password'] })],
      '/v1/client/sign_ins/sia_2/attempt_first_factor': [json(401, { errors: [{ code: 'VERIFICATION_FAILED', reason: 'form_password_incorrect', message: 'Wrong.' }] })],
    });
    const flow = createSignInFlow({ client });
    await flow.submitIdentifier('a@b.co');
    const snap = await flow.submitPassword('nope');
    expect(snap.step.type).toBe('needs_first_factor');
    expect(snap.reason).toBe('form_password_incorrect');
  });

  it('social sign-in becomes a redirect step', async () => {
    const { client } = clientWith({ '/v1/client/sign_ins/oauth': [json(201, { authorization_url: 'https://accounts.google.example/auth' })] });
    const snap = await createSignInFlow({ client }).startOAuth('google', 'https://app.example/done');
    expect(snap.step).toEqual({ type: 'redirect', url: 'https://accounts.google.example/auth' });
  });
});

describe('createSignInFlow: second-factor enrolment and required actions', () => {
  const appearance = { account: { mfa: { totp: true, sms: true, totp_codes: 2 } } };

  it('enrols an authenticator app, shows the recovery codes once, then completes', async () => {
    const { client, calls } = clientWith({
      '/v1/client/sign_ins': [json(201, { object: 'sign_in_attempt', id: 'sia_m', status: 'needs_mfa_enrollment' })],
      '/v1/appearance': [json(200, appearance)],
      '/v1/client/sign_ins/sia_m/prepare_mfa_enrollment': [json(200, { factor_id: 'fac_1', secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/x' })],
      '/v1/client/sign_ins/sia_m/attempt_mfa_enrollment': [json(200, { id: 'sia_m', status: 'complete', created_session_id: 'sess_m', ticket: 't', backup_codes: ['aaaa-bbbb', 'cccc-dddd'] })],
      '/v1/client/tickets/exchange': [json(200, {})],
    });
    const flow = createSignInFlow({ client });
    let snap = await flow.submitIdentifier('a@b.co');
    expect(snap.step).toMatchObject({ type: 'needs_mfa_enrollment', methods: ['totp', 'phone_code'], totpCodes: 2, enrollment: null });

    snap = await flow.startTotpEnrollment();
    expect(calls.find((c) => c.path.endsWith('prepare_mfa_enrollment'))!.body).toEqual({ strategy: 'totp' });
    expect(snap.step).toMatchObject({ type: 'needs_mfa_enrollment', enrollment: { factorId: 'fac_1', secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/x' } });

    snap = await flow.submitEnrollmentCode('111111', '222222');
    expect(calls.find((c) => c.path.endsWith('attempt_mfa_enrollment'))!.body).toEqual({ factor_id: 'fac_1', codes: ['111111', '222222'] });
    expect(snap.step).toEqual({ type: 'show_recovery_codes', codes: ['aaaa-bbbb', 'cccc-dddd'] });

    snap = await flow.acknowledgeRecoveryCodes();
    expect(snap.step).toEqual({ type: 'complete', sessionId: 'sess_m' });
  });

  it('enrols texted codes: phone, then the code', async () => {
    const { client, calls } = clientWith({
      '/v1/client/sign_ins': [json(201, { object: 'sign_in_attempt', id: 'sia_p', status: 'needs_mfa_enrollment' })],
      '/v1/appearance': [json(200, appearance)],
      '/v1/client/sign_ins/sia_p/prepare_mfa_enrollment': [json(200, { factor_id: 'fac_2', phone: '+1***99' })],
      '/v1/client/sign_ins/sia_p/attempt_mfa_enrollment': [json(200, { id: 'sia_p', status: 'complete', created_session_id: 's', ticket: 't' })],
      '/v1/client/tickets/exchange': [json(200, {})],
    });
    const flow = createSignInFlow({ client });
    await flow.submitIdentifier('a@b.co');
    let snap = await flow.sendEnrollmentPhone(' +15555550199 ');
    expect(calls.find((c) => c.path.endsWith('prepare_mfa_enrollment'))!.body).toEqual({ strategy: 'phone_code', phone: '+15555550199' });
    expect(snap.step).toMatchObject({ type: 'needs_mfa_enrollment', enrollment: { phone: '+1***99' } });
    snap = await flow.submitEnrollmentCode('424242');
    expect(calls.find((c) => c.path.endsWith('attempt_mfa_enrollment'))!.body).toEqual({ factor_id: 'fac_2', code: '424242' });
    expect(snap.step).toEqual({ type: 'complete', sessionId: 's' });
  });

  it('a required action is typed by kind and submitted with the held token', async () => {
    const { client, calls } = clientWith({
      '/v1/client/sign_ins': [
        json(201, { object: 'sign_in_attempt', id: 'sia_r', status: 'needs_required_action', required_action_token: 'rat', pending_required_actions: [{ id: 'ra1', action: 'update_password', url: null, reason: null }, { id: 'ra2', action: 'verify_email', url: null, reason: null }] }),
      ],
      '/v1/client/sign_ins/sia_r/required_actions': [
        json(200, { id: 'sia_r', status: 'needs_required_action', pending_required_actions: [{ id: 'ra2', action: 'verify_email', url: null, reason: null }] }),
        json(200, { id: 'sia_r', status: 'complete', created_session_id: 's2', ticket: 't' }),
      ],
      '/v1/client/tickets/exchange': [json(200, {})],
    });
    const flow = createSignInFlow({ client });
    let snap = await flow.submitIdentifier('a@b.co');
    expect(snap.step).toEqual({ type: 'needs_required_action', action: { kind: 'update_password' }, remaining: 1 });
    snap = await flow.updatePassword('new password 9!');
    expect(calls.find((c) => c.path.endsWith('required_actions'))!.body).toMatchObject({ action: 'update_password', password: 'new password 9!', required_action_token: 'rat' });
    expect(snap.step).toEqual({ type: 'needs_required_action', action: { kind: 'verify_email' }, remaining: 0 });
    snap = await flow.submitEmailVerificationCode('123456');
    expect(snap.step).toEqual({ type: 'complete', sessionId: 's2' });
  });

  it('an action kind it does not know still hands over as needs_other', async () => {
    const { client } = clientWith({
      '/v1/client/sign_ins': [json(201, { object: 'sign_in_attempt', id: 'sia_u', status: 'needs_required_action', pending_required_actions: [{ id: 'x', action: 'brand_new', url: null, reason: null }] })],
    });
    const snap = await createSignInFlow({ client }).submitIdentifier('a@b.co');
    expect(snap.step).toEqual({ type: 'needs_other', status: 'needs_required_action' });
  });
});

describe('createSignUpFlow', () => {
  it('a CAPTCHA_REQUIRED refusal becomes the captcha step, and the token resubmits the same details', async () => {
    const { client, calls } = clientWith({
      '/v1/client/sign_ups': [
        json(400, { errors: [{ code: 'CAPTCHA_REQUIRED', reason: 'captcha_required', message: 'x' }] }),
        json(201, { id: 'sua_1', object: 'sign_up_attempt', status: 'needs_email_verification' }),
      ],
      '/v1/appearance': [json(200, { captchaFlows: { signUp: { enabled: true, provider: 'turnstile', siteKey: 'k' } } })],
    });
    const flow = createSignUpFlow({ client });
    let snap = await flow.submit({ email: 'a@b.co', password: 'correct horse 9!' });
    expect(snap.step).toMatchObject({ type: 'needs_captcha', flow: 'signUp' });
    snap = await flow.submitCaptcha('tok');
    expect(snap.step).toEqual({ type: 'needs_email_verification' });
    expect(calls.filter((c) => c.path === '/v1/client/sign_ups')[1]!.body).toMatchObject({ email: 'a@b.co', captcha_token: 'tok' });
  });
});

describe('step-up helpers', () => {
  const refused = { code: 'STEP_UP_REQUIRED', message: 'x', meta: { action: 'api_key_create', accepted_factors: ['password', 'totp'], max_age_seconds: 600 } };

  it('reads the requirement off a refusal alone', () => {
    expect(stepUpRequirement([refused])).toEqual({ action: 'api_key_create', acceptedFactors: ['password', 'totp'], maxAgeSeconds: 600 });
    expect(stepUpRequirement([{ code: 'FORBIDDEN', message: 'x' }])).toBeNull();
  });

  it('requireStepUp asks again after a wrong credential, then resolves', async () => {
    const ok = { object: 'client', stepped_up: true, jwt: 'j' };
    const { client } = clientWith({
      '/v1/client/me/step_up': [json(401, { errors: [{ code: 'UNAUTHENTICATED', message: 'bad' }] }), json(200, ok)],
    });
    const seen: unknown[] = [];
    const result = await requireStepUp('api_key_create', {
      client,
      requirement: stepUpRequirement([refused])!,
      prompt: (r) => (seen.push(r.error?.code ?? null), { strategy: 'password', password: 'pw' }),
    });
    expect(result).toEqual(ok);
    expect(seen).toEqual([null, 'UNAUTHENTICATED']);
  });

  it('a cancelled prompt rejects; retryWithStepUp reruns the call after success', async () => {
    const { client } = clientWith({ '/v1/client/me/step_up': [json(200, { stepped_up: true })] });
    await expect(requireStepUp('x', { client, prompt: () => null })).rejects.toBeInstanceOf(StepUpCancelledError);
    let n = 0;
    const call = async () => (n++ === 0 ? { ok: false, status: 403, data: null, errors: [refused] } : { ok: true, status: 200, data: { done: true }, errors: [] });
    const res = await retryWithStepUp(call, { client, prompt: () => ({ strategy: 'password', password: 'pw' }) });
    expect(res.data).toEqual({ done: true });
  });
});

describe('reasonMessage', () => {
  it('uses the catalog, then the fallback', () => {
    expect(reasonMessage('captcha_wrong_flow', { 'error.captcha_wrong_flow': 'Otro paso.' })).toBe('Otro paso.');
    expect(reasonMessage('unknown_reason', {}, 'Server text')).toBe('Server text');
  });
});

describe('headless captcha solver', () => {
  it('sign-in solves the captcha itself and resends the identifier once', async () => {
    const appearance = { captchaFlows: { signIn: { enabled: true, provider: 'atlas', challengeUrl: 'https://fapi.example/c' } } };
    const { client, calls } = clientWith({
      '/v1/client/sign_ins': [
        json(201, { id: null, status: 'needs_captcha', identifier: 'a@b.co', supported_first_factors: ['password'] }),
        json(201, { id: 'sia_1', status: 'needs_first_factor', supported_first_factors: ['password'] }),
      ],
      '/v1/appearance': [json(200, appearance)],
    });
    const solver = vi.fn(async () => 'atlas1.solved');
    const flow = createSignInFlow({ client, captchaSolver: solver });
    const snap = await flow.submitIdentifier('a@b.co');
    expect(solver).toHaveBeenCalledWith(expect.objectContaining({ provider: 'atlas' }), expect.objectContaining({ flow: 'signIn' }));
    expect(calls.filter((c) => c.path === '/v1/client/sign_ins')[1]!.body).toMatchObject({ identifier: 'a@b.co', captcha_token: 'atlas1.solved' });
    expect(snap.step.type).toBe('needs_first_factor');
  });

  it('does not loop when the solved token is refused, and stops at the step when the solver gives nothing', async () => {
    const needs = () => json(201, { id: null, status: 'needs_captcha', identifier: 'a@b.co', supported_first_factors: ['password'] });
    const appearance = { captchaFlows: { signIn: { enabled: true, provider: 'atlas' } } };
    const refused = clientWith({ '/v1/client/sign_ins': [needs(), needs(), needs()], '/v1/appearance': [json(200, appearance)] });
    const solver = vi.fn(async () => 'atlas1.bad');
    expect((await createSignInFlow({ client: refused.client, captchaSolver: solver }).submitIdentifier('a@b.co')).step.type).toBe('needs_captcha');
    expect(solver).toHaveBeenCalledTimes(1);
    const none = clientWith({ '/v1/client/sign_ins': [needs()], '/v1/appearance': [json(200, appearance)] });
    expect((await createSignInFlow({ client: none.client, captchaSolver: async () => null }).submitIdentifier('a@b.co')).step.type).toBe('needs_captcha');
  });

  it('sign-up solves a CAPTCHA_REQUIRED refusal and resubmits the same details', async () => {
    const { client, calls } = clientWith({
      '/v1/client/sign_ups': [
        json(400, { errors: [{ code: 'CAPTCHA_REQUIRED', reason: 'captcha_required', message: 'x' }] }),
        json(201, { id: 'sua_1', status: 'needs_email_verification' }),
      ],
      '/v1/appearance': [json(200, { captchaFlows: { signUp: { enabled: true, provider: 'atlas' } } })],
    });
    const flow = createSignUpFlow({ client, captchaSolver: async () => 'atlas1.t' });
    await flow.submit({ email: 'a@b.co', password: 'pw-123456' });
    expect(calls.filter((c) => c.path === '/v1/client/sign_ups')[1]!.body).toMatchObject({ email: 'a@b.co', captcha_token: 'atlas1.t' });
  });

  it('password reset solves a captcha refusal with the installed solver', async () => {
    const { client, calls } = clientWith({
      '/v1/client/password_resets': [
        json(400, { errors: [{ code: 'CAPTCHA_REQUIRED', message: 'x' }] }),
        json(201, { id: 'pr_1', status: 'needs_email_verification' }),
      ],
      '/v1/appearance': [json(200, { captchaFlows: { passwordReset: { enabled: true, provider: 'atlas' } } })],
    });
    const state = await startPasswordReset(client, 'a@b.co', undefined, { solver: async () => 'atlas1.r' });
    expect(calls.filter((c) => c.path === '/v1/client/password_resets')[1]!.body).toMatchObject({ captcha_token: 'atlas1.r' });
    expect(state.attempt?.id).toBe('pr_1');
  });
});
