// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtlasProvider } from './AtlasProvider';
import { OrganizationProfile } from './organization';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * `<OrganizationProfile/>` drives the organization self-management routes:
 * members (role change, remove), invitations (invite, revoke, resend) and
 * settings (leave). Admin controls appear only with the members-manage
 * permission on the token.
 */

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (claims: Record<string, unknown>) =>
  `${b64({ alg: 'none' })}.${b64({ sid: 'sess_1', sub: 'user_1', exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}.sig`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ADMIN = { org_id: 'org_1', org_role: 'org:admin', org_permissions: ['org:sys_memberships:manage', 'org:sys_memberships:read'] };
const MEMBER = { org_id: 'org_1', org_role: 'org:member', org_permissions: ['org:sys_memberships:read'] };

const MEMBERS = [
  { object: 'organization_membership', id: 'm1', role: 'org:admin', user: { id: 'user_1', first_name: 'Me', last_name: null, image_url: null } },
  { object: 'organization_membership', id: 'm2', role: 'org:member', user: { id: 'user_2', first_name: 'Bo', last_name: 'Lee', image_url: null } },
];
const ROLES = [
  { object: 'role', key: 'org:admin', name: 'Admin', description: null },
  { object: 'role', key: 'org:member', name: 'Member', description: null },
  { object: 'role', id: 'role_aud', key: 'org:auditor', name: 'Auditor', description: null, organization_id: 'org_1', permissions: ['org:sys_memberships:read'] },
];
const PERMISSIONS = [
  { object: 'permission', key: 'org:sys_memberships:read', name: 'Read members', description: null },
  { object: 'permission', key: 'org:sys_memberships:manage', name: 'Manage members', description: null },
];
const INVITE = { object: 'organization_invitation', id: 'inv_1', email_address: 'x@y.co', role: 'org:member', status: 'pending' };

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function mount(claims: Record<string, unknown>) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/v1/client')) {
      return json({
        session: { id: 'sess_1', status: 'active' },
        user: { id: 'user_1' },
        jwt: jwt(claims),
        organization_memberships: [
          { role: claims.org_role, organization: { id: 'org_1', name: 'Acme', slug: 'acme', image_url: null } },
        ],
      });
    }
    if (url.includes('/memberships?')) return json({ object: 'list', data: MEMBERS, total_count: 2, has_more: false });
    if (method === 'GET' && url.endsWith('/roles')) return json({ object: 'list', data: ROLES, has_more: false });
    if (url.endsWith('/permissions')) return json({ object: 'list', data: PERMISSIONS, has_more: false });
    if (method === 'POST' && url.endsWith('/roles')) return json({ object: 'role', id: 'role_new', key: 'org:viewer', name: 'Viewer' }, 201);
    if (url.includes('/invitations?')) return json({ object: 'list', data: [INVITE], has_more: false });
    if (method === 'POST' && url.endsWith('/invitations')) return json({ ...INVITE, id: 'inv_2' }, 201);
    return json({ ok: true });
  }) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchImpl);

  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(
      createElement(AtlasProvider, {
        publishableKey: 'pk_test_x',
        frontendApi: 'https://fapi.example',
        fetchImpl,
        appearance: { instanceDesign: false },
        children: createElement(OrganizationProfile),
      }),
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  unmount = () => act(() => root.unmount());
  return { el, calls };
}

