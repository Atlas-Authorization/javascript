/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteContext, RouteDef } from '../engine';
import { EmulatorError, notFound } from '../errors';
import { genericHandler } from '../generic';
import type { Obj } from '../openapi';
import { type Row, paginate } from '../store';
import { CedarParseError, parseCedar } from './cedar';
import { compileStored, validateTuple } from './fga-engine';
import { abacDecide, accessibleResources, fgaCheck, checkResource, findResourceRef, grantView, loadPdp, logDecision, parseSubject, recordResourceCheck, ancestorsOf, latestModel } from './authz-layers';
import { type Tuple, applyTuples, directAppRoles, findAppRole, findGroup, genericTable, groupMembers, liveUser, onMembershipChanged, st, storeExists, storeTuples, tupleKey } from './authz-state';

/**
 * The data the authorization layers read, as real routes: group membership, direct app roles, resources with their role
 * assignments and checks, the ABAC evaluate route and FGA tuple writes, reads and checks. Rows of groups, app roles, resource
 * types, ABAC policies, access policies and FGA stores stay generic rows; the routes here add what the generic layer cannot
 * model (membership, assignments, upserts, defaults on create, evaluation).
 */
const bad = (message: string, param: string) => new EmulatorError('VALIDATION_FAILED', message, param);
const strip = (r: Obj): Obj => {
  const { _parent, ...out } = r;
  return out;
};
const clamp = (raw: string | null, def: number, max: number) => Math.min(Math.max(Number(raw) || def, 1), max);
const MAX_BATCH = 500;
const MAX_ROLES_PER_USER = 50;
const KEY = /^[a-z][a-z0-9_.-]{0,62}$/;

const needStr = (v: unknown, field: string, max = 200): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw bad(`${field} is required (at most ${max} characters).`, field);
  return v;
};

// ── groups ──

const group = (e: Engine, ref: string | undefined) => {
  const g = findGroup(e, ref);
  if (!g) throw new EmulatorError('NOT_FOUND', 'Unknown group.');
  return g;
};
function userIds(body: Obj): string[] {
  const ids = body.user_ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BATCH || ids.some((i) => typeof i !== 'string')) throw bad(`user_ids is a list of 1 to ${MAX_BATCH} user ids.`, 'user_ids');
  return [...new Set(ids as string[])];
}

// ── app roles ──

function userRolesView(e: Engine, userId: string): Obj {
  const roles = directAppRoles(e, userId);
  return { object: 'user_app_roles', user_id: userId, roles: roles.map(strip), role_keys: roles.map((r) => r.key), permissions: [...new Set(roles.flatMap((r) => r.permissions ?? []))].sort() };
}
function resolveRoleIds(e: Engine, raw: unknown, field: string): string[] {
  if (!Array.isArray(raw) || raw.some((r) => typeof r !== 'string')) throw bad(`${field} must be an array of role keys or ids.`, field);
  const list = [...new Set(raw as string[])];
  if (list.length > MAX_ROLES_PER_USER) throw bad(`At most ${MAX_ROLES_PER_USER} roles per user.`, field);
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const k of list) {
    const r = findAppRole(e, k);
    if (r) ids.push(r.id);
    else unknown.push(k);
  }
  if (unknown.length) throw bad(`Unknown app role(s): ${unknown.join(', ')}.`, field);
  return ids;
}
function emitUserRoles(e: Engine, userId: string): void {
  const v = userRolesView(e, userId);
  e.webhooks.emit('user.app_roles_updated', { object: 'user_app_roles', user_id: userId, roles: v.role_keys, permissions: v.permissions });
}

// ── resources ──

const resourceTable = (e: Engine) => genericTable(e, 'resources', 'resource');
const assignmentTable = (e: Engine) => genericTable(e, 'resource_role_assignments', 'resourcerole');
const typeRow = (e: Engine, key: string) => e.generic.get('resource_types')?.find((r) => r.key === key);

