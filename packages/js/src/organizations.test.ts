import { describe, expect, it } from 'vitest';
import type { FapiClient, FapiResponse } from './fapi';
import {
  OrganizationProfileController,
  OrganizationRequestError,
  checkOrganizationSlug,
  createOrganizationRole,
  deleteOrganization,
  deleteOrganizationRole,
  listAssignablePermissions,
  updateOrganizationRole,
  inviteMember,
  leaveOrganization,
  listOrganizationMembers,
  listOrganizationRoles,
  resendInvitation,
  revokeInvitation,
  updateMemberRole,
} from './organizations';

type Handler = (path: string, init: RequestInit) => FapiResponse<unknown>;

function fakeClient(handler: Handler) {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const client = {
    async request<T>(path: string, init: RequestInit = {}): Promise<FapiResponse<T>> {
      calls.push({ path, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
      return handler(path, init) as FapiResponse<T>;
    },
  } as unknown as FapiClient;
  return { client, calls };
}

const ok = (data: unknown): FapiResponse<unknown> => ({ ok: true, status: 200, data, errors: [] });
const fail = (status: number, code: string): FapiResponse<unknown> => ({
  ok: false,
  status,
  data: null,
  errors: [{ code, message: code }],
});

describe('organization calls', () => {
  it('hit the right paths with the right bodies', async () => {
    const { client, calls } = fakeClient(() => ok({ object: 'list', data: [], has_more: false, total_count: 0 }));
    await listOrganizationMembers(client, 'org_1', { limit: 10, offset: 20 });
    await updateMemberRole(client, 'org_1', 'user_2', 'org:admin');
    await inviteMember(client, 'org_1', { emailAddress: 'a@b.co', role: 'org:member' });
    await revokeInvitation(client, 'org_1', 'inv_1');
    await resendInvitation(client, 'org_1', 'inv_1');
    await leaveOrganization(client, 'org_1');
    await deleteOrganization(client, 'org_1');
    await checkOrganizationSlug(client, 'acme co');
    await listOrganizationRoles(client, 'org_1');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /v1/client/organizations/org_1/memberships?limit=10&offset=20',
      'PATCH /v1/client/organizations/org_1/memberships/user_2',
      'POST /v1/client/organizations/org_1/invitations',
      'POST /v1/client/organizations/org_1/invitations/inv_1/revoke',
      'POST /v1/client/organizations/org_1/invitations/inv_1/resend',
      'DELETE /v1/client/me/organizations/org_1/membership',
      'DELETE /v1/client/organizations/org_1',
      'GET /v1/client/organizations/check_slug?slug=acme%20co',
      'GET /v1/client/organizations/org_1/roles',
    ]);
    expect(calls[1]!.body).toEqual({ role: 'org:admin' });
    expect(calls[2]!.body).toEqual({ email_address: 'a@b.co', role: 'org:member' });
  });

  it('a refusal throws a typed error; STEP_UP_REQUIRED reads as needsReverification', async () => {
    const { client } = fakeClient(() => fail(403, 'STEP_UP_REQUIRED'));
    const err = await deleteOrganization(client, 'org_1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrganizationRequestError);
    expect((err as OrganizationRequestError).needsReverification).toBe(true);
    expect((err as OrganizationRequestError).status).toBe(403);
  });
});

describe('OrganizationProfileController', () => {
  const member = { object: 'organization_membership', id: 'mem_1', role: 'org:member', user: { id: 'user_2', first_name: 'Ada', last_name: null, image_url: null } };
  const invitation = { object: 'organization_invitation', id: 'inv_1', email_address: 'x@y.co', role: 'org:member', status: 'pending' };

  it('loads members, roles and (for admins) invitations, and reloads after an action', async () => {
    const { client, calls } = fakeClient((path, init) => {
      if (path.includes('/memberships?')) return ok({ data: [member], total_count: 1, has_more: false });
      if (path.endsWith('/roles')) return ok({ data: [{ object: 'role', key: 'org:admin', name: 'Admin', description: null }] });
      if (path.includes('/invitations?')) return ok({ data: [invitation], has_more: false });
      if (init.method === 'POST') return ok({ ...invitation, id: 'inv_2' });
      return ok({});
    });
    const ctl = new OrganizationProfileController(client, 'org_1', { canManage: true });
    const seen: string[] = [];
    ctl.subscribe((s) => seen.push(s.status));
    await ctl.load();
    const state = ctl.getState();
    expect(state.status).toBe('ready');
    expect(state.members).toHaveLength(1);
    expect(state.membersTotal).toBe(1);
    expect(state.roles[0]!.key).toBe('org:admin');
    expect(state.invitations).toHaveLength(1);
    expect(seen).toContain('loading');

    const before = calls.length;
    await ctl.invite('new@y.co', 'org:member');
    expect(calls[before]!.path).toBe('/v1/client/organizations/org_1/invitations');
    // The action is followed by a reload.
    expect(calls.length).toBeGreaterThan(before + 1);
    expect(ctl.getState().busy).toBeNull();
  });

  it('skips invitations for a non-admin and surfaces a refused action as state.error', async () => {
    const { client, calls } = fakeClient((path, init) => {
      if (init.method === 'DELETE') return fail(409, 'LAST_ADMIN');
      if (path.includes('/memberships?')) return ok({ data: [], total_count: 0 });
      return ok({ data: [] });
    });
    const ctl = new OrganizationProfileController(client, 'org_1');
    await ctl.load();
    expect(calls.some((c) => c.path.includes('/invitations'))).toBe(false);
    expect(await ctl.leave()).toBe(false);
    expect((ctl.getState().error as OrganizationRequestError).code).toBe('LAST_ADMIN');
  });

  it('runs onChange after leaving or deleting', async () => {
    const { client } = fakeClient(() => ok({ deleted: true }));
    let changed = 0;
    const ctl = new OrganizationProfileController(client, 'org_1', { onChange: () => void (changed += 1) });
    expect(await ctl.leave()).toBe(true);
    expect(await ctl.deleteOrganization()).toBe(true);
    expect(changed).toBe(2);
  });
});

describe('per-organization custom roles', () => {
  it('hit the right paths with the right bodies', async () => {
    const { client, calls } = fakeClient(() => ok({ object: 'list', data: [] }));
    await listAssignablePermissions(client, 'org_1');
    await createOrganizationRole(client, 'org_1', { key: 'org:auditor', name: 'Auditor', permissions: ['org:sys_memberships:read'] });
    await updateOrganizationRole(client, 'org_1', 'role_1', { permissions: [] });
    await deleteOrganizationRole(client, 'org_1', 'role_1', { reassignTo: 'org:member' });
    await deleteOrganizationRole(client, 'org_1', 'role_2');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /v1/client/organizations/org_1/permissions',
      'POST /v1/client/organizations/org_1/roles',
      'PATCH /v1/client/organizations/org_1/roles/role_1',
      'DELETE /v1/client/organizations/org_1/roles/role_1?reassign_to=org%3Amember',
      'DELETE /v1/client/organizations/org_1/roles/role_2',
    ]);
    expect(calls[1]!.body).toEqual({ key: 'org:auditor', name: 'Auditor', permissions: ['org:sys_memberships:read'] });
    expect(calls[2]!.body).toEqual({ permissions: [] });
  });

  it('the controller loads assignable permissions for admins, exposes custom roles and reloads after role actions', async () => {
    const roles = [
      { object: 'role', key: 'org:admin', name: 'Admin', description: null, organization_id: null },
      { object: 'role', id: 'role_1', key: 'org:auditor', name: 'Auditor', description: null, organization_id: 'org_1', permissions: [] },
    ];
    const { client, calls } = fakeClient((path) => {
      if (path.includes('/memberships?')) return ok({ data: [], total_count: 0 });
      if (path.endsWith('/roles')) return ok({ data: roles });
      if (path.endsWith('/permissions')) return ok({ data: [{ object: 'permission', key: 'org:sys_memberships:read', name: 'Read', description: null }] });
      return ok({ data: [] });
    });
    const ctl = new OrganizationProfileController(client, 'org_1', { canManage: true });
    await ctl.load();
    expect(ctl.getState().permissions.map((p) => p.key)).toEqual(['org:sys_memberships:read']);
    expect(ctl.customRoles().map((r) => r.key)).toEqual(['org:auditor']);

    const before = calls.length;
    await ctl.createRole({ key: 'org:viewer', name: 'Viewer', permissions: [] });
    expect(calls[before]).toMatchObject({ method: 'POST', path: '/v1/client/organizations/org_1/roles' });
    expect(calls.length).toBeGreaterThan(before + 1);
    await ctl.deleteRole('role_1');
    expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/roles/role_1'))).toBe(true);
  });

  it('a member loads no permissions; a server without the route leaves the list empty', async () => {
    const memberCalls = fakeClient(() => ok({ data: [] }));
    await new OrganizationProfileController(memberCalls.client, 'org_1').load();
    expect(memberCalls.calls.some((c) => c.path.endsWith('/permissions'))).toBe(false);

    const old = fakeClient((path) => (path.endsWith('/permissions') ? fail(404, 'NOT_FOUND') : ok({ data: [] })));
    const ctl = new OrganizationProfileController(old.client, 'org_1', { canManage: true });
    await ctl.load();
    expect(ctl.getState().status).toBe('ready');
    expect(ctl.getState().permissions).toEqual([]);
  });
});
