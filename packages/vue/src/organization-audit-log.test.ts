import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, shallowRef, type App } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { ATLAS_INJECTION_KEY } from './context';
import type { AtlasClient, AuthStatus } from './plugin';
import { OrganizationAuditLog } from './components';
import { EN_US } from './i18n';
import type { AtlasOrganizationMembership, AtlasSession, AtlasUser, SessionClaims } from './types';

const ORG: AtlasOrganizationMembership = {
  role: 'org:admin',
  organization: { id: 'org_1', name: 'Acme', slug: 'acme', image_url: null },
};

function signedInClient(): AtlasClient {
  return {
    publishableKey: 'pk_test',
    frontendApi: 'https://fapi.example',
    appearance: undefined,
    catalog: EN_US,
    status: shallowRef<AuthStatus>('signed_in'),
    user: shallowRef<AtlasUser | null>(null),
    session: shallowRef<AtlasSession | null>(null),
    claims: shallowRef<SessionClaims | null>({ sub: 'user_1', sid: 'sess_1', exp: 0, org_id: 'org_1' }),
    memberships: shallowRef<AtlasOrganizationMembership[]>([ORG]),
    pendingAttempt: null,
    getToken: async () => null,
    getProviderToken: async () => null,
    signOut: async () => ({ revoked: true }),
    setActiveOrganization: async () => undefined,
    reload: async () => true,
    endImpersonation: async () => ({ ended: false, resumed: false, status: 0 }),
    onSignOut: () => () => undefined,
  };
}

const entry = (id: string, action: string) => ({
  object: 'audit_log',
  id,
  action,
  actor: { type: 'user', id: 'user_1' },
  target: { type: null, id: null },
  organization_id: 'org_1',
  ip: null,
  user_agent: null,
  metadata: {},
  created_at: 1_700_000_000_000,
});

function stubFetch(handler: (url: string) => { status: number; body: unknown }) {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const { status, body } = handler(url);
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  return urls;
}

const mountLog = (client: AtlasClient, props: Record<string, unknown> = {}) =>
  mount(defineComponent({ setup: () => () => h(OrganizationAuditLog, props) }), {
    global: { plugins: [{ install: (app: App) => app.provide(ATLAS_INJECTION_KEY, client) }] },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('<OrganizationAuditLog/> (Vue)', () => {
  it("lists the active organization's entries and pages with Load more", async () => {
    const urls = stubFetch((url) =>
      url.includes('starting_after')
        ? { status: 200, body: { data: [entry('aud_3', 'organization.updated')], has_more: false, next_cursor: null } }
        : {
            status: 200,
            body: {
              data: [entry('aud_1', 'organization_invitation.created'), entry('aud_2', 'organization_membership.created')],
              has_more: true,
              next_cursor: 'aud_2',
            },
          },
    );
    const wrapper = mountLog(signedInClient(), { pageSize: 2, labels: { title: 'Activity' } });
    await flushPromises();
    expect(urls[0]).toBe('https://fapi.example/v1/client/organizations/org_1/audit_logs?limit=2');
    expect(wrapper.find('h2').text()).toBe('Activity');
    expect(wrapper.findAll('li').map((li) => li.attributes('data-action'))).toEqual([
      'organization_invitation.created',
      'organization_membership.created',
    ]);
    expect(wrapper.find('li strong').text()).toBe('Organization invitation created');
    await wrapper.find('button').trigger('click');
    await flushPromises();
    expect(urls[1]).toContain('starting_after=aud_2');
    expect(wrapper.findAll('li')).toHaveLength(3);
    expect(wrapper.find('button').exists()).toBe(false);
  });

  it('renders nothing for a member who may not read the log', async () => {
    stubFetch(() => ({ status: 403, body: { errors: [{ code: 'FORBIDDEN', message: 'no' }] } }));
    const wrapper = mountLog(signedInClient());
    await flushPromises();
    expect(wrapper.find('[data-atlas="organization-audit-log"]').exists()).toBe(false);
  });

  it('follows the active organization', async () => {
    const urls = stubFetch(() => ({ status: 200, body: { data: [], has_more: false, next_cursor: null } }));
    const client = signedInClient();
    const wrapper = mountLog(client);
    await flushPromises();
    expect(wrapper.find('p').text()).toBe('No activity recorded yet.');
    client.memberships.value = [
      ORG,
      { role: 'org:admin', organization: { id: 'org_2', name: 'Beta', slug: 'beta', image_url: null } },
    ];
    client.claims.value = { sub: 'user_1', sid: 'sess_1', exp: 0, org_id: 'org_2' };
    await nextTick();
    await flushPromises();
    expect(urls.at(-1)).toContain('/organizations/org_2/audit_logs');
  });
});
