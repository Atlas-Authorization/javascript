import { describe, expect, it, vi } from 'vitest';
import { FapiClient, initialFlow } from './fapi';
import { createSignInScreen } from './sign-in-screen';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function clientWith(routes: Record<string, Response[]>) {
  const calls: { path: string; body: any }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input).replace('https://fapi.example', '');
    calls.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return routes[path]?.shift() ?? json(404, { errors: [{ code: 'NOT_FOUND', message: 'no route' }] });
  }) as unknown as typeof fetch;
  return { client: new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://fapi.example', fetchImpl, referral: false, exposeSession: false }), calls };
}

describe('createSignInScreen', () => {
  it('walks identifier -> password -> second factor (text) -> complete, with fields and a sentence for a wrong code', async () => {
    const { client, calls } = clientWith({
      '/v1/client/sign_ins': [json(201, { id: 'sia_1', status: 'needs_first_factor', supported_first_factors: ['password', 'email_code'] })],
      '/v1/client/sign_ins/sia_1/attempt_first_factor': [json(200, { id: 'sia_1', status: 'needs_second_factor' })],
      '/v1/client/sign_ins/sia_1/second_factors': [json(200, { factors: ['totp', 'sms'] })],
      '/v1/client/sign_ins/sia_1/prepare_second_factor': [json(201, { sent_to: '+1 *** 4821' })],
      '/v1/client/sign_ins/sia_1/attempt_second_factor': [
        json(400, { errors: [{ code: 'VERIFICATION_FAILED', reason: 'form_code_incorrect', message: 'Wrong code.' }] }),
        json(200, { id: 'sia_1', status: 'complete', created_session_id: 's1', ticket: 't' }),
      ],
      '/v1/client/tickets/exchange': [json(200, {})],
    });
    const screen = createSignInScreen({ client, localization: (k) => (k === 'error.form_code_incorrect' ? 'That code is not right.' : null) });
    expect(screen.getView()).toMatchObject({ step: 'identifier', fields: [{ name: 'identifier', autoComplete: 'username' }] });

    await screen.submit({ identifier: ' a@b.co ' });
    expect(calls[0]!.body).toMatchObject({ identifier: 'a@b.co' });
    expect(screen.getView()).toMatchObject({ step: 'first_factor', methods: ['password', 'email_code'], method: 'password', attemptId: 'sia_1' });
    expect(screen.getView().fields[0]).toMatchObject({ name: 'password', secure: true });

    await screen.submit({ password: 'pw' });
    expect(screen.getView()).toMatchObject({ step: 'second_factor', methods: ['totp', 'backup_code', 'sms'], method: 'totp' });

    await screen.selectMethod('sms');
    expect(screen.getView()).toMatchObject({ method: 'sms', needsSend: true, codeSent: false });
    await screen.sendCode();
    expect(screen.getView()).toMatchObject({ needsSend: false, codeSent: true, sentTo: '+1 *** 4821' });

    await screen.submit({ code: '000000' });
    expect(screen.getView()).toMatchObject({ step: 'second_factor', error: 'That code is not right.', reason: 'form_code_incorrect' });
    await screen.submit({ code: '123456' });
    expect(screen.getView()).toMatchObject({ step: 'complete', error: null });
  });

  it('offers the one-tap sign-ins it was given and runs a native Apple sheet through the flow', async () => {
    const { client } = clientWith({ '/v1/client/tickets/exchange': [json(200, {})] });
    const apple = vi.fn(async () => ({ ...initialFlow, attempt: { id: 'sia_a', status: 'complete', created_session_id: 's2' } as never, ticket: 't' }));
    const screen = createSignInScreen({ client, nativeSignIn: { apple } });
    expect(screen.getView().alternatives).toEqual(['apple']);
    await screen.signInWithApple();
    expect(apple).toHaveBeenCalledOnce();
    expect(screen.getView().step).toBe('complete');
  });

  it('does not show a dismissed system sheet as an error', async () => {
    const { client } = clientWith({});
    const google = vi.fn(async () => ({ ...initialFlow, errors: [{ code: 'NATIVE_CANCELLED', reason: 'native_cancelled', message: 'cancelled' }] }));
    const screen = createSignInScreen({ client, nativeSignIn: { google } });
    await screen.signInWithGoogle();
    expect(screen.getView()).toMatchObject({ step: 'identifier', error: null, reason: null });
  });
});