/** Validate a type's role list: unique keys, string permissions, `includes` naming real roles. */
function parseRoles(raw: unknown): Obj[] {
  if (!Array.isArray(raw)) throw bad('roles must be an array.', 'roles');
  if (raw.length > 200) throw bad('A resource type may define at most 200 roles.', 'roles');
  const roles = raw.map((r, i) => {
    const o = (r ?? {}) as Obj;
    if (typeof o.key !== 'string' || !KEY.test(o.key)) throw bad(`roles[${i}].key must be lowercase letters, digits, "_", "." or "-".`, 'roles');
    if (!Array.isArray(o.permissions) || o.permissions.some((p: unknown) => typeof p !== 'string' || !p)) throw bad(`roles[${i}].permissions must be an array of strings.`, 'roles');
    if (o.includes !== undefined && (!Array.isArray(o.includes) || o.includes.some((p: unknown) => typeof p !== 'string'))) throw bad(`roles[${i}].includes must be an array of role keys.`, 'roles');
    return { key: o.key, ...(typeof o.name === 'string' ? { name: o.name } : {}), permissions: o.permissions, ...(o.includes ? { includes: o.includes } : {}) };
  });
  const keys = new Set(roles.map((r) => r.key));
  if (keys.size !== roles.length) throw bad('Role keys must be unique within a resource type.', 'roles');
  for (const r of roles) for (const inc of (r as Obj).includes ?? []) if (!keys.has(inc)) throw bad(`Role "${r.key}" includes unknown role "${inc}".`, 'roles');
  return roles;
}

function upsertResource(e: Engine, body: Obj): Obj {
  const typeKey = needStr(body.type, 'type');
  const type = typeRow(e, typeKey);
  if (!type) throw bad(`Unknown resource type "${typeKey}".`, 'type');
  const parentType: string | null = type.parent_type ?? null;
  let parentId: string | null | undefined;
  if (body.parent === null) parentId = null;
  else if (body.parent !== undefined) {
    const parent = findResourceRef(e, body.parent, 'parent');
    if (parentType && parent.type !== parentType) throw bad(`A "${typeKey}" must be nested under a "${parentType}".`, 'parent');
    parentId = parent.id;
  }
  if (parentType && parentId === null) throw bad(`A "${typeKey}" must be nested under a "${parentType}".`, 'parent');
  const externalId = needStr(body.external_id, 'external_id', 500);
  const existing = resourceTable(e).find((r) => r.type === typeKey && r.external_id === externalId);
  if (parentId && existing && ancestorsOf(e, parentId).some((a) => a.id === existing.id)) throw bad('That parent would make the resource its own ancestor.', 'parent');
  if (!existing && parentType && parentId === undefined) throw bad(`A "${typeKey}" must be nested under a "${parentType}".`, 'parent');
  const now = e.clock.now();
  const name = body.name === undefined ? undefined : typeof body.name === 'string' ? body.name : null;
  const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined;
  if (existing) {
    const patch: Obj = { updated_at: now };
    if (name !== undefined) patch.name = name;
    if (parentId !== undefined) patch.parent_id = parentId;
    if (metadata !== undefined) patch.metadata = metadata;
    return resourceTable(e).update(existing.id, patch)!;
  }
  return resourceTable(e).insert({ object: 'resource', type: typeKey, external_id: externalId, name: name ?? null, parent_id: parentId ?? null, metadata: metadata ?? {}, created_at: now, updated_at: now });
}

function assignmentEvent(e: Engine, type: 'created' | 'deleted', a: Obj, resource: Obj | undefined): void {
  e.webhooks.emit(`resource_role_assignment.${type}`, { object: 'resource_role_assignment', id: a.id, resource_id: a.resource_id, resource_type: resource?.type ?? null, resource_external_id: resource?.external_id ?? null, subject: a.subject, role: a.role, inherit: a.inherit, created_at: a.created_at });
}

// ── create defaults ──

/** Run the generic create with the defaults the real service applies when a field is omitted. */
const withDefaults = (c: RouteContext, defaults: Obj) => genericHandler({ ...c, body: { ...defaults, ...c.body } });

