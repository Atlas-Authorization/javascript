/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { parseCedar } from './handlers/cedar';
import { Table } from './store';
import type { Engine } from './engine';
import { client, makeEngine } from './test-support';

const events = (e: Engine, t: string) => e.webhooks.events.filter((x) => x.type === t);
const err = (r: { json: any }) => r.json.errors[0];

async function world() {
  const e = makeEngine();
  const call = client(e);
  const user = async (tag: string) => (await call('POST', '/v1/users', { email_address: `${tag}@example.com` })).json;
  const org = async (name = 'Org') => (await call('POST', '/v1/organizations', { name })).json;
  const explain = async (body: any) => (await call('POST', '/v1/authz/explain', body)).json;
  /** The emulator keeps authorization models as generic rows; this seeds one so FGA checks have a model to run against. */
  const model = (storeId: string, dsl = 'type user\ntype doc\n  relations\n    define viewer: [user]') => {
    let t = e.generic.get('fga/stores/authorization-models');
    if (!t) e.generic.set('fga/stores/authorization-models', (t = new Table('fga/stores/authorization-models', e.clock.now, 'fgm')));
    return t.insert({ object: 'fga.authorization_model', store_id: storeId, schema_version: '1.1', model: dsl, created_at: e.clock.now(), _parent: storeId } as any);
  };
  return { e, call, user, org, explain, model };
}

describe('authz: explain shape', () => {
  it('takes action (or the permission alias), validates the body and answers every layer', async () => {
    const { call, user, explain } = await world();
    const u = await user('shape');
    const ex = await explain({ subject: { id: u.id }, action: 'docs:read' });
    expect(ex).toMatchObject({ object: 'authz_explanation', decision: 'deny', combination: 'deny_overrides', subject: { type: 'user', id: u.id }, action: 'docs:read', deciding: [] });
    expect(Object.keys(ex.layers)).toEqual(['rbac', 'org_roles', 'groups', 'resource_roles', 'abac', 'access_policies', 'fga']);
    expect(ex.layers.org_roles.status).toBe('evaluated');
    expect(ex.layers.resource_roles.status).toBe('skipped');
    expect((await explain({ subject: { id: u.id }, permission: 'docs:read' })).action).toBe('docs:read');
    expect((await call('POST', '/v1/authz/explain', { subject: { id: u.id } })).status).toBe(400);
    expect((await call('POST', '/v1/authz/explain', { subject: { id: u.id }, action: 'x', layers: ['nope'] })).status).toBe(400);
    expect((await call('POST', '/v1/authz/explain', { subject: { id: u.id, type: 'machine' }, action: 'x' })).status).toBe(400);
    expect(Object.keys((await explain({ subject: { id: u.id }, action: 'x', layers: ['rbac', 'groups'] })).layers)).toEqual(['rbac', 'groups']);
  });
});

describe('authz: app roles and groups', () => {
  it('assigns app roles directly (replace, add, remove, delete) and the rbac layer sees them', async () => {
    const { e, call, user, explain } = await world();
    const u = await user('roles');
    const r1 = (await call('POST', '/v1/app_roles', { key: 'reader', name: 'Reader', permissions: ['docs:read'] })).json;
    await call('POST', '/v1/app_roles', { key: 'writer', name: 'Writer', permissions: ['docs:write'] });
    expect((await call('POST', `/v1/users/${u.id}/app_roles`, {})).status).toBe(400);
    expect((await call('POST', `/v1/users/${u.id}/app_roles`, { roles: ['reader'], add: ['writer'] })).status).toBe(400);
    expect(err(await call('POST', `/v1/users/${u.id}/app_roles`, { add: ['ghost'] })).message).toContain('ghost');
    expect((await call('POST', '/v1/users/user_missing/app_roles', { add: ['reader'] })).status).toBe(404);
    const added = (await call('POST', `/v1/users/${u.id}/app_roles`, { add: ['reader'] })).json;
    expect(added).toMatchObject({ object: 'user_app_roles', user_id: u.id, role_keys: ['reader'], permissions: ['docs:read'] });
    expect(events(e, 'user.app_roles_updated')).toHaveLength(1);
    await call('POST', `/v1/users/${u.id}/app_roles`, { add: ['reader'] }); // unchanged: no second event
    expect(events(e, 'user.app_roles_updated')).toHaveLength(1);
    const ex = await explain({ subject: { id: u.id }, action: 'docs:read' });
    expect(ex.decision).toBe('allow');
    expect(ex.layers.rbac.contributions.find((c: any) => c.matched).rule).toMatchObject({ type: 'app_role', name: 'reader' });
    expect((await explain({ subject: { id: u.id }, action: 'docs:write' })).decision).toBe('deny');
    const replaced = (await call('POST', `/v1/users/${u.id}/app_roles`, { roles: ['writer'] })).json;
    expect(replaced.role_keys).toEqual(['writer']);
    expect((await call('GET', `/v1/users/${u.id}/app_roles`)).json.role_keys).toEqual(['writer']);
    expect((await call('DELETE', `/v1/users/${u.id}/app_roles/writer`)).json.role_keys).toEqual([]);
    expect((await call('DELETE', `/v1/users/${u.id}/app_roles/${r1.id}`)).status).toBe(200);
    expect((await call('DELETE', `/v1/users/${u.id}/app_roles/ghost`)).status).toBe(404);
  });

  it('keeps group membership (add, promote, remove, list), emits events and grants roles through the group and its ancestors', async () => {
    const { e, call, user, explain } = await world();
    const u = await user('grp');
    await call('POST', '/v1/app_roles', { key: 'auditor', name: 'Auditor', permissions: ['audit:read'] });
    const parent = (await call('POST', '/v1/groups', { slug: 'staff', name: 'Staff', app_role_keys: ['auditor'] })).json;
    const child = (await call('POST', '/v1/groups', { slug: 'eng', name: 'Eng', parent_id: parent.id })).json;
    expect((await call('POST', `/v1/groups/${child.id}/members`, { user_ids: [] })).status).toBe(400);
    expect((await call('POST', '/v1/groups/igp_none/members', { user_ids: [u.id] })).status).toBe(404);
    const add = (await call('POST', `/v1/groups/${child.slug}/members`, { user_ids: [u.id, 'user_missing'] })).json;
    expect(add).toMatchObject({ object: 'group_membership_result', group_id: child.id, added: 1, already_member: 0, skipped: 1 });
    expect((await call('POST', `/v1/groups/${child.id}/members`, { user_ids: [u.id] })).json).toMatchObject({ added: 0, already_member: 1 });
    expect(events(e, 'group.member_added')).toHaveLength(1);
    const members = (await call('GET', `/v1/groups/${child.id}/members`)).json;
    expect(members.data).toEqual([expect.objectContaining({ object: 'group_member', group_id: child.id, user_id: u.id, source: 'manual' })]);
    expect((await call('GET', `/v1/users/${u.id}/groups`)).json.data.map((g: any) => g.slug)).toEqual(['eng']);
    const ex = await explain({ subject: { id: u.id }, action: 'audit:read' });
    expect(ex.decision).toBe('allow');
    expect(ex.layers.groups.contributions.filter((c: any) => c.matched).map((c: any) => c.rule.name)).toEqual(['staff']); // inherited from the parent group
    expect((await call('POST', `/v1/groups/${child.id}/members/remove`, { user_ids: [u.id] })).json).toMatchObject({ object: 'group_membership_result', removed: 1 });
    expect(events(e, 'group.member_removed')).toHaveLength(1);
    expect((await explain({ subject: { id: u.id }, action: 'audit:read' })).layers.groups.reason).toBe('Not in any group.');
  });
});