describe('createSignInScreen: the steps after the credentials', () => {
  const policy = { policy: 'tos', policy_id: 'p1', title: 'Terms', display: 'checkbox', version_id: 'v1', version: '1', content_sha256: 'abc', reaccept: false, summary_of_changes: null };

  it('sets up an authenticator app with its QR code, then shows the recovery codes once', async () => {
    const { client, calls } = clientWith({
      '/v1/client/sign_ins': [json(201, { object: 'sign_in_attempt', id: 'sia_m', status: 'needs_mfa_enrollment' })],
      '/v1/appearance': [json(200, { account: { mfa: { totp: true, sms: true, totp_codes: 1 } } })],
      '/v1/client/sign_ins/sia_m/prepare_mfa_enrollment': [json(200, { factor_id: 'fac_1', secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/x', qr_svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' })],
      '/v1/client/sign_ins/sia_m/attempt_mfa_enrollment': [json(200, { id: 'sia_m', status: 'complete', created_session_id: 's', ticket: 't', backup_codes: ['aaaa-bbbb'] })],
      '/v1/client/tickets/exchange': [json(200, {})],
    });
    const screen = createSignInScreen({ client });
    await screen.submit({ identifier: 'a@b.co' });
    expect(screen.getView()).toMatchObject({ step: 'enroll_second_factor', methods: ['totp', 'sms'], method: 'totp', fields: [] });
    await screen.selectMethod('totp');
    expect(calls.find((c) => c.path.endsWith('prepare_mfa_enrollment'))!.body).toEqual({ strategy: 'totp' });
    expect(screen.getView().enrollment?.totp).toMatchObject({ secret: 'JBSWY3DPEHPK3PXP' });
    expect(screen.getView().fields).toEqual([expect.objectContaining({ name: 'code', autoComplete: 'one-time-code' })]);
    await screen.submit({ code: '123456' });
    expect(screen.getView()).toMatchObject({ step: 'recovery_codes', recoveryCodes: ['aaaa-bbbb'] });
    await screen.acknowledgeRecoveryCodes();
    expect(screen.getView().step).toBe('complete');
  });

  it('asks for a phone number first when enrolling by text', async () => {
    const { client } = clientWith({
      '/v1/client/sign_ins': [json(201, { object: 'sign_in_attempt', id: 'sia_p', status: 'needs_mfa_enrollment' })],
      '/v1/appearance': [json(200, { account: { mfa: { totp: true, sms: true } } })],
      '/v1/client/sign_ins/sia_p/prepare_mfa_enrollment': [json(200, { factor_id: 'fac_2', phone: '+1***99' })],
    });
    const screen = createSignInScreen({ client });
    await screen.submit({ identifier: 'a@b.co' });
    await screen.selectMethod('sms');
    expect(screen.getView().fields).toEqual([expect.objectContaining({ name: 'phone', kind: 'phone' })]);
    await screen.submit({ phone: '+15555550199' });
    expect(screen.getView().enrollment?.phone).toBe('+1***99');
    expect(screen.getView().fields).toEqual([expect.objectContaining({ name: 'code' })]);
  });

  it('accepts the listed policies', async () => {
    const { client, calls } = clientWith({
      '/v1/client/sign_ins': [json(201, { object: 'sign_in_attempt', id: 'sia_c', status: 'needs_policy_acceptance', pending_policies: [policy] })],
      '/v1/client/sign_ins/sia_c/accept_policies': [json(200, { id: 'sia_c', status: 'complete', created_session_id: 's', ticket: 't' })],
      '/v1/client/tickets/exchange': [json(200, {})],
    });
    const screen = createSignInScreen({ client });
    await screen.submit({ identifier: 'a@b.co' });
    expect(screen.getView()).toMatchObject({ step: 'policies', policies: [{ policy: 'tos' }] });
    await screen.acceptPolicies();
    expect(JSON.stringify(calls.find((c) => c.path.endsWith('accept_policies'))!.body)).toContain('"version_id":"v1"');
    expect(screen.getView().step).toBe('complete');
  });

  it('drives required actions with their fields and a mapped error', async () => {
    const { client } = clientWith({
      '/v1/client/sign_ins': [json(201, { object: 'sign_in_attempt', id: 'sia_r', status: 'needs_required_action', required_action_token: 'rat', pending_required_actions: [{ id: 'ra1', action: 'update_password', url: null, reason: null }] })],
      '/v1/client/sign_ins/sia_r/required_actions': [
        json(400, { errors: [{ code: 'PASSWORD_POLICY', reason: 'form_password_too_short', message: 'Too short.' }] }),
        json(200, { id: 'sia_r', status: 'complete', created_session_id: 's', ticket: 't' }),
      ],
      '/v1/client/tickets/exchange': [json(200, {})],
    });
    const screen = createSignInScreen({ client, localization: (k) => (k === 'error.form_password_too_short' ? 'Use a longer password.' : null) });
    await screen.submit({ identifier: 'a@b.co' });
    expect(screen.getView()).toMatchObject({ step: 'required_action', requiredAction: { kind: 'update_password', remaining: 0 }, fields: [{ name: 'new_password', secure: true }] });
    await screen.submit({ new_password: 'x' });
    expect(screen.getView().error).toBe('Use a longer password.');
    await screen.submit({ new_password: 'a much longer password 9!' });
    expect(screen.getView().step).toBe('complete');
  });
});

