import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, shallowRef, type App, type Component } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ATLAS_INJECTION_KEY } from './context';
import type { AtlasClient, AuthStatus } from './plugin';
import { SignIn, SignUp } from './components';
import { PolicyGate } from './policies';
import { EN_US } from './i18n';
import type { AtlasOrganizationMembership, AtlasSession, AtlasUser, SessionClaims } from './types';

/** Policy acceptance in the Vue components: sign-up consent, scroll dialog, sign-in step, in-app gate. */

const FAPI = 'https://fapi.example';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}
type Route = (call: Call) => Response | undefined;

const wire = (over: Record<string, unknown> = {}) => ({
  key: 'tos',
  title: 'Terms of Service',
  display: 'checkbox',
  required: true,
  applies_to: 'sign_in_and_sign_up',
  version_id: 'polv_1',
  version: '1',
  content_html: '<p>Terms body</p>',
  content_sha256: 'sha_tos',
  effective_at: null,
  summary_of_changes: 'Retention changed.',
  ...over,
});

let calls: Call[] = [];
let wrapper: VueWrapper | null = null;
beforeEach(() => {
  calls = [];
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

function makeClient(status: AuthStatus): AtlasClient {
  return {
    publishableKey: 'pk_test_x',
    frontendApi: FAPI,
    appearance: undefined,
    catalog: EN_US,
    status: shallowRef<AuthStatus>(status),
    user: shallowRef<AtlasUser | null>(null),
    session: shallowRef<AtlasSession | null>(null),
    claims: shallowRef<SessionClaims | null>(null),
    memberships: shallowRef<AtlasOrganizationMembership[]>([]),
    pendingAttempt: null,
    getToken: async () => null,
    getProviderToken: async () => null,
    signOut: async () => ({ revoked: true }),
    setActiveOrganization: async () => undefined,
    endImpersonation: async () => ({ ended: false, resumed: false, status: 0 }),
    reload: async () => true,
    onSignOut: () => () => undefined,
  };
}

async function flush() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    await nextTick();
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function mountFlow(component: Component, routes: Route[], status: AuthStatus = 'signed_out') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const call: Call = {
        method: init?.method ?? 'GET',
        path: url.pathname,
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      };
      calls.push(call);
      if (call.path === '/v1/appearance') {
        return json({ object: 'appearance', appearance: { legal: { termsUrl: null, privacyUrl: null, required: false }, signUpFields: [] }, captchaFlows: {} });
      }
      for (const route of routes) {
        const res = route(call);
        if (res) return res;
      }
      return json({});
    }),
  );
  const client = makeClient(status);
  const Host = defineComponent({ setup: () => () => h(component) });
  wrapper = mount(Host, { attachTo: document.body, global: { plugins: [{ install: (app: App) => app.provide(ATLAS_INJECTION_KEY, client) }] } });
  await flush();
  return wrapper;
}

const policiesRoute = (list: unknown[]): Route => (c) => (c.method === 'GET' && c.path === '/v1/client/policies' ? json({ policies: list }) : undefined);
const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);

describe('<SignUp> with policies', () => {
  it('replaces the legacy row with the consent block, gates the button and posts policy_acceptances', async () => {
    const w = await mountFlow(SignUp, [
      policiesRoute([wire(), wire({ key: 'privacy', title: 'Privacy Policy', version_id: 'polv_2', content_sha256: 'sha_p' })]),
      (c) => (c.path === '/v1/client/sign_ups' ? json({ id: 'sua_1', status: 'needs_email_verification' }, 201) : undefined),
    ]);
    expect(w.text()).toContain('I agree to the Terms of Service and Privacy Policy');
    const button = w.find('button[type=submit]');
    expect((button.element as HTMLButtonElement).disabled).toBe(true);
    await w.find('input[name="email"]').setValue('new@example.com');
    await w.find('input[name="password"]').setValue('blue tangerine anvil 71!');
    (w.find('input[name="policies"]').element as HTMLInputElement).click();
    await flush();
    expect((w.find('button[type=submit]').element as HTMLButtonElement).disabled).toBe(false);
    await w.find('form').trigger('submit');
    await flush();
    expect(posts('/v1/client/sign_ups')[0]!.body!.policy_acceptances).toEqual([
      { policy: 'tos', version_id: 'polv_1', content_sha256: 'sha_tos', display: 'checkbox' },
      { policy: 'privacy', version_id: 'polv_2', content_sha256: 'sha_p', display: 'checkbox' },
    ]);
  });

  it('opens the unskippable dialog for a scroll policy on submit; Decline cancels', async () => {
    const w = await mountFlow(SignUp, [
      policiesRoute([wire({ display: 'scroll' })]),
      (c) => (c.path === '/v1/client/sign_ups' ? json({ id: 'sua_1', status: 'needs_email_verification' }, 201) : undefined),
    ]);
    await w.find('input[name="email"]').setValue('new@example.com');
    await w.find('input[name="password"]').setValue('blue tangerine anvil 71!');
    await w.find('form').trigger('submit');
    await flush();
    const dialog = document.querySelector('[role=dialog]') as HTMLElement;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    (document.querySelector('[data-atlas-policy-decline]') as HTMLElement).click();
    await flush();
    expect(document.querySelector('[role=dialog]')).toBeNull();
    expect(w.find('[data-atlas-policy-declined]').text()).toContain('Terms of Service');
    expect(posts('/v1/client/sign_ups')).toHaveLength(0);
    await w.find('form').trigger('submit');
    await flush();
    (document.querySelector('[data-atlas-policy-accept]') as HTMLElement).click();
    await flush();
    expect(posts('/v1/client/sign_ups')[0]!.body!.policy_acceptances).toEqual([
      expect.objectContaining({ policy: 'tos', version_id: 'polv_1', content_sha256: 'sha_tos', display: 'scroll', scrolled_to_end: true }),
    ]);
  });

  it('reloads the policies after POLICY_ACCEPTANCE_REQUIRED', async () => {
    let version = 'polv_1';
    const w = await mountFlow(SignUp, [
      (c) => (c.method === 'GET' && c.path === '/v1/client/policies' ? json({ policies: [wire({ version_id: version })] }) : undefined),
      (c) => {
        if (c.path !== '/v1/client/sign_ups') return undefined;
        version = 'polv_2';
        return json({ errors: [{ code: 'POLICY_ACCEPTANCE_REQUIRED', message: 'Accept the updated terms.' }] }, 422);
      },
    ]);
    await w.find('input[name="email"]').setValue('new@example.com');
    await w.find('input[name="password"]').setValue('blue tangerine anvil 71!');
    (w.find('input[name="policies"]').element as HTMLInputElement).click();
    await flush();
    await w.find('form').trigger('submit');
    await flush();
    expect(calls.filter((c) => c.path === '/v1/client/policies')).toHaveLength(2);
    expect((w.find('input[name="policies"]').element as HTMLInputElement).checked).toBe(false);
  });
});

