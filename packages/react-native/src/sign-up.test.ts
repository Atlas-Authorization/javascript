import { describe, expect, it, vi } from 'vitest';
import { createAtlasStore, type AtlasStoreConfig } from './store';
import { isCaptchaRequired } from './errors';
import type { TokenStorage } from './storage';

/**
 * `signUpWithPassword` really creates the account: it posts the Frontend API's
 * `email` (+ configured `fields`) to `/v1/client/sign_ups`, exchanges a
 * completion ticket for a token (never storing the ticket itself), and verifies
 * the emailed code. Captcha: this SDK draws none, so a captcha-gated sign-up /
 * sign-in asks the app's `getCaptchaToken` callback (with the instance's public
 * captcha settings) and retries once; without one it returns CAPTCHA_REQUIRED.
 */

const FRONTEND = 'https://fapi.example.test';
const JWT = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub: 'user_1', sid: 'sess_1', exp: 9999999999 }))
  .toString('base64')
  .replace(/=+$/, '')}.sig`;
const USER = { id: 'user_1', first_name: 'Ada', last_name: null };
const SESSION = { id: 'sess_1', status: 'active' };
const CAPTCHA = { enabled: true, provider: 'turnstile', siteKey: 'ts-site', widget: 'managed' };

type Handler = (body: Record<string, unknown> | undefined) => { status?: number; body?: unknown };

function setup(handlers: Record<string, Handler>, extra: Partial<AtlasStoreConfig> = {}) {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | undefined }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    calls.push({ method, path, body });
    const handler = handlers[`${method} ${path}`];
    if (!handler) return new Response('null', { status: 404 });
    const res = handler(body);
    return new Response(JSON.stringify(res.body ?? null), {
      status: res.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const storage = {
    value: null as string | null,
    getToken() {
      return this.value;
    },
    setToken(t: string) {
      this.value = t;
    },
    clearToken() {
      this.value = null;
    },
  } satisfies TokenStorage & { value: string | null };
  const store = createAtlasStore({ publishableKey: 'pk_test', frontendApi: FRONTEND, storage, fetchImpl, ...extra });
  const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);
  return { store, storage, posts };
}

const common: Record<string, Handler> = {
  'POST /v1/client/tickets/exchange': () => ({ body: { jwt: JWT } }),
  'GET /v1/client': () => ({ body: { user: USER, session: SESSION } }),
  'GET /v1/appearance': () => ({ body: { appearance: {}, captchaFlows: { signUp: CAPTCHA, signIn: CAPTCHA } } }),
};

describe('signUpWithPassword creates the account', () => {
  it('posts email + fields to /v1/client/sign_ups, then verifies the code and persists the exchanged token', async () => {
    const { store, storage, posts } = setup({
      ...common,
      'POST /v1/client/sign_ups': () => ({ status: 201, body: { id: 'sua_1', status: 'needs_email_verification' } }),
      'POST /v1/client/sign_ups/sua_1/attempt_verification': () => ({
        body: { id: 'sua_1', status: 'complete', ticket: 'tkt_1' },
      }),
    });

    const first = await store.signUpWithPassword({
      emailAddress: 'new@example.com',
      password: 'blue tangerine anvil 71!',
      firstName: 'Ada',
      fields: { company: 'Acme' },
      consent: true,
    });
    expect(first).toMatchObject({ status: 'needs_more', attemptId: 'sua_1', attemptStatus: 'needs_email_verification' });
    expect(posts('/v1/client/sign_ins')).toHaveLength(0);
    expect(posts('/v1/client/sign_ups')[0]!.body).toEqual({
      email: 'new@example.com',
      password: 'blue tangerine anvil 71!',
      fields: { company: 'Acme', first_name: 'Ada' },
      consent: true,
    });

    const done = await store.verifyEmailCode({ attemptId: 'sua_1', code: '424242' });
    expect(done.status).toBe('complete');
    expect(posts('/v1/client/tickets/exchange')[0]!.body).toEqual({ attempt_id: 'sua_1', ticket: 'tkt_1' });
    expect(storage.value).toBe(JWT);
  });

  it('an immediately-complete sign-up exchanges the ticket — the ticket is never stored as the token', async () => {
    const { store, storage, posts } = setup({
      ...common,
      'POST /v1/client/sign_ups': () => ({ status: 201, body: { id: 'sua_2', status: 'complete', ticket: 'tkt_2' } }),
    });
    const result = await store.signUpWithPassword({ emailAddress: 'a@b.co', password: 'pw' });
    expect(result.status).toBe('complete');
    expect(posts('/v1/client/tickets/exchange')[0]!.body).toEqual({ attempt_id: 'sua_2', ticket: 'tkt_2' });
    expect(storage.value).toBe(JWT);
  });
});

describe('captcha', () => {
  const gated: Handler = (body) =>
    body?.captcha_token === 'tok-1'
      ? { status: 201, body: { id: 'sua_3', status: 'needs_email_verification' } }
      : { status: 400, body: { errors: [{ code: 'CAPTCHA_REQUIRED', message: 'Complete the captcha.', param: 'captcha_token' }] } };

  it('without a token source, a captcha-gated sign-up returns CAPTCHA_REQUIRED', async () => {
    const { store } = setup({ ...common, 'POST /v1/client/sign_ups': gated });
    const result = await store.signUpWithPassword({ emailAddress: 'a@b.co', password: 'pw' });
    expect(result.status).toBe('error');
    expect(isCaptchaRequired(result)).toBe(true);
    expect(result.errors[0]).toMatchObject({ code: 'CAPTCHA_REQUIRED', message: 'Complete the captcha.' });
  });

  it('asks getCaptchaToken (with the public settings) and retries once with the token', async () => {
    const getCaptchaToken = vi.fn(async () => 'tok-1');
    const { store, posts } = setup({ ...common, 'POST /v1/client/sign_ups': gated }, { getCaptchaToken });
    const result = await store.signUpWithPassword({ emailAddress: 'a@b.co', password: 'pw' });
    expect(result).toMatchObject({ status: 'needs_more', attemptId: 'sua_3' });
    expect(getCaptchaToken).toHaveBeenCalledWith({ flow: 'signUp', captcha: CAPTCHA });
    expect(posts('/v1/client/sign_ups')).toHaveLength(2);
    expect(posts('/v1/client/sign_ups')[1]!.body).toMatchObject({ captcha_token: 'tok-1' });
  });

  it('a captchaToken passed to the call is sent on the first request', async () => {
    const { store, posts } = setup({ ...common, 'POST /v1/client/sign_ups': gated });
    const result = await store.signUpWithPassword({ emailAddress: 'a@b.co', password: 'pw', captchaToken: 'tok-1' });
    expect(result.status).toBe('needs_more');
    expect(posts('/v1/client/sign_ups')).toHaveLength(1);
  });

  it('sign-in answers needs_captcha with the app token, then continues to the password', async () => {
    const getCaptchaToken = vi.fn(async () => 'tok-si');
    const { store, posts } = setup(
      {
        ...common,
        'POST /v1/client/sign_ins': (body) =>
          body?.captcha_token
            ? { status: 201, body: { id: 'sia_1', status: 'needs_first_factor', supported_first_factors: [{ strategy: 'password' }] } }
            : { status: 201, body: { id: null, status: 'needs_captcha', identifier: 'me@example.com' } },
        'POST /v1/client/sign_ins/sia_1/attempt_first_factor': () => ({
          body: { id: 'sia_1', status: 'complete', ticket: 'tkt_si' },
        }),
      },
      { getCaptchaToken },
    );
    const result = await store.signInWithPassword({ identifier: 'me@example.com', password: 'pw' });
    expect(result.status).toBe('complete');
    expect(getCaptchaToken).toHaveBeenCalledWith({ flow: 'signIn', captcha: CAPTCHA });
    expect(posts('/v1/client/sign_ins')[1]!.body).toEqual({ identifier: 'me@example.com', captcha_token: 'tok-si' });
  });

  it('sign-in without a token source returns CAPTCHA_REQUIRED instead of a dangling needs_captcha', async () => {
    const { store } = setup({
      ...common,
      'POST /v1/client/sign_ins': () => ({ status: 201, body: { id: null, status: 'needs_captcha' } }),
    });
    const result = await store.signInWithPassword({ identifier: 'me@example.com', password: 'pw' });
    expect(result.status).toBe('error');
    expect(result.errors[0]!.code).toBe('CAPTCHA_REQUIRED');
  });
});
