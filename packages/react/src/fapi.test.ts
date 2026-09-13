import { describe, expect, it, vi } from 'vitest';
import { nextStep } from '@atlasauth/js';
import {
  FapiClient,
  advance,
  flowFromPending,
  getProviderToken,
  initialFlow,
  pollAttempt,
  prepareFactor,
  requestForStep,
  shouldKeepPolling,
  type FlowState,
} from './fapi';

const attempt = (status: string, extra: Record<string, unknown> = {}) => ({
  id: 'sia_1',
  status,
  ...extra,
});

const responding = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

const client = (fetchImpl: typeof fetch) =>
  new FapiClient({ publishableKey: 'pk_test_1', baseUrl: 'https://fapi.atlas.test', fetchImpl });

const lastCall = (impl: typeof fetch) =>
  (impl as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;

/**
 * This mapping is the part that can be wrong in a way nobody notices until a
 * user is stuck: a password posted to the second-factor endpoint produces a
 * confusing 400, not an obvious bug.
 */
describe('choosing the request for the current step', () => {
  it('starts a sign-in when there is no attempt yet', () => {
    expect(requestForStep(null, { identifier: 'ada@example.com' })).toEqual({
      path: '/v1/client/sign_ins',
      body: { identifier: 'ada@example.com' },
    });
  });

  it('posts a password to the first-factor endpoint', () => {
    const request = requestForStep(attempt('needs_first_factor'), { password: 'hunter2' });
    expect(request).toEqual({
      path: '/v1/client/sign_ins/sia_1/attempt_first_factor',
      body: { strategy: 'password', password: 'hunter2' },
    });
  });

  /**
   * An emailed code and a password are different strategies on the same
   * endpoint. The presence of a code distinguishes them — a client-declared
   * strategy is a field the client can get wrong.
   */
  it('posts an emailed code as email_code on the same endpoint', () => {
    const request = requestForStep(attempt('needs_first_factor'), { code: '123456' });
    expect(request).toEqual({
      path: '/v1/client/sign_ins/sia_1/attempt_first_factor',
      body: { strategy: 'email_code', code: '123456' },
    });
  });

  /**
   * The check that matters most. A credential must never be posted to an
   * endpoint with no business seeing one.
   */
  it('never sends a password to the second-factor endpoint', () => {
    const request = requestForStep(attempt('needs_second_factor'), {
      code: '654321',
      password: 'hunter2',
    });

    expect(request!.path).toContain('attempt_second_factor');
    expect(request!.body).toEqual({ code: '654321' });
    expect(JSON.stringify(request!.body)).not.toContain('hunter2');
  });

  it('routes an email verification code to the sign-up endpoint', () => {
    const request = requestForStep(attempt('needs_email_verification'), { code: '111111' });
    expect(request!.path).toContain('/sign_ups/sia_1/attempt_verification');
  });

  it('routes a new password to the reset endpoint', () => {
    const request = requestForStep(attempt('needs_new_password'), { password: 'new-one' });
    expect(request!.path).toContain('/password_resets/sia_1/set_new_password');
  });

  /**
   * Returning null rather than a best guess means a component cannot
   * accidentally POST to an endpoint that does not apply to the state the
   * server put it in.
   */
  it('has nothing to submit for states that are not awaiting input', () => {
    for (const status of ['needs_oauth_callback', 'complete', 'abandoned', 'needs_captcha']) {
      expect(requestForStep(attempt(status), {}), status).toBeNull();
    }
  });
});

describe('the client', () => {
  it('sends the publishable key and credentials', async () => {
    const fetchImpl = responding(attempt('needs_first_factor'));
    await client(fetchImpl).post('/v1/client/sign_ins', { identifier: 'a@b.c' });

    const [url, init] = lastCall(fetchImpl);
    expect(url).toBe('https://fapi.atlas.test/v1/client/sign_ins');
    // Without credentials a request is indistinguishable from being signed out.
    expect((init as RequestInit).credentials).toBe('include');
    expect((init as RequestInit).headers).toMatchObject({ 'x-publishable-key': 'pk_test_1' });
  });

  it('surfaces §9.1 errors verbatim with their param', async () => {
    const fetchImpl = responding(
      { errors: [{ code: 'PASSWORD_POLICY', message: 'Too short.', param: 'password' }] },
      400,
    );

    const response = await client(fetchImpl).post('/v1/client/sign_ins', {});
    expect(response.ok).toBe(false);
    expect(response.errors[0]).toEqual({
      code: 'PASSWORD_POLICY',
      message: 'Too short.',
      param: 'password',
    });
  });

  /**
   * A sign-in box that throws on a flaky connection unmounts itself and loses
   * whatever the user had typed.
   */
  it('reports a network failure as a form error rather than throwing', async () => {
    const dead = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const response = await client(dead).post('/v1/client/sign_ins', {});
    expect(response.ok).toBe(false);
    expect(response.errors[0]!.code).toBe('NETWORK');
  });

  it('survives a non-JSON error body', async () => {
    const html = (async () =>
      new Response('<html>502</html>', { status: 502 })) as unknown as typeof fetch;

    const response = await client(html).post('/v1/client/sign_ins', {});
    expect(response.ok).toBe(false);
    expect(response.errors).toEqual([]);
  });
});

/**
 * §6.6 the client-side token vault helper. Reads the signed-in user's own
 * provider access token from `/v1/client/me/external_accounts/:provider/token`.
 */
describe('getProviderToken', () => {
  it('reads the token from the me endpoint and maps the shape', async () => {
    const fetchImpl = responding({
      object: 'oauth_access_token',
      provider: 'google',
      access_token: 'at_live',
      expires_at: 1_800_000,
      scopes: ['openid', 'email'],
    });

    const token = await getProviderToken(client(fetchImpl), 'google');

    expect(token).toEqual({
      provider: 'google',
      accessToken: 'at_live',
      expiresAt: 1_800_000,
      scopes: ['openid', 'email'],
    });
    // A GET to the per-provider token path, provider URL-encoded.
    const [url, init] = lastCall(fetchImpl);
    expect(url).toBe(
      'https://fapi.atlas.test/v1/client/me/external_accounts/google/token',
    );
    expect((init as RequestInit).method).toBe('GET');
    expect((init as RequestInit).credentials).toBe('include');
  });

  it('returns null when there is no usable token (404)', async () => {
    const fetchImpl = responding({ errors: [{ code: 'NOT_FOUND', message: 'No account.' }] }, 404);
    expect(await getProviderToken(client(fetchImpl), 'github')).toBeNull();
  });
});

describe('resuming from a redirect handed back mid-flow', () => {
  it('seeds the flow at the second-factor step from an OAuth redirect', () => {
    // An MFA user completing OAuth comes back with needs_second_factor and no
    // ticket; the flow must resume AT the 2FA step, bound to that attempt id.
    const state = flowFromPending({ id: 'sia_oauth', status: 'needs_second_factor' });
    expect((state.attempt as { id?: string })?.id).toBe('sia_oauth');
    expect(nextStep(state.attempt!).kind).toBe('collect_second_factor');
  });

  it('is the empty initial flow when there is nothing pending', () => {
    // The ordinary fresh sign-in: no redirect, start at the identifier.
    expect(flowFromPending(null)).toEqual(initialFlow);
  });

  it('carries no ticket — the session is not established until 2FA passes', () => {
    expect(flowFromPending({ id: 'sia_1', status: 'needs_second_factor' }).ticket).toBeNull();
  });
});

describe('advancing the flow', () => {
  it('takes the status from the server', async () => {
    const fetchImpl = responding(attempt('needs_second_factor'));
    const next = await advance(client(fetchImpl), initialFlow, { identifier: 'a@b.c' });

    // Never decided locally — the client renders what the server demands (§5).
    expect(next.attempt!.status).toBe('needs_second_factor');
    expect(next.errors).toEqual([]);
  });

  /**
   * Clearing the attempt on a wrong password would drop the user back to the
   * identifier step, losing their progress and re-triggering the
   * anti-enumeration path for nothing.
   */
  it('keeps the attempt when a submission fails', async () => {
    const state: FlowState = { ...initialFlow, attempt: attempt('needs_first_factor') };
    const fetchImpl = responding(
      { errors: [{ code: 'VERIFICATION_FAILED', message: 'Those credentials are incorrect.' }] },
      400,
    );

    const next = await advance(client(fetchImpl), state, { password: 'wrong' });
    expect(next.attempt!.status).toBe('needs_first_factor');
    expect(next.errors[0]!.message).toBe('Those credentials are incorrect.');
  });

  it('does nothing for a state with nothing to submit', async () => {
    const state: FlowState = { ...initialFlow, attempt: attempt('complete') };
    const fetchImpl = responding({});

    expect(await advance(client(fetchImpl), state, {})).toEqual(state);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('clears stale errors on a successful step', async () => {
    const state: FlowState = {
      ...initialFlow,
      attempt: attempt('needs_first_factor'),
      errors: [{ code: 'X', message: 'old' }],
    };

    const next = await advance(client(responding(attempt('complete'))), state, {
      password: 'right',
    });
    expect(next.errors).toEqual([]);
  });
});

/**
 * §5.3. The poll secret is what lets THIS tab collect a sign-in completed by a
 * link opened on another device.
 */
describe('the magic-link path', () => {
  it('keeps the poll secret the server returns', async () => {
    const state: FlowState = { ...initialFlow, attempt: attempt('needs_first_factor') };
    const fetchImpl = responding({ poll_secret: 'ps_abc' });

    const next = await prepareFactor(client(fetchImpl), state, 'email_link');
    expect(next.pollSecret).toBe('ps_abc');
    expect(JSON.parse((lastCall(fetchImpl)[1] as RequestInit).body as string)).toEqual({
      strategy: 'email_link',
    });
  });

  it('sends the poll secret when polling', async () => {
    const state: FlowState = {
      ...initialFlow,
      attempt: attempt('needs_first_factor'),
      pollSecret: 'ps_abc',
    };
    const fetchImpl = responding(attempt('needs_first_factor'));

    await pollAttempt(client(fetchImpl), state);
    expect(lastCall(fetchImpl)[0]).toContain('poll_secret=ps_abc');
  });

  it('returns the ticket once the link has been opened', async () => {
    const state: FlowState = {
      ...initialFlow,
      attempt: attempt('needs_first_factor'),
      pollSecret: 'ps_abc',
    };
    const fetchImpl = responding(attempt('complete', { ticket: 'tkt_1' }));

    const result = await pollAttempt(client(fetchImpl), state);
    expect(result.ticket).toBe('tkt_1');
    expect(result.state.attempt!.status).toBe('complete');
  });

  it('does not poll without a secret', async () => {
    const fetchImpl = responding({});
    await pollAttempt(client(fetchImpl), {
      ...initialFlow,
      attempt: attempt('needs_first_factor'),
    });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  /** A tab must not poll a dead attempt forever. */
  it('stops polling once the attempt is terminal', () => {
    const polling: FlowState = {
      ...initialFlow,
      attempt: attempt('needs_first_factor'),
      pollSecret: 'ps',
    };

    expect(shouldKeepPolling(polling)).toBe(true);
    expect(shouldKeepPolling({ ...polling, attempt: attempt('complete') })).toBe(false);
    expect(shouldKeepPolling({ ...polling, attempt: attempt('abandoned') })).toBe(false);
    expect(shouldKeepPolling({ ...polling, pollSecret: null })).toBe(false);
  });
});

describe('enrolling a second factor mid-sign-in', () => {
  it('posts both codes and the factor id to the enrollment endpoint', () => {
    const request = requestForStep(attempt('needs_mfa_enrollment'), {
      factorId: 'mfa_1',
      code: '111111',
      secondCode: '222222',
    });

    expect(request?.path).toContain('/attempt_mfa_enrollment');
    // §5.6 wants two CONSECUTIVE codes: one proves the secret was copied, two
    // prove the device's clock agrees with ours.
    expect(request?.body).toEqual({ factor_id: 'mfa_1', codes: ['111111', '222222'] });
  });

  it('never posts a password to the enrollment endpoint', () => {
    const request = requestForStep(attempt('needs_mfa_enrollment'), {
      factorId: 'mfa_1',
      code: '111111',
      secondCode: '222222',
      password: 'hunter2',
    });
    expect(JSON.stringify(request?.body)).not.toContain('hunter2');
  });
});
