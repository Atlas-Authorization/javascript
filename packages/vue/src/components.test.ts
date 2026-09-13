import { describe, expect, it } from 'vitest';
import { defineComponent, h, nextTick, shallowRef, type App, type VNode } from 'vue';
import { mount } from '@vue/test-utils';
import { ATLAS_INJECTION_KEY } from './context';
import type { AtlasClient, AuthStatus } from './plugin';
import * as sdk from './index';
import { AtlasLoaded, AtlasLoading, Protect, SignedIn, SignedOut } from './components';
import { EN_US } from './i18n';
import type { AtlasOrganizationMembership, AtlasSession, AtlasUser, SessionClaims } from './types';

function makeClient(): AtlasClient {
  return {
    publishableKey: 'pk_test',
    frontendApi: '',
    appearance: undefined,
    catalog: EN_US,
    status: shallowRef<AuthStatus>('loading'),
    user: shallowRef<AtlasUser | null>(null),
    session: shallowRef<AtlasSession | null>(null),
    claims: shallowRef<SessionClaims | null>(null),
    memberships: shallowRef<AtlasOrganizationMembership[]>([]),
    pendingAttempt: null,
    getToken: async () => null,
    getProviderToken: async () => null,
    signOut: async () => undefined,
    setActiveOrganization: async () => undefined,
    reload: async () => undefined,
  };
}

const provideClient = (client: AtlasClient) => ({
  install: (app: App) => app.provide(ATLAS_INJECTION_KEY, client),
});

function mountWith(client: AtlasClient, render: () => VNode) {
  const Host = defineComponent({ setup: () => render });
  return mount(Host, { global: { plugins: [provideClient(client)] } });
}

describe('the public API is Atlas-branded', () => {
  it('leaks no competitor name into any export', () => {
    const offenders = Object.keys(sdk).filter((name) => /clerk|auth0|okta|firebase/i.test(name));
    expect(offenders).toEqual([]);
  });
});

describe('the documented components and composables are all exported', () => {
  it('ships every §10.2 surface as a value', () => {
    for (const name of [
      'createAtlas',
      'SignIn',
      'SignUp',
      'UserButton',
      'UserProfile',
      'OrganizationSwitcher',
      'OrganizationProfile',
      'SignedIn',
      'SignedOut',
      'Protect',
      'AtlasLoading',
      'AtlasLoaded',
      'useAtlas',
      'useUser',
      'useSession',
      'useAuth',
      'useOrganization',
      'useSignIn',
      'useSignUp',
    ]) {
      expect((sdk as Record<string, unknown>)[name], `${name} export`).toBeTruthy();
    }
  });
});

describe('SignedIn / SignedOut gate on opposite sides of the session', () => {
  it('flips as status moves loading -> signed_out -> signed_in', async () => {
    const client = makeClient();
    const wrapper = mountWith(client, () =>
      h('div', [
        h(SignedIn, () => h('span', { class: 'in' }, 'in')),
        h(SignedOut, () => h('span', { class: 'out' }, 'out')),
      ]),
    );

    // loading: neither branch renders.
    expect(wrapper.find('.in').exists()).toBe(false);
    expect(wrapper.find('.out').exists()).toBe(false);

    client.status.value = 'signed_out';
    await nextTick();
    expect(wrapper.find('.out').exists()).toBe(true);
    expect(wrapper.find('.in').exists()).toBe(false);

    client.status.value = 'signed_in';
    await nextTick();
    expect(wrapper.find('.in').exists()).toBe(true);
    expect(wrapper.find('.out').exists()).toBe(false);
  });
});

describe('AtlasLoading / AtlasLoaded are exact inverses', () => {
  it('shows loading children only while loading', async () => {
    const client = makeClient();
    const wrapper = mountWith(client, () =>
      h('div', [
        h(AtlasLoading, () => h('span', { class: 'spin' }, '…')),
        h(AtlasLoaded, () => h('span', { class: 'ready' }, 'ready')),
      ]),
    );

    expect(wrapper.find('.spin').exists()).toBe(true);
    expect(wrapper.find('.ready').exists()).toBe(false);

    client.status.value = 'signed_out';
    await nextTick();
    expect(wrapper.find('.spin').exists()).toBe(false);
    expect(wrapper.find('.ready').exists()).toBe(true);
  });
});

describe('Protect renders on the permission and falls back otherwise', () => {
  it('shows the guarded slot only when the claim grants it', async () => {
    const client = makeClient();
    client.status.value = 'signed_in';
    const wrapper = mountWith(client, () =>
      h(
        Protect,
        { permission: 'org:billing:manage' },
        {
          default: () => h('span', { class: 'ok' }, 'manage'),
          fallback: () => h('span', { class: 'no' }, 'denied'),
        },
      ),
    );

    // No org claims yet: the fallback shows.
    expect(wrapper.find('.ok').exists()).toBe(false);
    expect(wrapper.find('.no').exists()).toBe(true);

    client.claims.value = {
      sub: 'u1',
      sid: 's1',
      exp: 0,
      org_id: 'org1',
      org_role: 'org:admin',
      org_permissions: ['org:billing:manage'],
    };
    await nextTick();

    expect(wrapper.find('.ok').exists()).toBe(true);
    expect(wrapper.find('.no').exists()).toBe(false);
  });
});