describe('<SignIn> with needs_policy_acceptance', () => {
  it('shows the dialog (with what changed) and continues the attempt once accepted', async () => {
    const w = await mountFlow(SignIn, [
      policiesRoute([wire({ display: 'scroll' })]),
      (c) => (c.method === 'POST' && c.path === '/v1/client/sign_ins' ? json({ id: 'sia_1', status: 'needs_policy_acceptance', pending_policies: [{ key: 'tos', version_id: 'polv_1' }] }) : undefined),
      (c) => (c.path === '/v1/client/sign_ins/sia_1/accept_policies' ? json({ id: 'sia_1', status: 'needs_second_factor' }) : undefined),
    ]);
    await w.find('input[name="identifier"]').setValue('a@b.co');
    await w.find('form').trigger('submit');
    await flush();
    expect(document.querySelector('[role=dialog]')).not.toBeNull();
    expect(document.querySelector('[data-atlas-policy-summary]')!.textContent).toContain('Retention changed.');
    (document.querySelector('[data-atlas-policy-accept]') as HTMLElement).click();
    await flush();
    expect(posts('/v1/client/sign_ins/sia_1/accept_policies')[0]!.body).toEqual({
      policy_acceptances: [expect.objectContaining({ policy: 'tos', version_id: 'polv_1', content_sha256: 'sha_tos', display: 'scroll', scrolled_to_end: true })],
    });
    expect(w.find('input[name="code"]').exists()).toBe(true);
  });

  it('declining cancels the attempt and says why', async () => {
    const w = await mountFlow(SignIn, [
      policiesRoute([wire({ display: 'scroll' })]),
      (c) => (c.method === 'POST' && c.path === '/v1/client/sign_ins' ? json({ id: 'sia_1', status: 'needs_policy_acceptance', pending_policies: [{ key: 'tos', version_id: 'polv_1' }] }) : undefined),
    ]);
    await w.find('input[name="identifier"]').setValue('a@b.co');
    await w.find('form').trigger('submit');
    await flush();
    (document.querySelector('[data-atlas-policy-decline]') as HTMLElement).click();
    await flush();
    expect(w.find('input[name="identifier"]').exists()).toBe(true);
    expect(w.text()).toContain('You need to accept the Terms of Service');
  });
});

describe('<PolicyGate>', () => {
  it('shows a banner for a signed-in user whose policy needs re-acceptance and posts the acceptance', async () => {
    const Gate = defineComponent({ setup: () => () => h(PolicyGate, null, { default: () => h('span', { id: 'app' }, 'app') }) });
    const w = await mountFlow(
      Gate,
      [
        (c) =>
          c.method === 'GET' && c.path === '/v1/client/me/policies'
            ? json({ policies: [{ key: 'tos', title: 'Terms of Service', accepted_version: '1', current_version: '2', needs_reaccept: true, grace_ends_at: '2026-11-01T00:00:00Z' }] })
            : undefined,
        policiesRoute([wire({ display: 'scroll' })]),
        (c) => (c.path === '/v1/client/me/policies/accept' ? json({ ok: true }) : undefined),
      ],
      'signed_in',
    );
    expect(w.find('[data-atlas-policy-banner]').text()).toContain('Accept by 2026-11-01');
    expect(w.find('#app').exists()).toBe(true);
    await w.find('[data-atlas-policy-banner] button').trigger('click');
    await flush();
    (document.querySelector('[data-atlas-policy-accept]') as HTMLElement).click();
    await flush();
    expect(posts('/v1/client/me/policies/accept')).toHaveLength(1);
    expect(w.find('[data-atlas-policy-banner]').exists()).toBe(false);
  });
});
