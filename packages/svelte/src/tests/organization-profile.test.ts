import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { ATLAS_KEY, createAtlasClient } from '../lib/context';
import OrganizationProfile from '../lib/components/OrganizationProfile.svelte';

/**
 * `<OrganizationProfile>` (Svelte) against a scripted Frontend API: members
 * (role change, remove), invitations (invite, revoke, resend), settings
 * (leave), and the organization's own custom roles (create, edit, delete).
 * Admin controls appear only with the members-manage permission on the token.
 */
vi.mock('@atlasauth/js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@atlasauth/js')>();
  return { ...actual, readRedirectResult: () => null };
});

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (claims: Record<string, unknown>) =>
  `${b64({ alg: 'none' })}.${b64({ sid: 'sess_1', exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}.sig`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ADMIN = { sub: 'user_1', org_id: 'org_1', org_role: 'org:admin', org_permissions: ['org:sys_memberships:manage', 'org:sys_memberships:read'] };
const MEMBER = { sub: 'user_2', org_id: 'org_1', org_role: 'org:member', org_permissions: ['org:sys_memberships:read'] };

const MEMBERS = [
  { object: 'organization_membership', id: 'm1', role: 'org:admin', user: { id: 'user_1', first_name: 'Me', last_name: null, image_url: null } },
  { object: 'organization_membership', id: 'm2', role: 'org:member', user: { id: 'user_2', first_name: 'Bo', last_name: 'Lee', image_url: null } },
];
const ROLES = [
  { object: 'role', key: 'org:admin', name: 'Admin', description: null, organization_id: null },
  { object: 'role', key: 'org:member', name: 'Member', description: null, organization_id: null },
  { object: 'role', id: 'role_aud', key: 'org:auditor', name: 'Auditor', description: null, organization_id: 'org_1', permissions: ['org:sys_memberships:read'] },
];
const PERMISSIONS = [
  { object: 'permission', key: 'org:sys_memberships:read', name: 'Read members', description: null },
  { object: 'permission', key: 'org:sys_memberships:manage', name: 'Manage members', description: null },
];
const INVITE = { object: 'organization_invitation', id: 'inv_1', email_address: 'x@y.co', role: 'org:member', status: 'pending' };

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function setup(claims: Record<string, unknown>) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/v1/client')) {
      return json({
        session: { id: 'sess_1', status: 'active', last_active_organization_id: 'org_1' },
        user: { id: claims.sub, first_name: 'Me' },
        jwt: jwt(claims),
        organization_memberships: [
          { role: claims.org_role, organization: { id: 'org_1', name: 'Acme', slug: 'acme', image_url: null } },
        ],
      });
    }
    if (url.includes('/memberships?')) return json({ object: 'list', data: MEMBERS, total_count: 2, has_more: false });
    if (method === 'GET' && url.endsWith('/roles')) return json({ object: 'list', data: ROLES, has_more: false });
    if (url.endsWith('/permissions')) return json({ object: 'list', data: PERMISSIONS, has_more: false });
    if (url.includes('/invitations?')) return json({ object: 'list', data: [INVITE], has_more: false });
    if (method === 'POST' && url.endsWith('/invitations')) return json({ ...INVITE, id: 'inv_2' }, 201);
    if (method === 'POST' && url.endsWith('/roles')) return json({ object: 'role', id: 'role_new', key: 'org:viewer', name: 'Viewer' }, 201);
    return json({ ok: true });
  }) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchImpl);
  const client = createAtlasClient({ publishableKey: 'pk_test', frontendApi: 'https://fapi.example', fetchImpl, manualBoot: true });
  await client.reload();
  const view = render(OrganizationProfile, { context: new Map([[ATLAS_KEY, client]]) });
  await waitFor(() => expect(view.container.querySelectorAll('[data-atlas="organization-member"]')).toHaveLength(2));
  return { ...view, calls };
}