describe('authz: resource roles', () => {
  async function tree(w: Awaited<ReturnType<typeof world>>) {
    const { call } = w;
    await call('POST', '/v1/resource_types', { key: 'folder', name: 'Folder', roles: [{ key: 'viewer', permissions: ['read'] }, { key: 'editor', permissions: ['write'], includes: ['viewer'] }] });
    await call('POST', '/v1/resource_types', { key: 'file', name: 'File', parent_type: 'folder', roles: [{ key: 'viewer', permissions: ['read'] }] });
    const folder = (await call('PUT', '/v1/resources', { type: 'folder', external_id: 'root', name: 'Root' })).json;
    const file = (await call('PUT', '/v1/resources', { type: 'file', external_id: 'a.txt', parent: { id: folder.id } })).json;
    return { folder, file };
  }

  it('creates types and upserts resources by type and external id with the real refusals', async () => {
    const w = await world();
    const { call } = w;
    const { folder, file } = await tree(w);
    expect(folder).toMatchObject({ object: 'resource', type: 'folder', external_id: 'root', name: 'Root', parent_id: null, metadata: {} });
    expect(file.parent_id).toBe(folder.id);
    const again = (await call('PUT', '/v1/resources', { type: 'folder', external_id: 'root', name: 'Renamed', metadata: { a: 1 } })).json;
    expect(again).toMatchObject({ id: folder.id, name: 'Renamed', metadata: { a: 1 } });
    expect((await call('GET', `/v1/resources/${folder.id}`)).json.name).toBe('Renamed');
    expect((await call('GET', '/v1/resource_types/folder')).json).toMatchObject({ key: 'folder', inherit: true }); // the type id is its key
    expect((await call('POST', '/v1/resource_types', { key: 'folder', name: 'x' })).status).toBe(400);
    expect((await call('POST', '/v1/resource_types', { key: 'Bad Key' })).status).toBe(400);
    expect((await call('POST', '/v1/resource_types', { key: 'p', roles: [{ key: 'a', permissions: [], includes: ['ghost'] }] })).status).toBe(400);
    expect((await call('PUT', '/v1/resources', { type: 'ghost', external_id: 'x' })).status).toBe(400);
    expect((await call('PUT', '/v1/resources', { type: 'file', external_id: 'orphan' })).status).toBe(400); // a file needs a folder parent
    expect((await call('PUT', '/v1/resources', { type: 'folder', external_id: 'root', parent: { id: file.id } })).status).toBe(400); // own descendant
    const sync = (await call('POST', '/v1/resources/sync', { resources: [{ type: 'folder', external_id: 's1' }, { type: 'folder', external_id: 's2' }] })).json;
    expect(sync.data).toHaveLength(2);
    expect((await call('POST', '/v1/resources/sync', { resources: [] })).status).toBe(400);
  });

  it('assigns roles, resolves includes and inheritance, checks (single, batch, list), logs the checks and emits events', async () => {
    const w = await world();
    const { e, call, user, org, explain } = w;
    const { folder, file } = await tree(w);
    const u = await user('res');
    const o = await org();
    const subject = { type: 'user', id: u.id };
    expect((await call('POST', '/v1/resource_role_assignments', { resource: { id: folder.id }, subject, role: 'ghost' })).status).toBe(400);
    expect((await call('POST', '/v1/resource_role_assignments', { resource: { id: folder.id }, subject: { type: 'robot', id: 'x' }, role: 'editor' })).status).toBe(400);
    expect((await call('POST', '/v1/resource_role_assignments', { resource: { id: 'res_none' }, subject, role: 'editor' })).status).toBe(404);
    const a = await call('POST', '/v1/resource_role_assignments', { resource: { type: 'folder', external_id: 'root' }, subject, role: 'editor' });
    expect(a.status).toBe(200);
    expect(a.json).toMatchObject({ object: 'resource_role_assignment', resource_id: folder.id, subject, role: 'editor', inherit: true });
    expect(events(e, 'resource_role_assignment.created')[0]?.payload.data).toMatchObject({ resource_type: 'folder', resource_external_id: 'root' });
    // editor includes viewer; the file inherits the folder assignment and the role resolves against the folder's own type
    const ck = (await call('POST', '/v1/resource_checks', { subject, permission: 'write', resource: { id: folder.id } })).json;
    expect(ck).toMatchObject({ object: 'resource_check', allowed: true, resource_id: folder.id, grants: [{ resource_id: folder.id, role: 'editor', subject: `user:${u.id}`, inherited: false }] });
    expect((await call('POST', '/v1/resource_checks', { subject, permission: 'read', resource: { id: folder.id } })).json.allowed).toBe(true); // through includes
    expect((await call('POST', '/v1/resource_checks', { subject, permission: 'delete', resource: { id: folder.id } })).json.allowed).toBe(false);
    expect((await call('POST', '/v1/resource_checks', { subject, permission: 'write', resource: { id: file.id } })).json.grants).toEqual([{ resource_id: folder.id, role: 'editor', subject: `user:${u.id}`, inherited: true }]);
    expect((await call('POST', '/v1/resource_checks', { subject, resource: { id: file.id } })).status).toBe(400);
    expect((await call('POST', '/v1/resource_checks', { subject, permission: 'read', resource: { id: 'res_none' } })).status).toBe(404);
    // An org subject holds the role through its members; inherit: false keeps it on the folder itself. Callers can name extra groups.
    const u2 = await user('res2');
    const s2 = { type: 'user', id: u2.id };
    await call('POST', '/v1/resource_role_assignments', { resource: { id: folder.id }, subject: { type: 'org', id: o.id }, role: 'viewer', inherit: false });
    await call('POST', `/v1/organizations/${o.id}/memberships`, { user_id: u2.id, role: 'org:member' });
    expect((await call('POST', '/v1/resource_checks', { subject: s2, permission: 'read', resource: { id: folder.id } })).json.grants[0]).toMatchObject({ subject: `org:${o.id}`, inherited: false });
    expect((await call('POST', '/v1/resource_checks', { subject: s2, permission: 'read', resource: { id: file.id } })).json.allowed).toBe(false);
    await call('POST', '/v1/resource_role_assignments', { resource: { id: folder.id }, subject: { type: 'group', id: 'ext-dir' }, role: 'viewer' });
    expect((await call('POST', '/v1/resource_checks', { subject: s2, permission: 'read', resource: { id: file.id }, groups: ['ext-dir'] })).json.grants).toEqual([{ resource_id: folder.id, role: 'viewer', subject: 'group:ext-dir', inherited: true }]);
    // batch and list
    const batch = (await call('POST', '/v1/resource_checks/batch', { checks: [{ subject, permission: 'write', resource: { id: folder.id } }, { subject: s2, permission: 'write', resource: { id: file.id } }] })).json;
    expect(batch.data.map((x: any) => x.allowed)).toEqual([true, false]);
    expect((await call('POST', '/v1/resource_checks/batch', { checks: [] })).status).toBe(400);
    const list = (await call('POST', '/v1/resource_checks/list', { subject, permission: 'write', type: 'folder' })).json;
    expect(list.data.map((r: any) => r.id)).toEqual([folder.id]);
    expect((await call('POST', '/v1/resource_checks/list', { subject })).status).toBe(400);
    // explain uses the same resolver
    const ex = await explain({ subject: { id: u.id }, action: 'write', resource: { type: 'folder', external_id: 'root' } });
    expect(ex.layers.resource_roles.decision).toBe('allow');
    expect(ex.decision).toBe('allow');
    expect((await explain({ subject: { id: u.id }, action: 'write', resource: { resource_id: 'res_none' }, layers: ['resource_roles'] })).layers.resource_roles).toMatchObject({ status: 'skipped', reason: 'Unknown resource.' });
    // checks are in the decision log, as resource-role decisions a role edit does not replay
    const run = (await call('POST', '/v1/authz/what_if', { candidate: { rbac: { roles: [{ type: 'org_role', key: 'org:member', add_permissions: ['read'] }] } } })).json;
    expect(run.skipped.rbac_not_role_based).toBeGreaterThan(0);
    // revoke
    expect((await call('DELETE', `/v1/resource_role_assignments/${a.json.id}`)).json).toMatchObject({ object: 'resource_role_assignment', id: a.json.id, deleted: true });
    expect(events(e, 'resource_role_assignment.deleted')).toHaveLength(1);
    expect((await call('DELETE', `/v1/resource_role_assignments/${a.json.id}`)).status).toBe(404);
    expect((await call('POST', '/v1/resource_checks', { subject, permission: 'write', resource: { id: folder.id } })).json.allowed).toBe(false);
  });

  it('re-assigning the same role updates inherit, and a type that does not inherit stops the walk', async () => {
    const w = await world();
    const { call, user } = w;
    const u = await user('inh');
    await call('POST', '/v1/resource_types', { key: 'proj', name: 'P', roles: [{ key: 'v', permissions: ['read'] }] });
    await call('POST', '/v1/resource_types', { key: 'task', name: 'T', inherit: false, parent_type: 'proj', roles: [{ key: 'v', permissions: ['read'] }] });
    const proj = (await call('PUT', '/v1/resources', { type: 'proj', external_id: 'p' })).json;
    const task = (await call('PUT', '/v1/resources', { type: 'task', external_id: 't', parent: { id: proj.id } })).json;
    const subject = { type: 'user', id: u.id };
    const a = (await call('POST', '/v1/resource_role_assignments', { resource: { id: proj.id }, subject, role: 'v' })).json;
    expect((await call('POST', '/v1/resource_checks', { subject, permission: 'read', resource: { id: task.id } })).json.allowed).toBe(false); // task does not inherit
    const b = (await call('POST', '/v1/resource_role_assignments', { resource: { id: proj.id }, subject, role: 'v', inherit: false })).json;
    expect(b.id).toBe(a.id);
    expect(b.inherit).toBe(false);
  });
});