function validateAccessPolicy(e: Engine, b: Obj): void {
  if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 100) throw bad('name is required (1-100 characters).', 'name');
  if (e.generic.get('access_policies')?.find((r) => r.name === b.name.trim())) throw bad(`An access policy named "${b.name.trim()}" already exists.`, 'name');
  if (b.mode !== undefined && !['enforce', 'report_only'].includes(b.mode as string)) throw bad('mode must be enforce or report_only.', 'mode');
  if (b.targets !== undefined && (!Array.isArray(b.targets) || !b.targets.length || b.targets.some((t: unknown) => !['user', 'machine', 'agent'].includes(t as string)))) throw bad('targets must be a non-empty list of user, machine or agent.', 'targets');
  if (b.priority !== undefined && (!Number.isInteger(b.priority) || (b.priority as number) < 0 || (b.priority as number) > 100000)) throw bad('priority must be an integer 0-100000.', 'priority');
  if (b.stages !== undefined && (!Array.isArray(b.stages) || b.stages.some((s: unknown) => !['sign_in', 'authorize', 'token'].includes(s as string)))) throw bad('stages must be sign_in, authorize or token.', 'stages');
  if (b.conditions !== undefined && (typeof b.conditions !== 'object' || b.conditions === null || Array.isArray(b.conditions))) throw bad('conditions must be an object.', 'conditions');
  if (!Array.isArray(b.grants)) throw bad('grants must be an array.', 'grants');
  if (!b.grants.length) throw bad('grants must contain at least one grant.', 'conditions');
  const types = ['allow', 'block', 'require_mfa', 'require_acr', 'require_policy_acceptance', 'require_action', 'require_auth_strength', 'require_device_bound_session', 'require_password_change', 'sign_in_frequency', 'persistent_session', 'max_session_age'];
  for (const g of b.grants) {
    if (!g || typeof g !== 'object') throw bad('grants must be objects.', 'conditions');
    if (!types.includes(g.type)) throw bad(`Unknown grant type "${g.type}".`, 'conditions');
    if (['require_acr', 'require_policy_acceptance', 'require_action'].includes(g.type) && !g.value) throw bad(`${g.type} needs a value.`, 'conditions');
  }
}

// ── FGA ──

function parseTuples(raw: unknown, field: string, e: Engine, needFuture: boolean): Tuple[] {
  const list = raw && typeof raw === 'object' && !Array.isArray(raw) && 'tuple_keys' in (raw as object) ? (raw as Obj).tuple_keys : raw;
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw bad(`${field} must be an array.`, field);
  return list.map((t: any, i: number) => {
    if (typeof t !== 'object' || t === null) throw bad(`${field}[${i}] must be an object.`, field);
    const object = t.object ?? t.target;
    if (typeof t.user !== 'string' || typeof t.relation !== 'string' || typeof object !== 'string') throw bad(`${field}[${i}] requires string user, relation and object.`, field);
    const out: Tuple = { user: t.user, relation: t.relation, object };
    if (t.condition !== undefined && t.condition !== null) {
      if (typeof t.condition !== 'object' || typeof t.condition.name !== 'string' || !t.condition.name) throw bad(`${field}[${i}].condition: condition requires a string name.`, field);
      out.condition = { name: t.condition.name, ...(t.condition.context ? { context: t.condition.context } : {}) };
    }
    if (t.expires_at !== undefined && t.expires_at !== null) {
      const at = new Date(t.expires_at).getTime();
      if (typeof t.expires_at !== 'number' && typeof t.expires_at !== 'string') throw bad(`${field}[${i}].expires_at must be an ISO timestamp or epoch ms.`, field);
      if (Number.isNaN(at)) throw bad(`${field}[${i}].expires_at must be an ISO timestamp or epoch ms.`, field);
      if (needFuture && at <= e.clock.now()) throw bad(`${field}[${i}].expires_at must be in the future.`, field);
      out.expires_at = at;
    }
    // Same shape rules as the real store: user is type:id, type:id#relation or type:*; object is type:id.
    const ui = t.user.indexOf(':');
    const oi = object.indexOf(':');
    const rest = ui > 0 ? t.user.slice(ui + 1) : '';
    if (ui <= 0 || !rest || (rest.includes('#') && (rest.startsWith('#') || rest.endsWith('#') || rest.startsWith('*')))) throw bad(`Malformed user '${t.user}': expected 'type:id', 'type:id#relation' or 'type:*'.`, field);
    if (oi <= 0 || oi === object.length - 1 || object.includes('#')) throw bad(`Malformed object '${object}': expected 'type:id'.`, field);
    if (!t.relation || t.relation.includes(':') || t.relation.includes('#')) throw bad(`Malformed relation '${t.relation}'.`, field);
    return out;
  });
}
const mode = (v: unknown, field: string): 'ignore' | 'error' => {
  if (v === undefined || v === null) return 'ignore';
  if (v !== 'ignore' && v !== 'error') throw bad(`${field} must be "ignore" or "error".`, field);
  return v;
};
const store = (e: Engine, id: string | undefined): string => {
  if (!id || !storeExists(e, id)) throw new EmulatorError('NOT_FOUND', 'Unknown FGA store.');
  return id;
};
const tupleView = (t: Tuple & { created_at: number }): Obj => ({ object: 'fga.tuple', user: t.user, relation: t.relation, target: t.object, ...(t.condition ? { condition: t.condition } : {}), ...(t.expires_at ? { expires_at: t.expires_at } : {}), created_at: t.created_at });

