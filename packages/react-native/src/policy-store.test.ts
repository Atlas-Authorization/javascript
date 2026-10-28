import { describe, expect, it } from 'vitest';
import { createAtlasStore } from './store';
import type { TokenStorage } from './storage';

/**
 * Policy acceptance through the store: sign-up carries the acceptances, a held
 * sign-in (or an OAuth redirect) continues with its one-time token, the
 * policies are loaded with their content, and a signed-in user can re-accept.
 */

const FRONTEND = 'https://fapi.example.test';
const JWT = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub: 'user_1', sid: 'sess_1', exp: 9999999999 }))
  .toString('base64')
  .replace(/=+$/, '')}.sig`;
const USER = { id: 'user_1', first_name: 'Ada', last_name: null };
const SESSION = { id: 'sess_1', status: 'active' };

type Handler = (body: Record<string, unknown> | undefined, headers: Headers) => { status?: number; body?: unknown };

const POLICIES = {
  object: 'list',
  data: [
    {
      object: 'policy', key: 'tos', title: 'Terms of Service', display: 'checkbox', required: true,
      applies_to: 'sign_in_and_sign_up', version_id: 'polv_1', version: '2', content_html: '<p>Hello</p>',
      content_sha256: 'abc', effective_at: 1790000000000, summary_of_changes: null,
    },
    {
      object: 'policy', key: 'privacy', title: 'Privacy', display: 'scroll', required: true,
      applies_to: 'sign_up', version_id: 'polv_2', version: '3', content_html: '<p>Privacy</p>', content_sha256: 'def',
    },
  ],
  legacy_consent: null,
};

function setup(handlers: Record<string, Handler>, token: string | null = null) {
  const calls: Array<{ method: string; path: string; search: string; body: Record<string, unknown> | undefined; auth: string | null }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    const headers = new Headers(init?.headers);
    calls.push({ method, path: url.pathname, search: url.search, body, auth: headers.get('authorization') });
    const handler = handlers[`${method} ${url.pathname}`];
    if (!handler) return new Response('null', { status: 404 });
    const res = handler(body, headers);
    return new Response(JSON.stringify(res.body ?? null), {
      status: res.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const storage = {
    value: token,
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
  const store = createAtlasStore({ publishableKey: 'pk_test', frontendApi: FRONTEND, storage, fetchImpl, locale: 'fr' });
  const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);
  return { store, storage, calls, posts };
}

const common: Record<string, Handler> = {
  'POST /v1/client/tickets/exchange': () => ({ body: { jwt: JWT } }),
  'GET /v1/client': () => ({ body: { user: USER, session: SESSION } }),
  'GET /v1/client/policies': () => ({ body: POLICIES }),
};

describe('sign-up', () => {
  it('sends policy_acceptances and does not when there are none', async () => {
    const { store, posts } = setup({
      ...common,
      'POST /v1/client/sign_ups': () => ({ status: 201, body: { id: 'sua_1', status: 'needs_email_verification' } }),
    });
    await store.signUpWithPassword({
      emailAddress: 'a@b.co',
      password: 'pw',
      policyAcceptances: [{ policy: 'tos', version_id: 'polv_1', content_sha256: 'abc', display: 'checkbox' }],
    });
    expect(posts('/v1/client/sign_ups')[0]!.body).toMatchObject({
      policy_acceptances: [{ policy: 'tos', version_id: 'polv_1', content_sha256: 'abc', display: 'checkbox' }],
    });
    await store.signUpWithPassword({ emailAddress: 'a@b.co', password: 'pw' });
    expect(posts('/v1/client/sign_ups')[1]!.body).not.toHaveProperty('policy_acceptances');
  });

  it('a 422 POLICY_ACCEPTANCE_REQUIRED comes back as an error the form can show', async () => {
    const { store } = setup({
      ...common,
      'POST /v1/client/sign_ups': () => ({
        status: 422,
        body: { errors: [{ code: 'POLICY_ACCEPTANCE_REQUIRED', message: 'Accept the terms.' }] },
      }),
    });
    const res = await store.signUpWithPassword({ emailAddress: 'a@b.co', password: 'pw' });
    expect(res.status).toBe('error');
    expect(res.errors[0]!.code).toBe('POLICY_ACCEPTANCE_REQUIRED');
  });
});

describe('held sign-in', () => {
  const held = {
    id: 'sia_1',
    status: 'needs_policy_acceptance',
    policy_acceptance_token: 'pat_9',
    pending_policies: [
      { policy: 'tos', title: 'Terms', display: 'checkbox', version_id: 'polv_1', version: '2', content_sha256: 'abc', reaccept: true },
    ],
  };

  it('returns the held status with the token and pending list, then continues with the token and persists', async () => {
    const { store, storage, posts } = setup({
      ...common,
      'POST /v1/client/sign_ins': () => ({ status: 201, body: { id: 'sia_1', status: 'needs_first_factor', supported_first_factors: [{ strategy: 'password' }] } }),
      'POST /v1/client/sign_ins/sia_1/attempt_first_factor': () => ({ body: held }),
      'POST /v1/client/sign_ins/sia_1/accept_policies': () => ({ body: { id: 'sia_1', status: 'complete', ticket: 'tkt_1' } }),
    });
    const first = await store.signInWithPassword({ identifier: 'a@b.co', password: 'pw' });
    expect(first).toMatchObject({ status: 'needs_more', attemptStatus: 'needs_policy_acceptance', attemptId: 'sia_1', policyToken: 'pat_9' });
    expect(Array.isArray(first.pendingPolicies)).toBe(true);

    const done = await store.acceptPolicies({
      attemptId: 'sia_1',
      policyToken: first.policyToken,
      acceptances: [{ policy: 'tos', version_id: 'polv_1', content_sha256: 'abc', display: 'checkbox' }],
    });
    expect(done.status).toBe('complete');
    const sent = posts('/v1/client/sign_ins/sia_1/accept_policies')[0]!.body!;
    expect(sent.policy_acceptance_token).toBe('pat_9');
    expect(sent).not.toHaveProperty('poll_secret');
    expect((sent.policy_acceptances as Array<{ policy: string }>)[0]!.policy).toBe('tos');
    expect(posts('/v1/client/tickets/exchange')[0]!.body).toEqual({ attempt_id: 'sia_1', ticket: 'tkt_1' });
    expect(storage.value).toBe(JWT);
  });

  it('a poll secret is the proof when there is no token', async () => {
    const { store, posts } = setup({
      ...common,
      'POST /v1/client/sign_ins/sia_2/accept_policies': () => ({ body: { id: 'sia_2', status: 'complete', ticket: 'tkt_2' } }),
    });
    await store.acceptPolicies({ attemptId: 'sia_2', pollSecret: 'ps_1', acceptances: [] });
    const sent = posts('/v1/client/sign_ins/sia_2/accept_policies')[0]!.body!;
    expect(sent.poll_secret).toBe('ps_1');
    expect(sent).not.toHaveProperty('policy_acceptance_token');
  });

  it('a refusal is returned and the attempt stays held (a newer version was published)', async () => {
    const { store } = setup({
      ...common,
      'POST /v1/client/sign_ins/sia_1/accept_policies': () => ({
        status: 422,
        body: { errors: [{ code: 'POLICY_ACCEPTANCE_REQUIRED', message: 'A newer version applies.' }] },
      }),
    });
    const res = await store.acceptPolicies({ attemptId: 'sia_1', policyToken: 't', acceptances: [] });
    expect(res.status).toBe('error');
    expect(res.errors[0]!.code).toBe('POLICY_ACCEPTANCE_REQUIRED');
  });

  it('an OAuth redirect that came back held carries its token to acceptPolicies', async () => {
    const { store } = setup(common);
    const res = await store.completeOAuthRedirect(
      'myapp://cb?__atlas_attempt=sia_7&__atlas_status=needs_policy_acceptance&__atlas_policy_token=pat%2B1',
    );
    expect(res).toMatchObject({ status: 'needs_more', attemptStatus: 'needs_policy_acceptance', attemptId: 'sia_7', policyToken: 'pat+1' });
  });
});

describe('loading policies', () => {
  it('loads the sign-up policies (with the locale) and filters to sign-in ones', async () => {
    const { store, calls } = setup(common);
    const all = await store.loadPolicies();
    expect(all.map((p) => p.key)).toEqual(['tos', 'privacy']);
    expect(calls[0]!.search).toBe('?locale=fr');
    const signIn = await store.loadPolicies({ signIn: true });
    expect(signIn.map((p) => p.key)).toEqual(['tos']);
  });

  it('fills in the content a held attempt only listed; a redirect resume shows every required policy', async () => {
    const { store } = setup({
      ...common,
      'GET /v1/client/policies': () => ({ body: POLICIES }),
    });
    const c = await store.policyControllerFor({
      pendingPolicies: [{ policy: 'tos', title: 'Terms', display: 'scroll', version_id: 'polv_1', version: '2', content_sha256: 'abc' }],
    });
    const p = c.policies[0]!;
    expect(p.contentHtml).toBe('<p>Hello</p>');
    expect(p.display).toBe('scroll');
    expect(p.required).toBe(true);
    const resumed = await store.policyControllerFor({});
    expect(resumed.policies.map((x) => x.key)).toEqual(['tos', 'privacy']);
  });
});

describe('in-app re-acceptance', () => {
  it('loads the stale policies, builds a controller and posts the acceptance with the bearer token', async () => {
    const { store, calls, posts } = setup(
      {
        ...common,
        'GET /v1/client/me/policies': () => ({
          body: { data: [{ policy: 'tos', title: 'Terms', needs_reaccept: true, grace_ends_at: 1790000000000 }, { policy: 'privacy', needs_reaccept: false }] },
        }),
        'POST /v1/client/me/policies/accept': () => ({ body: {} }),
      },
      JWT,
    );
    const gate = store.createPolicyGate();
    await gate.load();
    expect(gate.pending.map((p) => p.key)).toEqual(['tos']);
    expect(calls.find((c) => c.path === '/v1/client/me/policies')!.auth).toBe(`Bearer ${JWT}`);
    const controller = await gate.begin();
    expect(controller.policies.map((p) => p.key)).toEqual(['tos']);
    controller.setAllChecked(true);
    const res = await gate.accept(controller);
    expect(res.ok).toBe(true);
    expect(gate.pending).toEqual([]);
    expect((posts('/v1/client/me/policies/accept')[0]!.body!.policy_acceptances as Array<{ policy: string }>)[0]!.policy).toBe('tos');
  });
});