describe('authz: cedar subset and the ABAC layer', () => {
  it('evaluates scope constraints, conditions, hierarchy, like, sets and skips errors and unparseable policies', async () => {
    const { call } = await world();
    const mk = async (name: string, source: string) => (await call('POST', '/v1/abac_policies', { name, source })).json;
    await mk('owner', 'permit (principal, action == Action::"read", resource) when { resource.owner == principal.id };');
    await mk('block-locked', '@id("x") forbid (principal, action, resource) when { resource has locked && resource.locked };');
    await mk('names', 'permit (principal is User, action in [Action::"list", Action::"peek"], resource) unless { !(principal.email like "*@corp.com") };');
    await mk('group', 'permit (principal in Team::"core", action, resource == Doc::"shared");');
    await mk('math', 'permit (principal, action == Action::"add", resource) when { context.n + 1 >= 3 && [1,2,3].contains(context.n) };');
    const ev = async (b: any) => (await call('POST', '/v1/abac/evaluate', { principal: { type: 'User', id: 'u1', attributes: { email: 'a@corp.com', id: 'u1' } }, resource: { type: 'Doc', id: 'd1', attributes: { owner: 'u1' } }, ...b })).json;
    expect(await ev({ action: 'read' })).toMatchObject({ object: 'abac_decision', decision: 'allow', reasons: ['owner'] });
    expect((await ev({ action: 'read', resource: { type: 'Doc', id: 'd1', attributes: { owner: 'u2' } } })).decision).toBe('deny');
    expect((await ev({ action: 'read', resource: { type: 'Doc', id: 'd1', attributes: { owner: 'u1', locked: true } } }))).toMatchObject({ decision: 'deny', reasons: ['block-locked'] });
    expect((await ev({ action: 'peek' })).decision).toBe('allow');
    expect((await ev({ action: 'peek', principal: { type: 'User', id: 'u1', attributes: { email: 'a@other.com' } } })).decision).toBe('deny');
    expect((await ev({ action: 'x', principal: { type: 'User', id: 'u1', parents: ['Team::core'] }, resource: { type: 'Doc', id: 'shared' } })).decision).toBe('allow');
    expect((await ev({ action: 'add', context: { n: 2 } })).decision).toBe('allow');
    expect((await ev({ action: 'add', context: { n: 5 } })).decision).toBe('deny');
    const errored = await ev({ action: 'read', resource: { type: 'Doc', id: 'd1' } }); // no owner attribute: the policy errors and is skipped
    expect(errored).toMatchObject({ decision: 'deny', errors: [expect.stringContaining('owner')] });
    expect((await ev({ action: 'read', policy_ids: [] })).decision).toBe('deny');
    expect((await call('POST', '/v1/abac/evaluate', { principal: { type: 'User', id: 'u1' }, resource: { type: 'Doc', id: 'd1' } })).status).toBe(400);
    expect((await call('POST', '/v1/abac_policies', { name: 'bad', source: 'permit (' })).status).toBe(400);
    expect((await call('POST', '/v1/abac_policies', { name: 'owner', source: 'permit (principal, action, resource);' })).status).toBe(400); // duplicate name
    expect(() => parseCedar('permit (principal, action, resource) when { fga.check(principal, "r", resource) };')).toThrow();
  });

  it('feeds the explain layer: permit allows, forbid denies and wins, disabled and unparseable policies are skipped', async () => {
    const { e, call, user, explain } = await world();
    const u = await user('abac');
    await call('POST', '/v1/abac_policies', { name: 'p1', source: 'permit (principal, action == Action::"read", resource) when { context.region == "eu" };' });
    const base = { subject: { id: u.id }, action: 'read', resource: { type: 'Doc', id: 'd1' } };
    expect((await explain(base)).layers.abac.contributions[0]).toMatchObject({ matched: false, reason: expect.stringContaining('errored') });
    const ok = await explain({ ...base, context: { region: 'eu' } });
    expect(ok.decision).toBe('allow');
    expect(ok.layers.abac).toMatchObject({ status: 'evaluated', decision: 'allow' });
    expect(ok.layers.abac.contributions[0]).toMatchObject({ layer: 'abac', effect: 'allow', matched: true, rule: { type: 'abac_permit', name: 'p1' } });
    const forbid = (await call('POST', '/v1/abac_policies', { name: 'f1', source: 'forbid (principal, action, resource) when { context.region == "eu" };' })).json;
    const denied = await explain({ ...base, context: { region: 'eu' } });
    expect(denied.decision).toBe('deny');
    expect(denied.summary).toContain('abac_forbid');
    await call('PATCH', `/v1/abac_policies/${forbid.id}`, { enabled: false });
    expect((await explain({ ...base, context: { region: 'eu' } })).decision).toBe('allow');
    e.generic.get('abac_policies')!.insert({ object: 'abac_policy', name: 'broken', enabled: true, source: 'permit (' } as any);
    expect((await explain({ ...base, context: { region: 'eu' } })).layers.abac.contributions.some((c: any) => c.rule.name === 'broken')).toBe(false);
    expect((await explain({ subject: { id: u.id }, action: 'read' })).layers.abac.status).toBe('skipped');
    await call('DELETE', `/v1/abac_policies/${(await call('GET', '/v1/abac_policies')).json.data.find((p: any) => p.name === 'p1').id}`);
    expect((await explain({ ...base, layers: ['abac'] })).layers.abac.contributions.some((c: any) => c.rule.name === 'p1')).toBe(false);
  });
});