export function authzDataHandlers(): RouteDef[] {
  return [
    // ── group membership ──
    {
      method: 'GET',
      pattern: '/v1/groups/:id/members',
      scope: 'users:read',
      handler: (c) => {
        const g = group(c.engine, c.params.id);
        const limit = clamp(c.query.get('limit'), 50, 100);
        const after = c.query.get('starting_after');
        const rows = groupMembers(c.engine, g.id).sort((a, b) => (a.user_id < b.user_id ? -1 : 1)).filter((m) => !after || m.user_id > after);
        const page = rows.slice(0, limit);
        return { body: { object: 'list', data: page.map((r) => ({ object: 'group_member', group_id: r.group_id, user_id: r.user_id, source: r.source, source_ref: r.source_ref ?? null, created_at: r.created_at })), has_more: rows.length > limit, next_cursor: rows.length > limit ? page[page.length - 1]!.user_id : null } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/groups/:id/members',
      scope: 'users:write',
      handler: (c) => {
        const e = c.engine;
        const g = group(e, c.params.id);
        const ids = userIds(c.body);
        const valid = ids.filter((id) => liveUser(e, id));
        const members = st(e).members;
        const had = new Map(members.filter((m) => m.group_id === g.id).map((m) => [m.user_id, m]));
        const added = valid.filter((id) => !had.has(id));
        const promoted = valid.filter((id) => had.has(id) && had.get(id)!.source !== 'manual');
        for (const id of promoted) members.update(had.get(id)!.id, { source: 'manual', source_ref: null });
        for (const id of added) members.insert({ group_id: g.id, user_id: id, source: 'manual', source_ref: null, created_at: e.clock.now() });
        for (const id of added) e.webhooks.emit('group.member_added', { object: 'group_member', group_id: g.id, user_id: id, source: 'manual' });
        if (added.length) onMembershipChanged(e);
        return { body: { object: 'group_membership_result', group_id: g.id, added: added.length, promoted: promoted.length, already_member: valid.length - added.length - promoted.length, skipped: ids.length - valid.length } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/groups/:id/members/remove',
      scope: 'users:write',
      handler: (c) => {
        const e = c.engine;
        const g = group(e, c.params.id);
        const ids = userIds(c.body);
        const gone = st(e).members.filter((m) => m.group_id === g.id && ids.includes(m.user_id));
        for (const m of gone) st(e).members.delete(m.id);
        for (const m of gone) e.webhooks.emit('group.member_removed', { object: 'group_member', group_id: g.id, user_id: m.user_id });
        if (gone.length) onMembershipChanged(e);
        return { body: { object: 'group_membership_result', group_id: g.id, removed: gone.length } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/users/:id/groups',
      scope: 'users:read',
      handler: (c) => {
        const e = c.engine;
        const rows = st(e).members.filter((m) => m.user_id === c.params.id).map((m) => ({ g: e.generic.get('groups')?.get(m.group_id), source: m.source })).filter((x): x is { g: any; source: string } => !!x.g);
        rows.sort((a, b) => (a.g.slug < b.g.slug ? -1 : 1));
        return { body: { object: 'list', data: rows.map((x) => ({ ...strip(x.g), source: x.source })), has_more: false } };
      },
    },
    // ── a user's app roles ──
    {
      method: 'GET',
      pattern: '/v1/users/:id/app_roles',
      scope: 'users:read',
      handler: (c) => {
        if (!liveUser(c.engine, c.params.id)) throw notFound('User');
        return { body: userRolesView(c.engine, c.params.id!) };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/users/:id/app_roles',
      scope: 'users:write',
      handler: (c) => {
        const e = c.engine;
        const userId = c.params.id!;
        if (!liveUser(e, userId)) throw notFound('User');
        const b = c.body;
        const replacing = b.roles !== undefined;
        if (replacing && (b.add !== undefined || b.remove !== undefined)) throw bad('Send roles (replace) or add/remove, not both.', 'roles');
        if (!replacing && b.add === undefined && b.remove === undefined) throw bad('Send roles, add or remove.', 'roles');
        const have = st(e).userRoles.get(userId) ?? new Set<string>();
        let next: Set<string>;
        if (replacing) next = new Set(resolveRoleIds(e, b.roles, 'roles'));
        else {
          const add = b.add !== undefined ? resolveRoleIds(e, b.add, 'add') : [];
          const remove = b.remove !== undefined ? resolveRoleIds(e, b.remove, 'remove') : [];
          next = new Set([...have, ...add.filter((id) => !remove.includes(id))].filter((id) => !remove.includes(id)));
          if (next.size > MAX_ROLES_PER_USER) throw bad(`At most ${MAX_ROLES_PER_USER} roles per user.`, 'add');
        }
        const changed = next.size !== have.size || [...next].some((id) => !have.has(id));
        st(e).userRoles.set(userId, next);
        if (changed) emitUserRoles(e, userId);
        return { body: userRolesView(e, userId) };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/users/:id/app_roles/:roleId',
      scope: 'users:write',
      handler: (c) => {
        const e = c.engine;
        if (!liveUser(e, c.params.id)) throw notFound('User');
        const role = findAppRole(e, c.params.roleId!);
        if (!role) throw new EmulatorError('NOT_FOUND', 'Unknown app role.');
        if (st(e).userRoles.get(c.params.id!)?.delete(role.id)) emitUserRoles(e, c.params.id!);
        return { body: userRolesView(e, c.params.id!) };
      },
    },
    // ── resource types, resources, assignments, checks ──
    {
      method: 'POST',
      pattern: '/v1/resource_types',
      scope: 'resources:write',
      handler: (c) => {
        const e = c.engine;
        const b = c.body;
        const key = typeof b.key === 'string' && KEY.test(b.key) ? b.key : undefined;
        if (!key) throw bad('key must be lowercase letters, digits, "_", "." or "-".', 'key');
        if (typeRow(e, key)) throw bad(`A resource type "${key}" already exists.`, 'key');
        const parentType = b.parent_type === undefined || b.parent_type === null ? null : needStr(b.parent_type, 'parent_type');
        if (parentType && !typeRow(e, parentType)) throw bad(`Unknown parent_type "${parentType}".`, 'parent_type');
        const now = e.clock.now();
        // The row id is the key, so the generic read, update and delete by key keep working.
        const row = genericTable(e, 'resource_types', 'resourcetype').insert({ id: key, object: 'resource_type', key, name: needStr(b.name ?? key, 'name'), description: typeof b.description === 'string' ? b.description : null, parent_type: parentType, inherit: typeof b.inherit === 'boolean' ? b.inherit : true, roles: parseRoles(b.roles ?? []), created_at: now, updated_at: now });
        return { status: 201, body: strip(row) };
      },
    },
    {
      method: 'PUT',
      pattern: '/v1/resources',
      scope: 'resources:write',
      handler: (c) => ({ body: strip(upsertResource(c.engine, c.body)) }),
    },
    {
      method: 'POST',
      pattern: '/v1/resources/sync',
      scope: 'resources:write',
      handler: (c) => {
        const list = c.body.resources;
        if (!Array.isArray(list) || list.length === 0 || list.length > 500) throw bad('resources must be an array of 1–500 items.', 'resources');
        return { body: { object: 'list', data: list.map((item) => strip(upsertResource(c.engine, (item ?? {}) as Obj))), has_more: false } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/resource_role_assignments',
      scope: 'resources:write',
      handler: (c) => {
        const e = c.engine;
        const resource = findResourceRef(e, c.body.resource, 'resource');
        const subject = parseSubject(c.body.subject);
        const role = needStr(c.body.role, 'role');
        if (!typeRow(e, resource.type)?.roles?.some((r: Obj) => r.key === role)) throw bad(`"${resource.type}" has no role "${role}".`, 'role');
        const inherit = typeof c.body.inherit === 'boolean' ? c.body.inherit : true;
        const t = assignmentTable(e);
        const same = t.find((a) => a.resource_id === resource.id && a.subject.type === subject.type && a.subject.id === subject.id && a.role === role);
        // Re-assigning the same role updates `inherit`.
        const row = same ? t.update(same.id, { inherit })! : t.insert({ object: 'resource_role_assignment', resource_id: resource.id, subject, role, inherit, created_at: e.clock.now() });
        assignmentEvent(e, 'created', row, resource);
        return { status: 201, body: row };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/resource_role_assignments/:id',
      scope: 'resources:write',
      handler: (c) => {
        const e = c.engine;
        const row = assignmentTable(e).get(c.params.id);
        if (!row) throw new EmulatorError('NOT_FOUND', 'Unknown assignment.');
        assignmentTable(e).delete(row.id);
        assignmentEvent(e, 'deleted', row, resourceTable(e).get(row.resource_id));
        return { body: { object: 'resource_role_assignment', id: row.id, deleted: true } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/resource_checks',
      scope: 'resources:check',
      handler: (c) => {
        const r = checkResource(c.engine, c.body);
        recordResourceCheck(c.engine, c.body, r);
        return { body: { object: 'resource_check', allowed: r.allowed, resource_id: r.resource.id, grants: r.grants.map(grantView) } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/resource_checks/batch',
      scope: 'resources:check',
      handler: (c) => {
        const list = c.body.checks;
        if (!Array.isArray(list) || list.length === 0 || list.length > 100) throw bad('checks must be an array of 1–100 items.', 'checks');
        const data = list.map((item) => {
          const b = (item ?? {}) as Obj;
          const r = checkResource(c.engine, b);
          recordResourceCheck(c.engine, b, r);
          return { object: 'resource_check', allowed: r.allowed, resource_id: r.resource.id };
        });
        return { body: { object: 'list', data, has_more: false } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/resource_checks/list',
      scope: 'resources:check',
      handler: (c) => {
        const b = c.body;
        if (typeof b.permission !== 'string' || !b.permission) throw bad('permission is required.', 'permission');
        const rows = accessibleResources(c.engine, { subject: parseSubject(b.subject), groups: b.groups, permission: b.permission, type: typeof b.type === 'string' ? b.type : undefined });
        const limit = Math.min(Math.max(Number(b.limit) || 100, 1), 1000);
        const page = paginate(rows, { limit, startingAfter: typeof b.starting_after === 'string' ? b.starting_after : undefined });
        return { body: { object: 'list', data: page.data.map(strip), has_more: page.has_more, next_cursor: page.next_cursor } };
      },
    },
    // ── creates that carry real defaults ──
    {
      method: 'POST',
      pattern: '/v1/abac_policies',
      scope: 'abac:write',
      handler: (c) => {
        const b = c.body;
        if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 100) throw bad('name is required (1-100 characters).', 'name');
        if (c.engine.generic.get('abac_policies')?.find((r) => r.name === b.name)) throw bad(`A policy named "${b.name}" already exists.`, 'name');
        if (typeof b.source !== 'string' || !b.source.trim()) throw bad('source is required.', 'source');
        try {
          parseCedar(b.source);
        } catch (err) {
          if (err instanceof CedarParseError) throw bad(`${err.message} (at character ${err.position})`, 'source');
          throw err;
        }
        return withDefaults(c, { enabled: true, description: null, fga_store_id: null, tests: [], current_version: 1 });
      },
    },
    {
      method: 'POST',
      pattern: '/v1/access_policies',
      scope: 'access_policies:write',
      handler: (c) => {
        validateAccessPolicy(c.engine, c.body);
        return withDefaults(c, { enabled: true, description: null, priority: 100, stages: [], conditions: {}, mode: 'enforce', targets: ['user'] });
      },
    },
    // ── ABAC evaluate ──
    {
      method: 'POST',
      pattern: '/v1/abac/evaluate',
      scope: 'abac:evaluate',
      handler: (c) => {
        const e = c.engine;
        const b = c.body;
        const actionId = typeof b.action === 'string' ? b.action : (b.action as Obj | undefined)?.id;
        if (typeof actionId !== 'string' || !actionId) throw bad('action is required.', 'action');
        const entity = (v: unknown, field: string) => {
          const o = (v ?? {}) as Obj;
          if (typeof o.type !== 'string' || !o.type || typeof o.id !== 'string' || !o.id) throw bad(`${field}.type and ${field}.id are required.`, field);
          return { type: o.type, id: o.id, ...(o.attributes && typeof o.attributes === 'object' ? { attributes: o.attributes } : {}), ...(Array.isArray(o.parents) ? { parents: o.parents } : {}) };
        };
        const req = { principal: entity(b.principal, 'principal'), action: { id: actionId }, resource: entity(b.resource, 'resource'), context: b.context && typeof b.context === 'object' ? (b.context as Obj) : undefined, entities: Array.isArray(b.entities) ? b.entities.map((x, i) => entity(x, `entities[${i}]`)) : undefined };
        const pdp = loadPdp(e, Array.isArray(b.policy_ids) ? (b.policy_ids as string[]) : undefined);
        const d = abacDecide(pdp, req);
        const reasons = [...new Set(d.determining.map((i) => pdp.owners[i]!))];
        logDecision(e, { source: 'abac', decision: d.decision, principal: `${req.principal.type}::${req.principal.id}`, action: actionId, resource: `${req.resource.type}::${req.resource.id}`, input: { ...req }, result: { reasons, errors: d.errors.length } });
        return { body: { object: 'abac_decision', decision: d.decision, reasons, errors: d.errors.map((x) => x.message) } };
      },
    },
    // ── FGA tuples ──
    {
      method: 'POST',
      pattern: '/v1/fga/stores/:id/write',
      scope: 'fga:write',
      handler: (c) => {
        const e = c.engine;
        const storeId = store(e, c.params.id);
        const writes = parseTuples(c.body.writes, 'writes', e, true);
        const deletes = parseTuples(c.body.deletes, 'deletes', e, false);
        if (!writes.length && !deletes.length) throw bad('Provide at least one tuple to write or delete.', 'writes');
        if (!latestModel(e, storeId) && writes.some((w) => w.condition)) throw bad('Write an authorization model before writing conditional tuples.', 'writes');
        const w = c.body.writes && typeof c.body.writes === 'object' && !Array.isArray(c.body.writes) ? (c.body.writes as Obj) : {};
        const d = c.body.deletes && typeof c.body.deletes === 'object' && !Array.isArray(c.body.deletes) ? (c.body.deletes as Obj) : {};
        const onDuplicate = mode(w.on_duplicate ?? c.body.on_duplicate, 'on_duplicate');
        const onMissing = mode(d.on_missing ?? c.body.on_missing, 'on_missing');
        const have = st(e).tuples.get(storeId) ?? new Map();
        if (onDuplicate === 'error') {
          const dup = writes.find((t) => have.has(tupleKey(t)));
          if (dup) throw bad(`write_failed_due_to_invalid_input: tuple ${tupleKey(dup)} already exists.`, 'writes');
        }
        if (onMissing === 'error') {
          const missing = deletes.find((t) => !have.has(tupleKey(t)));
          if (missing) throw bad(`write_failed_due_to_invalid_input: tuple ${tupleKey(missing)} does not exist.`, 'deletes');
        }
        const strict = compileStored(latestModel(e, storeId)?.model);
        if (strict) {
          for (const t of writes) {
            const problem = validateTuple(strict, { user: t.user, relation: t.relation, object: t.object, condition: t.condition });
            if (problem) throw bad(problem, 'writes');
          }
        }
        const revision = applyTuples(e, storeId, writes, deletes, 'api');
        // A tuple the API deletes or rewrites is no longer the sync's to manage.
        for (const t of [...deletes, ...writes]) st(e).managed.delete(tupleKey(t));
        return { body: { object: 'fga.write_result', writes: writes.length, deletes: deletes.length, consistency_token: `${storeId}:${revision}` } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/fga/stores/:id/read',
      scope: 'fga:read',
      handler: (c) => {
        const e = c.engine;
        const storeId = store(e, c.params.id);
        const b = c.body;
        const [ot, ...orest] = typeof b.object === 'string' && b.object ? b.object.split(':') : [];
        const oid = orest.join(':');
        const [ut, ...urest] = typeof b.user === 'string' && b.user ? b.user.split(':') : [];
        const uid = urest.join(':');
        const rows = storeTuples(e, storeId)
          .filter((t) => {
            const [tot, ...tor] = t.object.split(':');
            const [tut, ...tur] = t.user.split(':');
            return (!b.relation || t.relation === b.relation) && (!ot || tot === ot) && (!oid || tor.join(':') === oid) && (!ut || tut === ut) && (!uid || uid === '*' || uid.includes('#') || tur.join(':') === uid);
          })
          .reverse();
        const limit = b.limit === undefined || b.limit === null || b.limit === '' || !Number.isFinite(Number(b.limit)) ? 1000 : Math.min(Math.max(Math.trunc(Number(b.limit)), 1), 1000);
        return { body: { object: 'list', data: rows.slice(0, limit).map(tupleView), has_more: rows.length > limit, next_cursor: null } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/fga/stores/:id/check',
      scope: 'fga:read',
      handler: (c) => {
        const e = c.engine;
        const storeId = store(e, c.params.id);
        const b = c.body;
        if (typeof b.user !== 'string' || typeof b.relation !== 'string' || typeof b.object !== 'string') throw bad('check requires string user, relation and object.', 'user');
        const model = typeof b.authorization_model_id === 'string' && b.authorization_model_id ? e.generic.get('fga/stores/authorization-models')?.find((m) => m._parent === storeId && m.id === b.authorization_model_id) : latestModel(e, storeId);
        if (!model) {
          if (b.authorization_model_id) throw new EmulatorError('NOT_FOUND', 'Unknown authorization model for this store.');
          throw bad('This store has no authorization model yet; write one before running a check.', 'authorization_model_id');
        }
        const contextual = parseTuples(b.contextual_tuples, 'contextual_tuples', e, false);
        const allowed = fgaCheckLogged(e, storeId, model, { user: b.user, relation: b.relation, object: b.object, contextual, context: b.context });
        return { body: { object: 'fga.check', allowed, authorization_model_id: model.id, consistency_token: `${storeId}:${st(e).revisions.get(storeId) ?? 0}` } };
      },
    },
  ];
}

/** Check, then write the decision to the log the way the real route does so a what-if can replay it. */
function fgaCheckLogged(e: Engine, storeId: string, modelRow: Row, req: { user: string; relation: string; object: string; contextual: Tuple[]; context?: unknown }): boolean {
  const modelId = modelRow.id;
  const allowed = fgaCheck(e, storeId, { user: req.user, relation: req.relation, object: req.object, contextual: req.contextual, context: req.context && typeof req.context === 'object' ? (req.context as Obj) : undefined, model: modelRow });
  logDecision(e, { source: 'fga', decision: allowed ? 'allow' : 'deny', principal: req.user, action: req.relation, resource: req.object, input: { user: req.user, relation: req.relation, object: req.object, contextual_tuples: req.contextual, context: req.context ?? null }, result: { authorization_model_id: modelId }, policyVersion: { store_id: storeId, authorization_model_id: modelId } });
  return allowed;
}
