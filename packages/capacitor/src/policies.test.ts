// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAtlasCapacitor } from './index';
import { createPolicyApi, mountPolicyGate, policyText } from './policies';
import type { CapacitorPlugins, PreferencesPlugin } from './plugins';

/**
 * Policy acceptance on Capacitor: the sign-in itself runs on Atlas's hosted
 * pages in the system browser; the WebView layer gets the policies for its own
 * screens and the signed-in re-acceptance gate, over the session's bearer token.
 */

const FRONTEND = 'https://fapi.example.test';

const POLICIES = {
  object: 'list',
  data: [
    { object: 'policy', key: 'tos', title: 'Terms', display: 'checkbox', required: true, applies_to: 'sign_in_and_sign_up', version_id: 'polv_1', version: '2', content_html: '<p>Hello</p>', content_sha256: 'abc' },
    { object: 'policy', key: 'privacy', title: 'Privacy', display: 'scroll', required: true, applies_to: 'sign_up', version_id: 'polv_2', version: '3', content_html: '<p>P</p>', content_sha256: 'def' },
  ],
};

type Call = { method: string; url: string; path: string; body: any; headers: Headers };

function fakeApi(handlers: Record<string, (body: any) => unknown>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body && typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: String(input), path: url.pathname, body, headers: new Headers(init?.headers) });
    const handler = handlers[`${method} ${url.pathname}`];
    if (!handler) return new Response('null', { status: 404 });
    const out = handler(body) as { status?: number; body?: unknown };
    return new Response(JSON.stringify(out.body ?? null), { status: out.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

afterEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

describe('createPolicyApi', () => {
  it('loads the policies with the publishable key and the locale, no session needed', async () => {
    const { fetchImpl, calls } = fakeApi({ 'GET /v1/client/policies': () => ({ body: POLICIES }) });
    const api = createPolicyApi({ publishableKey: 'pk_test', frontendApi: FRONTEND, authHeaders: async () => ({}), fetchImpl, locale: 'fr' });
    const c = await api.policies();
    expect(c.policies.map((p) => p.key)).toEqual(['tos', 'privacy']);
    expect(calls[0]!.url).toBe(`${FRONTEND}/v1/client/policies?locale=fr`);
    expect(calls[0]!.headers.get('x-publishable-key')).toBe('pk_test');
    expect(calls[0]!.headers.get('authorization')).toBeNull();
    const signIn = await api.policies({ signIn: true });
    expect(signIn.policies.map((p) => p.key)).toEqual(['tos']);
  });

  it('fills in the content a held attempt only listed', async () => {
    const { fetchImpl } = fakeApi({ 'GET /v1/client/policies': () => ({ body: POLICIES }) });
    const api = createPolicyApi({ publishableKey: 'pk_test', frontendApi: FRONTEND, authHeaders: async () => ({}), fetchImpl });
    const c = await api.pendingPolicies({
      pending_policies: [{ policy: 'tos', title: 'Terms', display: 'checkbox', version_id: 'polv_1', version: '2', content_sha256: 'abc' }],
    });
    expect(c.policies[0]!.contentHtml).toBe('<p>Hello</p>');
    expect(c.policies[0]!.required).toBe(true);
  });

  it('the gate reads the standing and posts the acceptance with the bearer token', async () => {
    const { fetchImpl, calls } = fakeApi({
      'GET /v1/client/me/policies': () => ({ body: { data: [{ policy: 'tos', title: 'Terms', needs_reaccept: true, grace_ends_at: 1792800000000 }, { policy: 'privacy', needs_reaccept: false }] } }),
      'GET /v1/client/policies': () => ({ body: POLICIES }),
      'POST /v1/client/me/policies/accept': () => ({ body: {} }),
    });
    const api = createPolicyApi({
      publishableKey: 'pk_test',
      frontendApi: FRONTEND,
      authHeaders: async () => ({ Authorization: 'Bearer sess.jwt.1' }),
      fetchImpl,
    });
    const gate = api.policyGate();
    await gate.load();
    expect(gate.pending.map((p) => p.key)).toEqual(['tos']);
    const me = calls.find((c) => c.path === '/v1/client/me/policies')!;
    expect(me.headers.get('authorization')).toBe('Bearer sess.jwt.1');
    const controller = await gate.begin();
    expect(controller.policies.map((p) => p.key)).toEqual(['tos']);
    controller.setAllChecked(true);
    expect((await gate.accept(controller)).ok).toBe(true);
    const accept = calls.find((c) => c.path === '/v1/client/me/policies/accept')!;
    expect(accept.headers.get('authorization')).toBe('Bearer sess.jwt.1');
    expect(accept.body.policy_acceptances[0]).toMatchObject({ policy: 'tos', version_id: 'polv_1', content_sha256: 'abc' });
  });
});

describe('createAtlasCapacitor', () => {
  function prefsWithSession(): PreferencesPlugin {
    const map = new Map<string, string>([
      ['atlas.native_session', JSON.stringify({ sessionToken: 'persisted.jwt', refreshToken: 'refr_0', sessionId: 'sess_0', expiresInSeconds: 60 })],
    ]);
    return {
      get: async ({ key }) => ({ value: map.get(key) ?? null }),
      set: async ({ key, value }) => void map.set(key, value),
      remove: async ({ key }) => void map.delete(key),
    };
  }

  it('exposes the policy API, authenticated as the session', async () => {
    const { fetchImpl, calls } = fakeApi({ 'GET /v1/client/me/policies': () => ({ body: { data: [] } }) });
    const plugins = { Preferences: prefsWithSession() } as unknown as CapacitorPlugins;
    const atlas = await createAtlasCapacitor({
      publishableKey: 'pk_test',
      frontendApi: FRONTEND,
      plugins,
      fetchImpl,
      now: () => 1_000_000,
      locale: 'es',
    });
    expect(typeof atlas.policies).toBe('function');
    expect(typeof atlas.pendingPolicies).toBe('function');
    const gate = atlas.policyGate();
    await gate.load();
    const call = calls.find((c) => c.path === '/v1/client/me/policies')!;
    expect(call.headers.get('authorization')).toBe('Bearer persisted.jwt');
    expect(call.headers.get('accept-language')).toBe('es');
  });
});

describe('mountPolicyGate', () => {
  it('shows the banner, re-accepts through the step and disappears', async () => {
    let stale = true;
    const { fetchImpl, calls } = fakeApi({
      'GET /v1/client/me/policies': () => ({ body: { data: [{ policy: 'tos', title: 'Terms', needs_reaccept: stale, grace_ends_at: 1792800000000 }] } }),
      'GET /v1/client/policies': () => ({ body: POLICIES }),
      'POST /v1/client/me/policies/accept': () => {
        stale = false;
        return { body: {} };
      },
    });
    const api = createPolicyApi({ publishableKey: 'pk_test', frontendApi: FRONTEND, authHeaders: async () => ({}), fetchImpl });
    const host = document.createElement('div');
    document.body.append(host);
    const onAccepted = vi.fn();
    const mounted = mountPolicyGate(host, api.policyGate(), { onAccepted });
    await mounted.ready;
    expect(host.textContent).toContain('We have updated: Terms. Please review and accept.');
    expect(host.textContent).toContain('Accept by 2026-10-24 to keep your access.');

    host.querySelector<HTMLButtonElement>('[data-atlas-policy-banner] button')!.click();
    await vi.waitFor(() => expect(host.querySelector('[data-atlas-policy-continue]')).not.toBeNull());
    const box = host.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    host.querySelector<HTMLButtonElement>('[data-atlas-policy-continue]')!.click();
    await vi.waitFor(() => expect(onAccepted).toHaveBeenCalledOnce());
    expect(calls.some((c) => c.path === '/v1/client/me/policies/accept')).toBe(true);
    expect(host.querySelector('[data-atlas-policy-banner]')).toBeNull();
    mounted.destroy();
    expect(host.childElementCount).toBe(0);
  });

  it('draws nothing when nothing needs accepting', async () => {
    const { fetchImpl } = fakeApi({ 'GET /v1/client/me/policies': () => ({ body: { data: [{ policy: 'tos', needs_reaccept: false }] } }) });
    const api = createPolicyApi({ publishableKey: 'pk_test', frontendApi: FRONTEND, authHeaders: async () => ({}), fetchImpl });
    const host = document.createElement('div');
    document.body.append(host);
    const mounted = mountPolicyGate(host, api.policyGate());
    await mounted.ready;
    expect(host.querySelector('[data-atlas-policy-banner]')).toBeNull();
    mounted.destroy();
  });
});

describe('policyText', () => {
  it('falls back to English and applies overrides', () => {
    expect(policyText()('policy.accept')).toBe('Accept');
    expect(policyText({ 'policy.accept': 'Aceptar' })('policy.accept')).toBe('Aceptar');
  });
});