describe('authz: access policies layer', () => {
  it('blocks, requires a step up, reports report-only policies and lists the ones the emulator cannot judge', async () => {
    const { call, user, org, explain } = await world();
    const u = await user('ap');
    const o = await org();
    await call('POST', `/v1/organizations/${o.id}/memberships`, { user_id: u.id, role: 'org:admin' });
    const body = { subject: { id: u.id }, action: 'org:read', resource: { organization_id: o.id } };
    expect((await call('POST', '/v1/access_policies', { name: 'x', grants: [] })).status).toBe(400);
    expect((await call('POST', '/v1/access_policies', { name: 'x', grants: [{ type: 'nope' }] })).status).toBe(400);
    expect((await call('POST', '/v1/access_policies', { name: 'x', grants: [{ type: 'allow' }], mode: 'strict' })).status).toBe(400);
    const none = await explain({ ...body, layers: ['access_policies'] });
    expect(none.layers.access_policies).toMatchObject({ status: 'evaluated', decision: 'no_match', reason: 'The instance has no access policies.' });
    const mfa = (await call('POST', '/v1/access_policies', { name: 'admins-mfa', grants: [{ type: 'require_mfa' }], conditions: { roles: ['org:admin'] } })).json;
    expect(mfa).toMatchObject({ enabled: true, priority: 100, mode: 'enforce' });
    expect((await call('POST', '/v1/access_policies', { name: 'admins-mfa', grants: [{ type: 'allow' }] })).status).toBe(400);
    const ex = await explain(body);
    expect(ex.layers.access_policies.decision).toBe('step_up');
    expect(ex.layers.access_policies.contributions[0]).toMatchObject({ effect: 'step_up', matched: true, evidence: ['mfa'], rule: { type: 'access_policy', name: 'admins-mfa' } });
    expect(ex.decision).toBe('step_up'); // the admin's own org:read allows it, once the step up is met
    await call('POST', '/v1/app_roles', { key: 'r', name: 'R', permissions: ['org:read'] });
    await call('POST', `/v1/users/${u.id}/app_roles`, { add: ['r'] });
    expect((await explain(body)).decision).toBe('step_up');
    const zone = (await call('POST', '/v1/network_zones', { name: 'office', cidrs: ['10.0.0.0/8'] })).json;
    await call('POST', '/v1/access_policies', { name: 'block-net', grants: [{ type: 'block' }], conditions: { networkZones: { include: [zone.id] } } });
    expect((await explain({ ...body, access: { ip: '8.8.8.8' } })).decision).toBe('step_up');
    const blocked = await explain({ ...body, access: { ip: '10.1.2.3' } });
    expect(blocked.decision).toBe('deny');
    expect(blocked.layers.access_policies.contributions.find((c: any) => c.effect === 'deny').rule.name).toBe('block-net');
    await call('POST', '/v1/access_policies', { name: 'geo', grants: [{ type: 'block' }], conditions: { countries: ['KP'] } });
    const geo = (await explain({ ...body, access: { ip: '8.8.8.8' } })).layers.access_policies.contributions.find((c: any) => c.rule.name === 'geo');
    expect(geo).toMatchObject({ matched: false, effect: 'none', reason: expect.stringContaining('countries') });
    await call('POST', '/v1/access_policies', { name: 'watch', mode: 'report_only', grants: [{ type: 'block' }], conditions: { applications: ['app_1'] } });
    const rep = await explain({ ...body, access: { ip: '8.8.8.8', application_id: 'app_1' } });
    expect(rep.decision).toBe('step_up'); // report-only never enforces
    expect(rep.layers.access_policies.contributions.find((c: any) => c.rule.type === 'access_policy_report_only')).toMatchObject({ matched: false, reason: expect.stringContaining('would block') });
  });
});

