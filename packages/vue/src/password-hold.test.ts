import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, shallowRef, type App } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ATLAS_INJECTION_KEY } from './context';
import type { AtlasClient, AuthStatus } from './plugin';
import { SignIn } from './components';
import { EN_US } from './i18n';
import type { AtlasOrganizationMembership, AtlasSession, AtlasUser, SessionClaims } from './types';

/**
 * A held password's refusal (`password_not_yet_usable`) offers the emailed proof even
 * where email code sign-in is off; it goes through the sign-up verification routes,
 * and proving it brings the password back with the "you can sign in" message.
 */

const FAPI = 'https://fapi.example';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
});

function makeClient(): AtlasClient {
  return {
    publishableKey: 'pk_test_x',
    frontendApi: FAPI,
    appearance: undefined,
    catalog: EN_US,
    status: shallowRef<AuthStatus>('signed_out'),
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

describe('<SignIn> password hold', () => {
  it('offers the emailed proof after the refusal, and proving it brings the password back', async () => {
    const posts: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (init?.method === 'POST') posts.push(path);
      if (path === '/v1/client/sign_ins') {
        return json({ id: 'sia_1', status: 'needs_first_factor', identifier: 'held@example.com', supported_first_factors: ['password'] }, 201);
      }
      if (path === '/v1/client/sign_ins/sia_1/attempt_first_factor') {
        return json({ errors: [{ code: 'password_not_yet_usable', message: 'Verify your email first.', meta: { verification_attempt_id: 'sua_9' } }] }, 403);
      }
      if (path === '/v1/client/sign_ups/sua_9/prepare_verification') return json({ identifier: 'held@example.com' });
        return json({});
      }),
    );
    const Host = defineComponent({ setup: () => () => h(SignIn) });
    const w = mount(Host, {
      attachTo: document.body,
      global: { plugins: [{ install: (app: App) => app.provide(ATLAS_INJECTION_KEY, makeClient()) }] },
    });
    wrapper = w;

    await w.find('input[name="identifier"]').setValue('held@example.com');
    await w.find('form').trigger('submit');
    await vi.waitFor(() => expect(w.find('input[name="password"]').exists()).toBe(true));
    expect(w.find('[data-strategy="email_code"]').exists()).toBe(false);

    await w.find('input[name="password"]').setValue('the-right-password');
    await w.find('form').trigger('submit');
    await vi.waitFor(() => expect(w.find('[data-strategy="email_code"]').exists()).toBe(true));

    await w.find('[data-strategy="email_code"]').trigger('click');
    await vi.waitFor(() => expect(posts).toContain('/v1/client/sign_ups/sua_9/prepare_verification'));
    expect(posts).not.toContain('/v1/client/sign_ins/sia_1/prepare_first_factor');

    await vi.waitFor(() => expect(w.find('input[name="code"]').exists()).toBe(true));
    await w.find('input[name="code"]').setValue('123456');
    await w.find('form').trigger('submit');
    await vi.waitFor(() => expect(posts).toContain('/v1/client/sign_ups/sua_9/attempt_verification'));
    await vi.waitFor(() => expect(w.find('[data-atlas-password-released]').exists()).toBe(true));
    expect(w.find('input[name="password"]').exists()).toBe(true);
  });
});
