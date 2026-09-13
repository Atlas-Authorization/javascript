import { describe, expect, it } from 'vitest';
import { defineComponent, h, nextTick, shallowRef, type App } from 'vue';
import { mount } from '@vue/test-utils';
import { ATLAS_INJECTION_KEY } from './context';
import type { AtlasClient, AuthStatus } from './plugin';
import { useAuth, useOrganization, useUser } from './composables';
import { EN_US } from './i18n';
import type { AtlasOrganizationMembership, AtlasSession, AtlasUser, SessionClaims } from './types';

/**
 * Composable tests drive a hand-built client so the reactive contract — a
 * `computed` that tracks the injected refs — is asserted directly, without the
 * `@atlasauth/js` network client in the loop.
 */

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

function withClient<T>(client: AtlasClient, run: () => T): { wrapper: ReturnType<typeof mount>; result: T } {
  let result!: T;
  const Probe = defineComponent({
    setup() {
      result = run();
      return () => h('div');
    },
  });
  const wrapper = mount(Probe, { global: { plugins: [provideClient(client)] } });
  return { wrapper, result };
}

describe('useUser', () => {
  it('tracks status and the injected user reactively', async () => {
    const client = makeClient();
    const { result } = withClient(client, () => useUser());

    expect(result.isLoaded.value).toBe(false);
    expect(result.isSignedIn.value).toBe(false);

    client.status.value = 'signed_in';
    client.user.value = { id: 'u1' } as AtlasUser;
    await nextTick();

    expect(result.isLoaded.value).toBe(true);
    expect(result.isSignedIn.value).toBe(true);
    expect(result.user.value?.id).toBe('u1');
  });
});

describe('useAuth', () => {
  it('reads ids off the live claims and evaluates has()', async () => {
    const client = makeClient();
    const { result } = withClient(client, () => useAuth());

    expect(result.userId.value).toBeNull();
    expect(result.has({ role: 'org:admin' })).toBe(false);

    client.status.value = 'signed_in';
    client.claims.value = {
      sub: 'u1',
      sid: 's1',
      exp: 0,
      org_id: 'org1',
      org_role: 'org:admin',
      org_permissions: ['org:billing:manage'],
    };
    await nextTick();

    expect(result.isSignedIn.value).toBe(true);
    expect(result.userId.value).toBe('u1');
    expect(result.sessionId.value).toBe('s1');
    expect(result.orgId.value).toBe('org1');
    expect(result.orgRole.value).toBe('org:admin');
    expect(result.has({ permission: 'org:billing:manage' })).toBe(true);
    expect(result.has({ permission: 'org:billing:read' })).toBe(false);
  });
});

describe('useOrganization', () => {
  it('resolves the active membership from the org_id claim', async () => {
    const client = makeClient();
    const membership: AtlasOrganizationMembership = {
      role: 'org:admin',
      organization: { id: 'org1', name: 'Acme', slug: 'acme', image_url: null },
    };
    const { result } = withClient(client, () => useOrganization());

    expect(result.organization.value).toBeNull();

    client.memberships.value = [membership];
    client.claims.value = { sub: 'u1', sid: 's1', exp: 0, org_id: 'org1' };
    await nextTick();

    expect(result.organization.value?.name).toBe('Acme');
    expect(result.membership.value?.role).toBe('org:admin');
  });
});