describe('authz: FGA tuples', () => {
  it('writes, reads and checks tuples with refusals, modes, wildcards, usersets and expiry; emits feed entries and webhooks', async () => {
    const { e, call, model } = await world();
    const store = (await call('POST', '/v1/fga/stores', { name: 's' })).json;
    const w = (b: any) => call('POST', `/v1/fga/stores/${store.id}/write`, b);
    expect((await call('POST', '/v1/fga/stores/fga_none/write', { writes: [{ user: 'user:a', relation: 'viewer', object: 'doc:1' }] })).status).toBe(404);
    expect((await w({})).status).toBe(400);
    expect((await w({ writes: [{ user: 'nope', relation: 'viewer', object: 'doc:1' }] })).status).toBe(400);
    expect((await w({ writes: [{ user: 'user:a', relation: 'viewer', object: 'doc' }] })).status).toBe(400);
    expect((await w({ writes: [{ user: 'user:a', relation: 'viewer', object: 'doc:1', condition: { name: 'c' } }] })).status).toBe(400); // no model yet
    expect((await w({ writes: [{ user: 'user:a', relation: 'viewer', object: 'doc:1', expires_at: 1000 }] })).status).toBe(400); // already past
    const ok = await w({ writes: { tuple_keys: [{ user: 'user:alice', relation: 'viewer', object: 'doc:1' }, { user: 'user:*', relation: 'viewer', object: 'doc:pub' }, { user: 'group:eng#member', relation: 'viewer', object: 'doc:2' }, { user: 'user:bob', relation: 'member', object: 'group:eng' }] } });
    expect(ok.json).toMatchObject({ object: 'fga.write_result', writes: 4, deletes: 0 });
    expect((await w({ writes: [{ user: 'user:alice', relation: 'viewer', object: 'doc:1' }], on_duplicate: 'error' })).json.errors[0].message).toContain('already exists');
    expect((await w({ deletes: [{ user: 'user:zed', relation: 'viewer', object: 'doc:1' }], on_missing: 'error' })).status).toBe(400);
    expect((await w({ deletes: [{ user: 'user:zed', relation: 'viewer', object: 'doc:1' }] })).status).toBe(200); // default: ignore
    const read = (await call('POST', `/v1/fga/stores/${store.id}/read`, { object: 'doc:1' })).json;
    expect(read.data).toEqual([expect.objectContaining({ object: 'fga.tuple', user: 'user:alice', relation: 'viewer', target: 'doc:1' })]);
    expect((await call('POST', `/v1/fga/stores/${store.id}/read`, { user: 'user:bob' })).json.data).toHaveLength(1);
    const chk = (b: any) => call('POST', `/v1/fga/stores/${store.id}/check`, b);
    expect(err(await chk({ user: 'user:alice', relation: 'viewer', object: 'doc:1' })).code).toBe('VALIDATION_FAILED'); // no model
    const m = model(store.id);
    expect((await chk({ user: 'user:alice', relation: 'viewer', object: 'doc:1' })).json).toMatchObject({ object: 'fga.check', allowed: true, authorization_model_id: m.id });
    expect((await chk({ user: 'user:carol', relation: 'viewer', object: 'doc:1' })).json.allowed).toBe(false);
    expect((await chk({ user: 'user:carol', relation: 'viewer', object: 'doc:pub' })).json.allowed).toBe(true); // wildcard
    expect((await chk({ user: 'user:bob', relation: 'viewer', object: 'doc:2' })).json.allowed).toBe(true); // through group:eng#member
    expect((await chk({ user: 'user:carol', relation: 'viewer', object: 'doc:2', contextual_tuples: [{ user: 'user:carol', relation: 'member', object: 'group:eng' }] })).json.allowed).toBe(true);
    expect((await chk({ user: 'user:alice', relation: 'viewer', object: 'doc:1', authorization_model_id: 'fgm_none' })).status).toBe(404);
    expect((await chk({ user: 'user:alice' })).status).toBe(400);
    await w({ deletes: [{ user: 'user:alice', relation: 'viewer', object: 'doc:1' }] });
    expect((await chk({ user: 'user:alice', relation: 'viewer', object: 'doc:1' })).json.allowed).toBe(false);
    const feed = (await call('GET', '/v1/authz/events?after=0')).json.data;
    expect(feed.filter((x: any) => x.kind === 'tuples_written' && x.source === 'api')[0]).toMatchObject({ store_id: store.id, data: { count: 4 } });
    expect(feed.some((x: any) => x.kind === 'tuples_deleted' && x.source === 'api')).toBe(true);
    expect(events(e, 'fga.tuple_written')[0]?.payload.data).toMatchObject({ object: 'fga_tuple_batch', store_id: store.id, source: 'api', count: 4 });
    expect(events(e, 'fga.tuple_deleted').length).toBeGreaterThan(0);
  });

  it('honours tuple expiry as the clock advances', async () => {
    const { e, call, model } = await world();
    const store = (await call('POST', '/v1/fga/stores', { name: 's' })).json;
    model(store.id);
    await call('POST', `/v1/fga/stores/${store.id}/write`, { writes: [{ user: 'user:a', relation: 'viewer', object: 'doc:1', expires_at: e.clock.now() + 60_000 }] });
    const chk = async () => (await call('POST', `/v1/fga/stores/${store.id}/check`, { user: 'user:a', relation: 'viewer', object: 'doc:1' })).json.allowed;
    expect(await chk()).toBe(true);
    await client(e, null)('POST', '/__emulator/time/advance', { ms: 120_000 });
    expect(await chk()).toBe(false);
  });

  it('adds the fga layer to explain, with evidence, and skips it when the store, model or relation is missing', async () => {
    const { call, user, explain, model } = await world();
    const u = await user('fgal');
    const store = (await call('POST', '/v1/fga/stores', { name: 's' })).json;
    const base = { subject: { id: u.id }, action: 'viewer', resource: { type: 'doc', id: '1' }, layers: ['fga'] };
    expect((await explain(base)).layers.fga.reason).toBe('No FGA store: pass fga.store_id or configure managed sync.');
    expect((await explain({ ...base, fga: { store_id: 'fga_none' } })).layers.fga.reason).toBe('Unknown FGA store.');
    expect((await explain({ ...base, fga: { store_id: store.id } })).layers.fga.reason).toBe('The FGA store has no authorization model.');
    model(store.id);
    expect((await explain({ ...base, fga: { store_id: store.id, relation: 'owner' } })).layers.fga.reason).toBe('The model has no relation doc#owner.');
    await call('POST', `/v1/fga/stores/${store.id}/write`, { writes: [{ user: `user:${u.id}`, relation: 'viewer', object: 'doc:1' }] });
    const ex = await explain({ ...base, fga: { store_id: store.id } });
    expect(ex.layers.fga.contributions[0]).toMatchObject({ layer: 'fga', matched: true, rule: { type: 'fga_check', id: 'doc:1#viewer', name: store.id }, evidence: [`user:${u.id}|viewer|doc:1`] });
    expect(ex.decision).toBe('allow');
    expect((await explain({ ...base, resource: { type: 'doc', id: '2' }, fga: { store_id: store.id } })).layers.fga.decision).toBe('no_match');
  });
});

