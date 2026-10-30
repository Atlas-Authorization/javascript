import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, shallowRef, type App } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ATLAS_INJECTION_KEY } from './context';
import type { AtlasClient, AuthStatus } from './plugin';
import { SignIn } from './components';
import { EN_US } from './i18n';
import type { AtlasOrganizationMembership, AtlasSession, AtlasUser, SessionClaims } from './types';

/**
 * `<SignIn>` offers "Sign in with a passkey" when the instance turns passkey
 * sign-in on (`strategies.passkey` in /v1/appearance) and the browser has
 * WebAuthn; the button runs the usernameless ceremony starting at
 * /v1/client/sign_ins/passkey/begin, and the identifier field carries
 * `autocomplete="username webauthn"` for passkey autofill.
 */

const FAPI = 'https://fapi.example';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let posts: string[] = [];
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

async function flush() {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
    await nextTick();
  }
}

async function mountSignIn(passkey: boolean) {
  posts = [];
  // A WebAuthn-capable browser without conditional mediation (no autofill request to wait on).
  vi.stubGlobal('PublicKeyCredential', Object.assign(function PublicKeyCredential() {}, { isConditionalMediationAvailable: async () => false }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === 'POST') posts.push(path);
      if (path === '/v1/appearance') {
        return json({
          object: 'appearance',
          appearance: { legal: { termsUrl: null, privacyUrl: null, required: false }, signUpFields: [] },
          captchaFlows: {},
          strategies: { passkey },
        });
      }
      if (path === '/v1/client/sign_ins/passkey/begin') {
        return json({ errors: [{ code: 'PASSKEY_UNAVAILABLE', message: 'No passkey sign-in right now.' }] }, 400);
      }
      return json({});
    }),
  );
  const client = makeClient();
  const Host = defineComponent({ setup: () => () => h(SignIn) });
  wrapper = mount(Host, {
    attachTo: document.body,
    global: { plugins: [{ install: (app: App) => app.provide(ATLAS_INJECTION_KEY, client) }] },
  });
  await vi.waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0));
  await flush();
  return wrapper;
}

describe('<SignIn> passkey sign-in', () => {
  it('shows the button when the instance offers passkeys, and the button starts the ceremony', async () => {
    const w = await mountSignIn(true);
    await vi.waitFor(() => expect(w.find('[data-atlas-passkey-sign-in]').exists()).toBe(true));
    expect(w.find('[data-atlas-passkey-sign-in]').text()).toBe('Sign in with a passkey');
    expect(w.find('input[name="identifier"]').attributes('autocomplete')).toBe('username webauthn');

    await w.find('[data-atlas-passkey-sign-in]').trigger('click');
    await vi.waitFor(() => expect(posts).toContain('/v1/client/sign_ins/passkey/begin'));
    // The refusal shows on the form like any sign-in error.
    await vi.waitFor(() => expect(w.text()).toContain('No passkey sign-in right now.'));
  });

  it('has no button when passkey sign-in is off', async () => {
    const w = await mountSignIn(false);
    expect(w.find('input[name="identifier"]').exists()).toBe(true);
    expect(w.find('[data-atlas-passkey-sign-in]').exists()).toBe(false);
  });
});
