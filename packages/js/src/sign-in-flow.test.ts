import { describe, expect, it, vi } from 'vitest';
import { FapiClient } from './fapi';
import { createSignInFlow, createSignUpFlow } from './sign-in-flow';
import { requireStepUp, retryWithStepUp, stepUpRequirement, StepUpCancelledError } from './step-up';
import { reasonMessage } from './errors';

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