describe('authz: live sync of memberships and groups', () => {
  it('writes and deletes managed tuples the moment a membership, role, user or group member changes', async () => {
    const { e, call, user, org, model } = await world();
    const u = await user('live');
    const u2 = await user('live2');
    const o = await org();
    const store = (await call('POST', '/v1/fga/stores', { name: 'sync' })).json;
    model(store.id);
    await call('PUT', '/v1/fga/sync', { enabled: true, store_id: store.id });
    const tuples = async () => (await call('POST', `/v1/fga/stores/${store.id}/read`, {})).json.data.map((t: any) => `${t.user}|${t.relation}|${t.target}`).sort();
    const sync = async () => (await call('GET', '/v1/fga/sync')).json.managed_tuples;
    await call('POST', `/v1/organizations/${o.id}/memberships`, { user_id: u.id, role: 'org:member' });
    expect(await tuples()).toEqual([`user:${u.id}|member|organization:${o.id}`]);
    expect(await sync()).toBe(1); // org:member maps to the same member tuple
    await call('PATCH', `/v1/organizations/${o.id}/memberships/${u.id}`, { role: 'org:admin' });
    expect(await tuples()).toEqual([`user:${u.id}|admin|organization:${o.id}`, `user:${u.id}|member|organization:${o.id}`]);
    const feed = (await call('GET', '/v1/authz/events?after=0')).json.data.filter((x: any) => x.source === 'sync');
    expect(feed.filter((x: any) => x.kind === 'tuples_written').length).toBeGreaterThanOrEqual(2);
    expect(events(e, 'fga.tuple_written').every((x) => x.payload.data.source === 'sync')).toBe(true);
    // group members and nesting
    const parent = (await call('POST', '/v1/groups', { slug: 'all', name: 'All' })).json;
    const child = (await call('POST', '/v1/groups', { slug: 'eng', name: 'Eng', parent_id: parent.id })).json;
    await call('POST', `/v1/groups/${child.id}/members`, { user_ids: [u.id, u2.id] });
    expect(await tuples()).toEqual(expect.arrayContaining([`user:${u.id}|member|group:eng`, `user:${u2.id}|member|group:eng`, 'group:eng#member|member|group:all']));
    await call('POST', `/v1/groups/${child.id}/members/remove`, { user_ids: [u2.id] });
    expect(await tuples()).not.toContain(`user:${u2.id}|member|group:eng`);
    // a user delete drops that user's tuples at once
    await call('DELETE', `/v1/users/${u.id}`);
    expect((await tuples()).filter((t: string) => t.includes(u.id))).toEqual([]);
    await call('DELETE', `/v1/users/${u2.id}`);
    // the sync never takes over or deletes a tuple the API wrote
    await call('POST', `/v1/fga/stores/${store.id}/write`, { writes: [{ user: 'user:manual', relation: 'member', object: 'group:eng' }] });
    await call('POST', '/v1/fga/sync/backfill', { repair: true });
    expect(await tuples()).toContain('user:manual|member|group:eng');
    // purge removes only the managed tuples
    await call('PUT', '/v1/fga/sync', { enabled: false });
    await call('POST', '/v1/fga/sync/purge', { confirm: true });
    expect(await tuples()).toEqual(['user:manual|member|group:eng']);
  });

  it('is quiet while sync is off or groups sync is off', async () => {
    const { call, user, org } = await world();
    const u = await user('off');
    const o = await org();
    const store = (await call('POST', '/v1/fga/stores', { name: 'sync' })).json;
    await call('POST', `/v1/organizations/${o.id}/memberships`, { user_id: u.id, role: 'org:member' });
    expect((await call('POST', `/v1/fga/stores/${store.id}/read`, {})).json.data).toEqual([]);
    await call('PUT', '/v1/fga/sync', { enabled: true, store_id: store.id, groups: false });
    const g = (await call('POST', '/v1/groups', { slug: 'g', name: 'G' })).json;
    await call('POST', `/v1/groups/${g.id}/members`, { user_ids: [u.id] });
    const data = (await call('POST', `/v1/fga/stores/${store.id}/read`, {})).json.data;
    expect(data.some((t: any) => t.target.startsWith('group:'))).toBe(false);
    expect(data.some((t: any) => t.target.startsWith('organization:'))).toBe(true);
  });
});

