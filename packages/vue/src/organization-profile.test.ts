// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, shallowRef, type App } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { ATLAS_INJECTION_KEY } from './context';
import type { AtlasClient, AuthStatus } from './plugin';
import { OrganizationProfile } from './components';
import { EN_US } from './i18n';
import type { AtlasOrganizationMembership, AtlasSession, AtlasUser, SessionClaims } from './types';

/** `<OrganizationProfile>` (Vue) drives the organization self-management routes. */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const MEMBERS = [
  { object: 'organization_membership', id: 'm1', role: 'org:admin', user: { id: 'user_1', first_name: 'Me', last_name: null, image_url: null } },
  { object: 'organization_membership', id: 'm2', role: 'org:member', user: { id: 'user_2', first_name: 'Bo', last_name: null, image_url: null } },
];

function client(claims: SessionClaims): AtlasClient {
  return {
    publishableKey: 'pk_test',
    frontendApi: 'https://fapi.example',
    appearance: undefined,
    catalog: EN_US,
    status: shallowRef<AuthStatus>('signed_in'),
    user: shallowRef<AtlasUser | null>(null),
    session: shallowRef<AtlasSession | null>(null),
    claims: shallowRef<SessionClaims | null>(claims),
    memberships: shallowRef<AtlasOrganizationMembership[]>([
      { role: String(claims.org_role), organization: { id: 'org_1', name: 'Acme', slug: 'acme', image_url: null } },
    ]),
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

afterEach(() => vi.unstubAllGlobals());

async function render(claims: SessionClaims) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes('/memberships?')) return json({ object: 'list', data: MEMBERS, total_count: 2, has_more: false });
      const method = init.method ?? 'GET';
      if (method === 'GET' && url.endsWith('/roles'))
        return json({
          object: 'list',
          data: [
            { object: 'role', key: 'org:member', name: 'Member', description: null },
            { object: 'role', id: 'role_aud', key: 'org:auditor', name: 'Auditor', description: null, organization_id: 'org_1', permissions: [] },
          ],
        });
      if (url.endsWith('/permissions'))
        return json({ object: 'list', data: [{ object: 'permission', key: 'org:sys_memberships:read', name: 'Read members', description: null }] });
      if (url.includes('/invitations?')) return json({ object: 'list', data: [], has_more: false });
      return json({ ok: true });
    }),
  );
  const c = client(claims);
  const Host = defineComponent({ setup: () => () => h(OrganizationProfile) });
  const wrapper = mount(Host, {
    global: { plugins: [{ install: (app: App) => app.provide(ATLAS_INJECTION_KEY, c) }] },
  });
  await flushPromises();
  await nextTick();
  return { wrapper, calls };
}

describe('<OrganizationProfile> (Vue)', () => {
  it('an admin removes a member and sends an invitation', async () => {
    const { wrapper, calls } = await render({
      sub: 'user_1',
      org_id: 'org_1',
      org_role: 'org:admin',
      org_permissions: ['org:sys_memberships:manage'],
    } as unknown as SessionClaims);
    expect(wrapper.findAll('[data-atlas="organization-member"]')).toHaveLength(2);
    const remove = wrapper.findAll('button').find((b) => b.text() === 'Remove')!;
    await remove.trigger('click');
    await flushPromises();
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/memberships/user_2'))).toBe(true);

    await wrapper.findAll('button').find((b) => b.text() === 'Invitations')!.trigger('click');
    await wrapper.find('input[type="email"]').setValue('new@y.co');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    const invite = calls.find((c) => c.method === 'POST' && c.url.endsWith('/organizations/org_1/invitations'));
    expect(invite?.body).toEqual({ email_address: 'new@y.co', role: 'org:member' });
  });

  it('a member sees no admin controls', async () => {
    const { wrapper } = await render({ sub: 'user_2', org_id: 'org_1', org_role: 'org:member', org_permissions: [] } as unknown as SessionClaims);
    expect(wrapper.find('select').exists()).toBe(false);
    expect(wrapper.findAll('button').some((b) => b.text() === 'Invitations')).toBe(false);
  });

  it('an admin creates and deletes custom roles; they are in the role picker', async () => {
    const { wrapper, calls } = await render({
      sub: 'user_1',
      org_id: 'org_1',
      org_role: 'org:admin',
      org_permissions: ['org:sys_memberships:manage', 'org:sys_memberships:read'],
    } as unknown as SessionClaims);
    const options = wrapper.findAll('[data-atlas="organization-member"] select option').map((o) => o.attributes('value'));
    expect(options).toContain('org:auditor');

    await wrapper.findAll('button').find((b) => b.text() === 'Roles')!.trigger('click');
    expect(wrapper.findAll('[data-atlas="organization-role"]')).toHaveLength(1);
    await wrapper.find('input[name="role_key"]').setValue('org:viewer');
    await wrapper.find('input[name="role_name"]').setValue('Viewer');
    await wrapper.find('[data-atlas="organization-role-permission"] input').setValue(true);
    await wrapper.find('[data-atlas="organization-role-form"]').trigger('submit');
    await flushPromises();
    const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/organizations/org_1/roles'));
    expect(create?.body).toEqual({ key: 'org:viewer', name: 'Viewer', permissions: ['org:sys_memberships:read'] });

    await wrapper.findAll('button').find((b) => b.text() === 'Delete')!.trigger('click');
    await flushPromises();
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/organizations/org_1/roles/role_aud'))).toBe(true);
  });
});