const byText = (root: HTMLElement, text: string) => {
  const found = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no button "${text}"`);
  return found;
};

describe('<OrganizationProfile> (Svelte)', () => {
  it('an admin changes a role and removes a member (never themselves)', async () => {
    const { container, calls } = await setup(ADMIN);
    const rows = container.querySelectorAll('[data-atlas="organization-member"]');
    expect(rows[0]!.querySelector('select')).toBeNull();
    const select = rows[1]!.querySelector('select') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toContain('org:auditor');

    select.value = 'org:admin';
    await fireEvent.change(select);
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.url).toMatch(/memberships\/user_2$/);
    expect(patch?.body).toEqual({ role: 'org:admin' });

    await fireEvent.click(byText(container, 'Remove'));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/v1/client/organizations/org_1/memberships/user_2'))).toBe(true),
    );
  });

  it('invites, resends and revokes from the invitations tab', async () => {
    const { container, calls } = await setup(ADMIN);
    await fireEvent.click(byText(container, 'Invitations'));
    await waitFor(() => expect(container.querySelectorAll('[data-atlas="organization-invitation"]')).toHaveLength(1));
    const input = container.querySelector('input[type="email"]') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'new@y.co' } });
    await fireEvent.click(byText(container, 'Send invitation'));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/v1/client/organizations/org_1/invitations'))?.body).toEqual({
        email_address: 'new@y.co',
        role: 'org:member',
      }),
    );
    await fireEvent.click(byText(container, 'Resend'));
    await fireEvent.click(byText(container, 'Revoke'));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/invitations/inv_1/revoke'))).toBe(true));
    expect(calls.some((c) => c.url.endsWith('/invitations/inv_1/resend'))).toBe(true);
  });

  it('a member sees no admin controls and leaves after confirming', async () => {
    const { container, calls } = await setup(MEMBER);
    expect(container.querySelector('select')).toBeNull();
    expect([...container.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Invitations')).toBe(false);
    expect([...container.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Roles')).toBe(false);
    expect(calls.some((c) => c.url.includes('/invitations') || c.url.endsWith('/permissions'))).toBe(false);

    await fireEvent.click(byText(container, 'Settings'));
    expect([...container.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Delete organization')).toBe(false);
    await fireEvent.click(byText(container, 'Leave organization'));
    await fireEvent.click(byText(container, 'Confirm'));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/v1/client/me/organizations/org_1/membership'))).toBe(true),
    );
  });

  it('an admin creates, edits and deletes the organization\'s own roles', async () => {
    const { container, calls } = await setup(ADMIN);
    await fireEvent.click(byText(container, 'Roles'));
    await waitFor(() => expect(container.querySelectorAll('[data-atlas="organization-role"]')).toHaveLength(1));

    await fireEvent.input(container.querySelector('input[name="role_key"]')!, { target: { value: 'org:viewer' } });
    await fireEvent.input(container.querySelector('input[name="role_name"]')!, { target: { value: 'Viewer' } });
    const boxes = () => container.querySelectorAll('[data-atlas="organization-role-permission"] input');
    await fireEvent.click(boxes()[0]!);
    await fireEvent.click(byText(container, 'Create role'));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/v1/client/organizations/org_1/roles'))?.body).toEqual({
        key: 'org:viewer',
        name: 'Viewer',
        permissions: ['org:sys_memberships:read'],
      }),
    );
    // The create finished (reload done, form reset) before editing.
    await waitFor(() => expect((container.querySelector('input[name="role_key"]') as HTMLInputElement).value).toBe(''));
    await waitFor(() => expect(byText(container, 'Edit')).toBeTruthy());

    await fireEvent.click(byText(container, 'Edit'));
    expect(container.querySelector('input[name="role_key"]')).toBeNull();
    await fireEvent.click(boxes()[1]!);
    await waitFor(() => expect(byText(container, 'Save role')).not.toBeDisabled());
    await fireEvent.click(byText(container, 'Save role'));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/roles/role_aud'))?.body).toEqual({
        name: 'Auditor',
        permissions: ['org:sys_memberships:read', 'org:sys_memberships:manage'],
      }),
    );

    await fireEvent.click(byText(container, 'Delete'));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/v1/client/organizations/org_1/roles/role_aud'))).toBe(true),
    );
  });
});
