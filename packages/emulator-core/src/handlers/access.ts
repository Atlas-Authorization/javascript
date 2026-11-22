/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteDef } from '../engine';
import { EmulatorError, notFound } from '../errors';
import type { Obj } from '../openapi';
import { listReply, need } from './util';

const SYSTEM_ROLES: Array<[string, string, string[]]> = [
  ['org:admin', 'Admin', ['org:read', 'org:update', 'org:members:manage']],
  ['org:member', 'Member', ['org:read']],
];

/** The two system roles every instance has. Called on construction and after every reset. */
export function seedAccess(e: Engine): void {
  for (const [key, name, permissions] of SYSTEM_ROLES) {
    e.db.roles.insert({ key, name, description: null, is_system: true, visibility: 'public', permissions, created_at: e.clock.now() });
  }
  for (const key of new Set(SYSTEM_ROLES.flatMap((r) => r[2]))) {
    e.db.permissions.insert({ key, name: key, description: null, is_system: true });
  }
}

export const presentRole = (e: Engine, r: Obj): Obj =>
  e.shape('Role', {
    object: 'role',
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description ?? null,
    is_system: r.is_system === true,
    visibility: r.visibility ?? 'public',
    organization_id: null,
    permissions: r.permissions ?? [],
    member_count: e.db.memberships.filter((m) => m.role === r.key).length,
    created_at: r.created_at,
  });

export const presentPermission = (e: Engine, p: Obj): Obj =>
  e.shape('Permission', { object: 'permission', id: p.id, key: p.key, name: p.name, description: p.description ?? null, is_system: p.is_system === true });

const liveRole = (e: Engine, id: string | undefined): Obj => {
  const r = e.db.roles.get(id);
  if (!r) throw notFound('Role');
  return r;
};

/** A legacy key (an alias) stands for its canonical permission key; other keys pass through. */
const resolveAliases = (e: Engine, keys: string[]): string[] => [
  ...new Set(keys.map((k) => (e.db.permissionAliases.find((x) => x.alias === k)?.permission_key as string | undefined) ?? k)),
];

const presentAlias = (a: Obj): Obj => ({ object: 'permission_alias', alias: a.alias, permission_key: a.permission_key, created_at: a.created_at });

function setAlias(e: Engine, alias: string, target: string): { status: number; body: Obj } {
  if (alias === target) throw new EmulatorError('CONFLICT', 'An alias cannot point at itself.', 'alias');
  if (e.db.permissions.find((p) => p.key === alias)) throw new EmulatorError('CONFLICT', 'That key is a permission already.', 'alias');
  if (!e.db.permissions.find((p) => p.key === target)) {
    if (e.db.permissionAliases.find((x) => x.alias === target)) throw new EmulatorError('CONFLICT', 'permission_key is itself an alias.', 'permission_key');
    throw notFound('Permission');
  }
  const existing = e.db.permissionAliases.find((x) => x.alias === alias);
  const row = existing ?? e.db.permissionAliases.insert({ alias, permission_key: target, created_at: e.clock.now() });
  row.permission_key = target;
  return { status: 200, body: presentAlias(row) };
}