describe('authz: what-if replays roles, ABAC and FGA decisions', () => {
  it('replays a role decision with a candidate edit and honours the real result shape and save modes', async () => {
    const { call, user, org } = await world();
    const u = await user('wi');
    const o = await org();
    await call('POST', `/v1/organizations/${o.id}/memberships`, { user_id: u.id, role: 'org:member' });
    for (let i = 0; i < 2; i++) await call('POST', '/v1/authz/rbac/check', { subject: { id: u.id }, permission: 'billing:manage', organization_id: o.id });
    const check = (await call('POST', '/v1/authz/rbac/check', { subject: { id: u.id }, permission: 'org:read', organization_id: o.id })).json;
    expect(check).toMatchObject({ object: 'rbac_check', decision: expect.any(String) });
    expect(Array.isArray(check.grants)).toBe(true);
    const cand = { candidate: { rbac: { roles: [{ type: 'org_role', key: 'org:member', add_permissions: ['billing:manage'] }] } } };
    const unsaved = await call('POST', '/v1/authz/what_if', { ...cand, save: false });
    expect(unsaved.status).toBe(200);
    expect(unsaved.json).toMatchObject({ object: 'authz_what_if', evaluated: 3, replayed: 3, totals: { deny_to_allow: 2 }, by_source: { rbac: { replayed: 3, deny_to_allow: 2 } }, affected_principals: 1 });
    expect(unsaved.json.id).toBeUndefined();
    const saved = await call('POST', '/v1/authz/what_if', { ...cand, name: 'n' });
    expect(saved.status).toBe(201);
    expect((await call('GET', `/v1/authz/what_if/${saved.json.id}`)).json).toMatchObject({ object: 'authz_what_if_run', name: 'n', result: { totals: { deny_to_allow: 2 } } });
    expect((await call('GET', '/v1/authz/what_if')).json.data[0].result).toBeUndefined();
    expect((await call('POST', '/v1/authz/what_if', { candidate: { rbac: { roles: [] } } })).status).toBe(400);
    expect((await call('POST', '/v1/authz/what_if', { ...cand, days: 99 })).status).toBe(400);
    expect((await call('POST', '/v1/authz/what_if', { candidate: { fga: { store_id: 'fga_none' } } })).status).toBe(400);
  });

  it('replays ABAC evaluations against candidate policies and FGA checks against candidate tuples', async () => {
    const { call, model } = await world();
    await call('POST', '/v1/abac_policies', { name: 'p', source: 'permit (principal, action == Action::"read", resource) when { context.ok };' });
    for (const ok of [true, true, false]) await call('POST', '/v1/abac/evaluate', { principal: { type: 'User', id: 'u' }, action: 'read', resource: { type: 'Doc', id: 'd' }, context: { ok } });
    const abac = (await call('POST', '/v1/authz/what_if', { candidate: { abac: { replace: [{ name: 'p', source: 'permit (principal, action, resource);' }] } }, save: false })).json;
    expect(abac).toMatchObject({ evaluated: 3, by_source: { abac: { replayed: 3, deny_to_allow: 1, baseline_mismatch: 0 } } });
    const rm = (await call('POST', '/v1/authz/what_if', { candidate: { abac: { remove: ['p'] } }, save: false })).json;
    expect(rm.by_source.abac).toMatchObject({ allow_to_deny: 2 });
    expect((await call('POST', '/v1/authz/what_if', { candidate: { abac: { add: [{ name: 'bad', source: 'permit (' }] } } })).status).toBe(400);
    const store = (await call('POST', '/v1/fga/stores', { name: 's' })).json;
    model(store.id);
    await call('POST', `/v1/fga/stores/${store.id}/write`, { writes: [{ user: 'user:a', relation: 'viewer', object: 'doc:1' }] });
    for (const user of ['user:a', 'user:b']) await call('POST', `/v1/fga/stores/${store.id}/check`, { user, relation: 'viewer', object: 'doc:1' });
    const fga = (await call('POST', '/v1/authz/what_if', { candidate: { fga: { store_id: store.id, writes: [{ user: 'user:b', relation: 'viewer', object: 'doc:1' }], deletes: [{ user: 'user:a', relation: 'viewer', object: 'doc:1' }] } }, save: false })).json;
    expect(fga.by_source.fga).toMatchObject({ replayed: 2, allow_to_deny: 1, deny_to_allow: 1 });
    expect(fga.skipped.no_matching_candidate).toBeGreaterThan(0);
    const other = (await call('POST', '/v1/fga/stores', { name: 'o' })).json;
    model(other.id);
    expect((await call('POST', '/v1/authz/what_if', { candidate: { fga: { store_id: other.id } }, save: false })).json.skipped.other_store).toBe(2);
  });
});