const button = (el: HTMLElement, label: string) => {
  const found = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no button "${label}" in: ${el.innerHTML}`);
  return found;
};
async function click(target: HTMLElement) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('<OrganizationProfile/>', () => {
  it('an admin sees members with role and remove controls (not for themselves)', async () => {
    const { el, calls } = await mount(ADMIN);
    const rows = el.querySelectorAll('[data-atlas="organization-member"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector('select')).toBeNull();
    expect(rows[1]!.querySelector('select')).not.toBeNull();

    await click(button(el, 'Remove'));
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/v1/client/organizations/org_1/memberships/user_2'))).toBe(true);

    const select = rows[1]!.querySelector('select')!;
    await act(async () => {
      select.value = 'org:admin';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.url).toMatch(/memberships\/user_2$/);
    expect(patch?.body).toEqual({ role: 'org:admin' });
  });

  it('invites, resends and revokes from the invitations tab (the Invite button is wired)', async () => {
    const { el, calls } = await mount(ADMIN);
    await click(button(el, 'Invitations'));
    expect(el.querySelectorAll('[data-atlas="organization-invitation"]')).toHaveLength(1);

    const input = el.querySelector('input[type="email"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'new@y.co');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button(el, 'Send invitation'));
    const invite = calls.find((c) => c.method === 'POST' && c.url.endsWith('/v1/client/organizations/org_1/invitations'));
    expect(invite?.body).toEqual({ email_address: 'new@y.co', role: 'org:member' });

    await click(button(el, 'Resend'));
    await click(button(el, 'Revoke'));
    expect(calls.some((c) => c.url.endsWith('/invitations/inv_1/resend'))).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/invitations/inv_1/revoke'))).toBe(true);
  });

  it('a member sees no admin controls and can leave after confirming', async () => {
    const { el, calls } = await mount(MEMBER);
    expect(el.querySelector('select')).toBeNull();
    expect([...el.querySelectorAll('button')].some((b) => b.textContent === 'Invitations')).toBe(false);
    expect(calls.some((c) => c.url.includes('/invitations'))).toBe(false);

    await click(button(el, 'Settings'));
    expect([...el.querySelectorAll('button')].some((b) => b.textContent === 'Delete organization')).toBe(false);
    await click(button(el, 'Leave organization'));
    await click(button(el, 'Confirm'));
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/v1/client/me/organizations/org_1/membership'))).toBe(true);
  });

  it('an admin creates, edits and deletes the organization\'s own roles; custom roles are in the role picker', async () => {
    const { el, calls } = await mount(ADMIN);
    // The custom role is offered in the member role picker.
    const options = [...el.querySelectorAll('[data-atlas="organization-member"] select option')].map((o) => o.getAttribute('value'));
    expect(options).toContain('org:auditor');

    await click(button(el, 'Roles'));
    const rows = el.querySelectorAll('[data-atlas="organization-role"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('org:auditor');

    const setValue = async (input: HTMLInputElement, value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    await setValue(el.querySelector('input[name="role_key"]') as HTMLInputElement, 'org:viewer');
    await setValue(el.querySelector('input[name="role_name"]') as HTMLInputElement, 'Viewer');
    await click(el.querySelectorAll('[data-atlas="organization-role-permission"] input')[0] as HTMLElement);
    await click(button(el, 'Create role'));
    const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/v1/client/organizations/org_1/roles'));
    expect(create?.body).toEqual({ key: 'org:viewer', name: 'Viewer', permissions: ['org:sys_memberships:read'] });

    await click(button(el, 'Edit'));
    expect(el.querySelector('input[name="role_key"]')).toBeNull();
    await click(el.querySelectorAll('[data-atlas="organization-role-permission"] input')[1] as HTMLElement);
    await click(button(el, 'Save role'));
    const patch = calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/roles/role_aud'));
    expect(patch?.body).toEqual({ name: 'Auditor', permissions: ['org:sys_memberships:read', 'org:sys_memberships:manage'] });

    await click(button(el, 'Delete'));
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/v1/client/organizations/org_1/roles/role_aud'))).toBe(true);
  });

  it('a member sees no Roles tab and loads no permissions', async () => {
    const { el, calls } = await mount(MEMBER);
    expect([...el.querySelectorAll('button')].some((b) => b.textContent === 'Roles')).toBe(false);
    expect(calls.some((c) => c.url.endsWith('/permissions'))).toBe(false);
  });
});