export function accessHandlers(): RouteDef[] {
  const knownPerms = (e: Engine, keys: string[]) => {
    for (const k of keys) if (!e.db.permissions.find((p) => p.key === k)) throw new EmulatorError('VALIDATION_FAILED', `Unknown permission ${k}.`, 'permissions');
  };
  return [
    { method: 'GET', pattern: '/v1/roles', handler: (c) => listReply(c, c.engine.db.roles.all().reverse(), (r) => presentRole(c.engine, r)) },
    {
      method: 'POST',
      pattern: '/v1/roles',
      handler: (c) => {
        const e = c.engine;
        const key = String(need(c.body, 'key'));
        if (key.startsWith('sys_')) throw new EmulatorError('VALIDATION_FAILED', 'The sys_ prefix is reserved.', 'key');
        if (e.db.roles.find((r) => r.key === key)) throw new EmulatorError('IDENTIFIER_EXISTS', `The role ${key} exists.`, 'key');
        const permissions: string[] = resolveAliases(e, c.body.permissions ?? []);
        knownPerms(e, permissions);
        const r = e.db.roles.insert({ key, name: String(c.body.name ?? key), description: c.body.description ?? null, is_system: false, visibility: c.body.visibility ?? 'public', permissions, created_at: e.clock.now() });
        e.webhooks.emit('role.created', presentRole(e, r));
        return { status: 201, body: presentRole(e, r) };
      },
    },
    {
      method: 'PATCH',
      pattern: '/v1/roles/:id',
      handler: (c) => {
        const e = c.engine;
        const r = liveRole(e, c.params.id);
        if (r.is_system) throw new EmulatorError('FORBIDDEN', 'System roles cannot be changed.');
        for (const k of ['name', 'description', 'visibility']) if (k in c.body) r[k] = c.body[k];
        e.webhooks.emit('role.updated', presentRole(e, r));
        return { body: presentRole(e, r) };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/roles/:id',
      handler: (c) => {
        const e = c.engine;
        const r = liveRole(e, c.params.id);
        if (r.is_system) throw new EmulatorError('FORBIDDEN', 'System roles cannot be deleted.');
        if (e.db.memberships.find((m) => m.role === r.key)) throw new EmulatorError('ROLE_IN_USE', 'Members still hold this role.');
        e.db.roles.delete(r.id);
        e.webhooks.emit('role.deleted', { object: 'role', id: r.id, key: r.key });
        return { body: { object: 'role', id: r.id, deleted: true } };
      },
    },
    {
      method: 'PUT',
      pattern: '/v1/roles/:id/permissions',
      handler: (c) => {
        const e = c.engine;
        const r = liveRole(e, c.params.id);
        const permissions: string[] = resolveAliases(e, need(c.body, 'permissions'));
        knownPerms(e, permissions);
        r.permissions = permissions;
        e.webhooks.emit('role.updated', presentRole(e, r));
        return { body: presentRole(e, r) };
      },
    },
    { method: 'GET', pattern: '/v1/permissions', handler: (c) => listReply(c, c.engine.db.permissions.all().reverse(), (p) => presentPermission(c.engine, p)) },
    {
      method: 'POST',
      pattern: '/v1/permissions',
      handler: (c) => {
        const e = c.engine;
        const key = String(need(c.body, 'key'));
        if (!/^[a-z][a-z0-9_]*(:[a-z0-9_]+)+$/.test(key)) throw new EmulatorError('VALIDATION_FAILED', 'Permission keys look like org:invoices:manage.', 'key');
        if (e.db.permissions.find((p) => p.key === key) || e.db.permissionAliases.find((x) => x.alias === key)) throw new EmulatorError('IDENTIFIER_EXISTS', `The permission ${key} exists.`, 'key');
        const p = e.db.permissions.insert({ key, name: String(c.body.name ?? key), description: c.body.description ?? null, is_system: false });
        return { status: 201, body: presentPermission(e, p) };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/permissions/:id/rename',
      handler: (c) => {
        const e = c.engine;
        const p = e.db.permissions.get(c.params.id);
        if (!p) throw notFound('Permission');
        if (p.is_system) throw new EmulatorError('FORBIDDEN', 'System permissions cannot be renamed.');
        const key = String(need(c.body, 'key'));
        if (!/^[a-z][a-z0-9_]*(:[a-z0-9_]+)+$/.test(key)) throw new EmulatorError('VALIDATION_FAILED', 'Permission keys look like org:invoices:manage.', 'key');
        if (e.db.permissions.find((x) => x.key === key) || e.db.permissionAliases.find((x) => x.alias === key && x.permission_key !== p.key)) throw new EmulatorError('IDENTIFIER_EXISTS', 'A permission or alias with that key exists.', 'key');
        const old = p.key as string;
        p.key = key;
        for (const r of e.db.roles.all()) r.permissions = (r.permissions as string[]).map((k) => (k === old ? key : k));
        for (const m of e.db.memberships.all()) if (Array.isArray(m.permissions)) m.permissions = (m.permissions as string[]).map((k) => (k === old ? key : k));
        for (const a of e.db.permissionAliases.all()) if (a.permission_key === old) a.permission_key = key;
        for (const a of e.db.permissionAliases.filter((x) => x.alias === key)) e.db.permissionAliases.delete(a.id);
        e.db.permissionAliases.insert({ alias: old, permission_key: key, created_at: e.clock.now() });
        e.webhooks.emit('permission.updated', { ...presentPermission(e, p), previous_key: old });
        return { body: { object: 'permission', id: p.id, key, previous_key: old, alias: old } };
      },
    },
    { method: 'GET', pattern: '/v1/permission_aliases', handler: (c) => listReply(c, c.engine.db.permissionAliases.all(), presentAlias) },
    {
      method: 'POST',
      pattern: '/v1/permission_aliases',
      handler: (c) => setAlias(c.engine, String(need(c.body, 'alias')), need(c.body, 'permission_key')),
    },
    {
      method: 'PUT',
      pattern: '/v1/permission_aliases/:alias',
      handler: (c) => setAlias(c.engine, c.params.alias!, need(c.body, 'permission_key')),
    },
    {
      method: 'DELETE',
      pattern: '/v1/permission_aliases/:alias',
      handler: (c) => {
        const a = c.engine.db.permissionAliases.find((x) => x.alias === c.params.alias);
        if (!a) throw notFound('Alias');
        c.engine.db.permissionAliases.delete(a.id);
        return { body: { object: 'permission_alias', alias: a.alias, deleted: true } };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/permissions/:id',
      handler: (c) => {
        const e = c.engine;
        const p = e.db.permissions.get(c.params.id);
        if (!p) throw notFound('Permission');
        if (p.is_system) throw new EmulatorError('FORBIDDEN', 'System permissions cannot be deleted.');
        e.db.permissions.delete(p.id);
        for (const r of e.db.roles.all()) r.permissions = (r.permissions as string[]).filter((k) => k !== p.key);
        return { body: { object: 'permission', id: p.id, deleted: true } };
      },
    },
  ];
}
