import { describe, expect, it } from 'vitest';
import { FapiClient, pollAttempt, startSignUp, shouldKeepPolling } from './fapi';
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
