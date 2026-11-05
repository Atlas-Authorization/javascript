import { describe, expect, it } from 'vitest';
import { acknowledgeExistingAccount, advance, existingAccountResetUrl, FapiClient, pendingExistingAccountNotice, pollAttempt, signInAfterProofUrl, signUpProvedByLink, startSignUp, shouldKeepPolling } from './fapi';
import type { AttemptView } from './attempt';
import { pollPasswordReset, startPasswordReset } from './password-reset';

function scripted(route: (path: string) => { status?: number; body: unknown }) {
  const paths: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    paths.push(`${url.pathname}${url.search}`);
    const res = route(url.pathname);
    return new Response(JSON.stringify(res.body), { status: res.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { client: new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://f.example', fetchImpl }), paths };
}

describe('email verification by link', () => {
  it('a sign-in link that only lifted a password hold stops the poll and asks for the password', async () => {
    const { client } = scripted(() => ({ body: { id: 'sia_1', object: 'sign_in_attempt', status: 'needs_first_factor', identifier: 'a@b.c', password_hold_released: true } }));
    const flow = { attempt: { id: 'sia_1', object: 'sign_in_attempt', status: 'needs_first_factor' }, errors: [], busy: false, pollSecret: 'ps', ticket: null, prepared: 'email_link' } as unknown as Parameters<typeof pollAttempt>[1];
    const { state, ticket } = await pollAttempt(client, flow);
    expect(ticket).toBeNull();
    expect(state.prepared).toBeNull();
    expect(state.passwordHold).toEqual({ attemptId: 'sia_1', email: 'a@b.c', released: true });
    expect(shouldKeepPolling(state)).toBe(false);
  });

  it('a link-mode sign-up keeps the poll secret and polls its own route until complete', async () => {
    let done = false;
    const { client, paths } = scripted((path) =>
      path === '/v1/client/sign_ups'
        ? { status: 201, body: { id: 'sua_1', object: 'sign_up_attempt', status: 'needs_email_verification', poll_secret: 'ps' } }
        : { body: { id: 'sua_1', object: 'sign_up_attempt', status: done ? 'complete' : 'needs_email_verification', ...(done ? { ticket: 't' } : {}) } },
    );
    const flow = await startSignUp(client, { email: 'a@b.c', password: 'pw' });
    expect(flow.pollSecret).toBe('ps');
    expect(shouldKeepPolling(flow)).toBe(true);
    expect((await pollAttempt(client, flow)).ticket).toBeNull();
    done = true;
    expect((await pollAttempt(client, flow)).ticket).toBe('t');
    expect(paths[1]).toBe('/v1/client/sign_ups/sua_1?poll_secret=ps');
  });

  it('a code-mode sign-up does not poll', async () => {
    const { client } = scripted(() => ({ status: 201, body: { id: 'sua_2', object: 'sign_up_attempt', status: 'needs_email_verification' } }));
    expect(shouldKeepPolling(await startSignUp(client, { email: 'a@b.c', password: 'pw' }))).toBe(false);
  });
});

describe('password reset by link', () => {
  it('polls the reset until the link moves it on', async () => {
    const { client, paths } = scripted((path) =>
      path === '/v1/client/password_resets'
        ? { status: 201, body: { id: 'pra_1', status: 'needs_email_verification', poll_secret: 'ps' } }
        : { body: { id: 'pra_1', status: 'needs_new_password' } },
    );
    const started = await startPasswordReset(client, 'a@b.c');
    const next = await pollPasswordReset(client, started);
    expect(next.attempt?.status).toBe('needs_new_password');
    expect(paths[1]).toBe('/v1/client/password_resets/pra_1?poll_secret=ps');
  });

  it('without a poll secret (code mode) it does nothing', async () => {
    const { client, paths } = scripted(() => ({ status: 201, body: { id: 'pra_2', status: 'needs_email_verification' } }));
    const started = await startPasswordReset(client, 'a@b.c');
    expect(await pollPasswordReset(client, started)).toBe(started);
    expect(paths).toHaveLength(1);
  });
});

describe('a sign-up that proved an existing account', () => {
  const started = async (route: (path: string) => { status?: number; body: unknown }) => {
    const { client } = scripted(route);
    return { client, state: await startSignUp(client, { email: 'a@b.c', password: 'typed-at-sign-up' }) };
  };

  it('keeps the signal from the proof through a second factor, and the notice waits for completion', async () => {
    const { client, state } = await started((path) => {
      if (path === '/v1/client/sign_ups') return { status: 201, body: { id: 'sua_1', object: 'sign_up_attempt', status: 'needs_email_verification' } };
      if (path === '/v1/client/sign_ups/sua_1/attempt_verification') return { body: { id: 'sua_1', object: 'sign_up_attempt', status: 'needs_second_factor', existing_account: true } };
      return { body: { id: 'sua_1', object: 'sign_in_attempt', status: 'complete', ticket: 't' } };
    });
    expect(state.existingAccount).toBeUndefined();

    const proven = await advance(client, state, { code: '123456' });
    expect(proven.existingAccount).toBe(true);
    expect(pendingExistingAccountNotice(proven)).toBe(false);

    const done = await advance(client, proven, { code: '654321' });
    expect(done.attempt?.status).toBe('complete');
    expect(pendingExistingAccountNotice(done)).toBe(true);
    expect(pendingExistingAccountNotice({ ...done, sessionKept: false })).toBe(false);
    expect(pendingExistingAccountNotice({ ...done, recoveryCodes: ['x'] })).toBe(false);

    const acknowledged = acknowledgeExistingAccount(done);
    expect(pendingExistingAccountNotice(acknowledged)).toBe(false);
    expect(acknowledged.ticket).toBeNull();
  });

  it('an ordinary sign-up never gets the notice', async () => {
    const { client, state } = await started((path) =>
      path === '/v1/client/sign_ups'
        ? { status: 201, body: { id: 'sua_2', object: 'sign_up_attempt', status: 'needs_email_verification' } }
        : { body: { id: 'sua_2', object: 'sign_up_attempt', status: 'complete', ticket: 't' } },
    );
    expect(pendingExistingAccountNotice(await advance(client, state, { code: '123456' }))).toBe(false);
  });

  it('a sign-up a link proved: an emailed-link attempt with no passkey to create', () => {
    const attempt = { id: 'sua_1', object: 'sign_up_attempt', status: 'needs_first_factor' } as AttemptView;
    expect(signUpProvedByLink(attempt)).toBe(true);
    expect(signUpProvedByLink({ ...attempt, supported_first_factors: ['passkey'] })).toBe(false);
    expect(signUpProvedByLink({ ...attempt, object: 'sign_in_attempt' })).toBe(false);
    expect(signUpProvedByLink({ ...attempt, status: 'needs_email_verification' })).toBe(false);
    expect(signUpProvedByLink(null)).toBe(false);
  });

  it('the sign-in target: the app page, hidden, or the hosted sign-in page without a reset', () => {
    expect(signInAfterProofUrl({ url: 'https://app.example/login' })).toBe('https://app.example/login');
    expect(signInAfterProofUrl({ url: null, frontendApi: 'https://f.example' })).toBeNull();
    const hosted = new URL(signInAfterProofUrl({ frontendApi: 'https://f.example', redirectUrl: 'https://app.example/' })!);
    expect(hosted.pathname).toBe('/hosted/sign-in');
    expect(hosted.searchParams.has('forgot_password')).toBe(false);
  });

  it('the reset target: the app page, hidden, or the hosted sign-in page', () => {
    expect(existingAccountResetUrl({ url: 'https://app.example/forgot' })).toBe('https://app.example/forgot');
    expect(existingAccountResetUrl({ url: null, frontendApi: 'https://f.example' })).toBeNull();
    expect(existingAccountResetUrl({ frontendApi: 'https://f.example', redirectUrl: 'https://app.example/' })).toContain('https://f.example/hosted/sign-in');
    expect(new URL(existingAccountResetUrl({ frontendApi: 'https://f.example', redirectUrl: 'https://app.example/' })!).searchParams.get('forgot_password')).toBe('1');
    expect(new URL(existingAccountResetUrl({ frontendApi: 'https://f.example', redirectUrl: 'https://app.example/' })!).searchParams.get('redirect_url')).toBe('https://app.example/');
    expect(existingAccountResetUrl({})).toBeNull();
  });
});
