/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteContext, RouteDef } from '../engine';
import { EmulatorError, notFound } from '../errors';
import type { Obj } from '../openapi';
import { Table, randomToken } from '../store';
import { bad, canonical, conflict, hex, isObj, listOf, pageReply } from './emu4-shared';
import { verificationRows } from './emu4-minors';
import { dsrRows } from './emu3-misc';
import { signalTable, signalView } from './ndb-misc';
import { scimRequestLog } from './scim';
import { addMember } from './orgs';
import { engineState } from './support';
import { presentUser } from './users';

/**
 * Organization depth and the older instance surfaces: MFA campaigns, role sets and policies, seats, organization templates,
 * membership and invitation imports, the IT-admin view (health, SCIM request log, directory sync runs, SSO test and history),
 * organization webhook endpoints, risk signals and their replay, abuse signals, user traits schema, identity checks, web bot
 * auth, key rotation drills and the read-only config and feed routes.
 * shortcut: the emulator has no enforcement of role sets, seat limits or MFA campaigns at sign-in; the records, validation and
 * answers are real, the enforcement is not. Nothing here reaches an identity provider, a directory or a KMS.
 */
const DAY = 86_400_000;
const FACTORS = ['totp', 'sms', 'passkey', 'push'];
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,63}$/;

const gt = (e: Engine, name: string, prefix: string): Table => {
  let t = e.generic.get(name);
  if (!t) e.generic.set(name, (t = new Table(name, e.clock.now, prefix)));
  return t;
};
const liveOrg = (e: Engine, id: string | undefined): Obj => {
  const o = e.db.organizations.get(id);
  if (!o || o.deleted) throw notFound('Organization');
  return o;
};
const liveUser = (e: Engine, id: string | undefined): Obj => {
  const u = e.db.users.get(id);
  if (!u || u.deleted) throw notFound('User');
  return u;
};
const strOrNull = (v: unknown, param: string, max = 500): string | null => {
  if (v === null) return null;
  if (typeof v !== 'string' || v.length > max) throw bad(`${param} is a string of at most ${max} characters or null.`, param);
  return v;
};
const strList = (v: unknown, param: string, max: number): string[] => {
  if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== 'string' || x === '')) throw bad(`${param} is a list of at most ${max} strings.`, param);
  return v as string[];
};
const unknownField = (b: Obj, allowed: string[]): void => {
  const k = Object.keys(b).find((x) => !allowed.includes(x));
  if (k) throw bad(`Unrecognised field ${k}. Expected any of ${allowed.join(', ')}.`, k);
};
const intOrNull = (v: unknown, param: string, min: number, max: number): number | null => {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw bad(`${param} is a whole number from ${min} to ${max}, or null.`, param);
  return v;
};
const parseTime = (v: unknown, param: string): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : Date.parse(String(v));
  if (Number.isNaN(n)) throw bad(`${param} is epoch milliseconds or an ISO 8601 time.`, param);
  return n;
};
const ack = (object: string, id: string, flag = 'deleted'): Obj => ({ object, id, [flag]: true });

interface State {
  campaigns: Table;
  campaignUsers: Map<string, Map<string, Obj>>;
  roleSets: Table;
  templates: Table;
  abuse: Table;
  syncRuns: Table;
  logins: Table;
  orgDeliveries: Table;
  drills: Table;
  traits: Obj;
  botLists: { allow: Obj[]; block: Obj[] };
  botSeen: Set<string>;
  adopted: Map<string, Obj>;
  adoptionCodes: Map<string, Obj>;
  imports: Table;
}
const st = engineState((e: Engine): State => ({
  campaigns: new Table('mfa_campaigns', e.clock.now, 'mfac'), campaignUsers: new Map(), roleSets: new Table('org_role_sets', e.clock.now, 'ors'), templates: new Table('org_templates', e.clock.now, 'ot'),
  abuse: new Table('abuse_signals', e.clock.now, 'abs'), syncRuns: new Table('directory_sync_runs', e.clock.now, 'dsr'), logins: new Table('sso_login_attempts', e.clock.now, 'ssol'),
  orgDeliveries: new Table('org_webhook_deliveries', e.clock.now, 'owd'), drills: new Table('data_key_drills', e.clock.now, 'dkd'), traits: { version: 0, enforcement: 'off', schemas: {}, updated_at: null },
  botLists: { allow: [], block: [] }, botSeen: new Set(), adopted: new Map(), adoptionCodes: new Map(), imports: new Table('org_membership_imports', e.clock.now, 'job'),
}));

// ── MFA campaigns ──

const hasSecondFactor = (u: Obj): boolean => u.mfa_enabled === true || u.totp_enabled === true;
function targetedUsers(e: Engine, c: Obj): Obj[] {
  const live = e.db.users.filter((u) => !u.deleted);
  if (c.target_type === 'all') return live;
  if (c.target_type === 'org') return live.filter((u) => e.db.memberships.some((m) => m.user_id === u.id && m.organization_id === c.target_value));
  if (c.target_type === 'role') return live.filter((u) => e.db.memberships.some((m) => m.user_id === u.id && m.role === c.target_value));
  return live.filter((u) => Array.isArray(u.groups) && u.groups.includes(c.target_value));
}
const campaignUsers = (e: Engine, id: string): Map<string, Obj> => {
  const m = st(e).campaignUsers.get(id) ?? new Map<string, Obj>();
  st(e).campaignUsers.set(id, m);
  return m;
};
function campaignView(e: Engine, c: Obj): Obj {
  const users = targetedUsers(e, c);
  const rows = [...campaignUsers(e, c.id).values()];
  const now = e.clock.now();
  return {
    object: 'mfa_campaign', id: c.id, name: c.name, target_type: c.target_type, target_value: c.target_value, required_factors: c.required_factors, starts_at: c.starts_at, grace_until: c.grace_until, nag_interval_days: c.nag_interval_days, enforce: c.enforce, status: c.status, ended_at: c.ended_at ?? null, created_at: c.created_at, updated_at: c.updated_at,
    metrics: { targeted: users.length, enrolled: users.filter(hasSecondFactor).length, nagged: rows.filter((r) => r.nag_count > 0).length, exempt: rows.filter((r) => r.exempt_until && r.exempt_until > now).length },
  };
}
function campaignUserView(e: Engine, c: Obj, userId: string, withEffective: boolean): Obj {
  const row = campaignUsers(e, c.id).get(userId) ?? { campaign_id: c.id, user_id: userId, required_factors: null, exempt_until: null, nag_count: 0, last_nagged_at: null, dismissed_at: null, enrolled_at: null };
  const u = e.db.users.get(userId);
  const base: Obj = { object: 'mfa_campaign_user', campaign_id: c.id, user_id: userId, required_factors: row.required_factors, exempt_until: row.exempt_until, nag_count: row.nag_count, last_nagged_at: row.last_nagged_at, dismissed_at: row.dismissed_at, enrolled_at: row.enrolled_at };
  if (!withEffective) return base;
  const now = e.clock.now();
  const satisfied = !!u && hasSecondFactor(u);
  const inGrace = c.grace_until !== null && now < c.grace_until;
  const phase = row.exempt_until && row.exempt_until > now ? 'exempt' : satisfied ? 'satisfied' : c.status === 'ended' || inGrace || !c.enforce ? 'nag' : 'enforcing';
  return { ...base, targeted: !!u && targetedUsers(e, c).some((x) => x.id === userId), effective: { phase, required_factors: row.required_factors ?? c.required_factors, satisfied, days_left: c.grace_until === null ? null : Math.max(0, Math.ceil((c.grace_until - now) / DAY)) } };
}
function factorList(v: unknown, param: string): string[] {
  if (!Array.isArray(v) || v.some((f) => !FACTORS.includes(f))) throw bad(`${param} is a list of: ${FACTORS.join(', ')}.`, param);
  return [...new Set(v as string[])];
}

function campaignRoutes(): RouteDef[] {
  const one = (e: Engine, id: string | undefined): Obj => {
    const c = st(e).campaigns.get(id);
    if (!c) throw notFound('MFA campaign');
    return c;
  };
  const FIELDS = ['name', 'target_type', 'target_value', 'required_factors', 'starts_at', 'grace_until', 'nag_interval_days', 'enforce'];
  return [
    { method: 'GET', pattern: '/v1/mfa_campaigns', handler: (c) => ({ body: pageReply(c, st(c.engine).campaigns.all().map((x) => campaignView(c.engine, x))) }) },
    { method: 'POST', pattern: '/v1/mfa_campaigns', handler: (c) => {
      const e = c.engine;
      const b = c.body;
      unknownField(b, FIELDS);
      if (typeof b.name !== 'string' || !b.name || b.name.length > 120) throw bad('name is 1 to 120 characters.', 'name');
      const target = b.target_type ?? 'all';
      if (!['all', 'group', 'org', 'role'].includes(target)) throw bad('target_type is all, group, org or role.', 'target_type');
      if (target !== 'all' && (typeof b.target_value !== 'string' || !b.target_value)) throw bad(`target_value is required for ${target}.`, 'target_value');
      if (target === 'org' && !e.db.organizations.get(b.target_value)) throw bad('target_value is not an organization.', 'target_value');
      const now = e.clock.now();
      const starts = b.starts_at === undefined ? now : parseTime(b.starts_at, 'starts_at');
      const grace = b.grace_until === undefined ? null : parseTime(b.grace_until, 'grace_until');
      if (grace !== null && grace <= starts) throw bad('grace_until must be after starts_at.', 'grace_until');
      const nag = b.nag_interval_days ?? 3;
      if (!Number.isInteger(nag) || nag < 1 || nag > 90) throw bad('nag_interval_days is 1 to 90.', 'nag_interval_days');
      if (b.enforce !== undefined && typeof b.enforce !== 'boolean') throw bad('enforce is true or false.', 'enforce');
      const row = st(e).campaigns.insert({ name: b.name, target_type: target, target_value: target === 'all' ? null : b.target_value, required_factors: b.required_factors === undefined ? [] : factorList(b.required_factors, 'required_factors'), starts_at: starts, grace_until: grace, nag_interval_days: nag, enforce: b.enforce === true, status: 'active', ended_at: null, created_at: now, updated_at: now } as any);
      e.webhooks.emit('mfa_campaign.created', { object: 'mfa_campaign', id: row.id, name: row.name, target_type: row.target_type });
      return { status: 201, body: campaignView(e, row) };
    } },
    { method: 'GET', pattern: '/v1/mfa_campaigns/:id', handler: (c) => ({ body: campaignView(c.engine, one(c.engine, c.params.id)) }) },
    { method: 'PATCH', pattern: '/v1/mfa_campaigns/:id', handler: (c) => {
      const e = c.engine;
      const row = one(e, c.params.id);
      const b = c.body;
      unknownField(b, ['name', 'required_factors', 'grace_until', 'nag_interval_days', 'enforce']);
      if (row.status === 'ended') throw conflict('This campaign has ended: start another.');
      if (b.name !== undefined) {
        if (typeof b.name !== 'string' || !b.name || b.name.length > 120) throw bad('name is 1 to 120 characters.', 'name');
        row.name = b.name;
      }
      if (b.required_factors !== undefined) row.required_factors = factorList(b.required_factors, 'required_factors');
      if (b.grace_until !== undefined) {
        const g = b.grace_until === null ? null : parseTime(b.grace_until, 'grace_until');
        if (g !== null && g <= row.starts_at) throw bad('grace_until must be after starts_at.', 'grace_until');
        row.grace_until = g;
      }
      if (b.nag_interval_days !== undefined) {
        if (!Number.isInteger(b.nag_interval_days) || b.nag_interval_days < 1 || b.nag_interval_days > 90) throw bad('nag_interval_days is 1 to 90.', 'nag_interval_days');
        row.nag_interval_days = b.nag_interval_days;
      }
      if (b.enforce !== undefined) {
        if (typeof b.enforce !== 'boolean') throw bad('enforce is true or false.', 'enforce');
        row.enforce = b.enforce;
      }
      row.updated_at = e.clock.now();
      return { body: campaignView(e, row) };
    } },
    { method: 'DELETE', pattern: '/v1/mfa_campaigns/:id', handler: (c) => {
      const e = c.engine;
      const row = one(e, c.params.id);
      if (row.status !== 'ended') Object.assign(row, { status: 'ended', ended_at: e.clock.now(), updated_at: e.clock.now() });
      return { body: campaignView(e, row) };
    } },
    { method: 'GET', pattern: '/v1/mfa_campaigns/:id/users', handler: (c) => {
      const e = c.engine;
      const row = one(e, c.params.id);
      const limit = Math.min(500, Math.max(1, Number(c.query.get('limit') ?? 50) || 50));
      const data = [...campaignUsers(e, row.id).values()].reverse().slice(0, limit).map((u) => campaignUserView(e, row, u.user_id, false));
      return { body: { object: 'list', data, has_more: campaignUsers(e, row.id).size > data.length, next_cursor: null } };
    } },
    { method: 'GET', pattern: '/v1/mfa_campaigns/:id/users/:user_id', handler: (c) => {
      const e = c.engine;
      const row = one(e, c.params.id);
      liveUser(e, c.params.user_id);
      return { body: campaignUserView(e, row, c.params.user_id!, true) };
    } },
    { method: 'PUT', pattern: '/v1/mfa_campaigns/:id/users/:user_id', handler: (c) => {
      const e = c.engine;
      const row = one(e, c.params.id);
      liveUser(e, c.params.user_id);
      const b = c.body;
      unknownField(b, ['required_factors', 'exempt_until']);
      const users = campaignUsers(e, row.id);
      const cur = users.get(c.params.user_id!) ?? { campaign_id: row.id, user_id: c.params.user_id, required_factors: null, exempt_until: null, nag_count: 0, last_nagged_at: null, dismissed_at: null, enrolled_at: null };
      if (b.required_factors !== undefined) cur.required_factors = b.required_factors === null ? null : factorList(b.required_factors, 'required_factors');
      if (b.exempt_until !== undefined) {
        if (b.exempt_until !== null && (typeof b.exempt_until !== 'number' || b.exempt_until <= e.clock.now())) throw bad('exempt_until is epoch milliseconds in the future, or null.', 'exempt_until');
        cur.exempt_until = b.exempt_until;
      }
      users.set(c.params.user_id!, cur);
      return { body: campaignUserView(e, row, c.params.user_id!, true) };
    } },
  ];
}

// ── role sets, role policy, seats, templates ──

const roleSetView = (r: Obj): Obj => ({ object: 'org_role_set', id: r.id, key: r.key, name: r.name, description: r.description ?? null, role_keys: r.role_keys, default_role_key: r.default_role_key ?? null, created_at: r.created_at, updated_at: r.updated_at });
const templateView = (t: Obj): Obj => ({ object: 'org_template', id: t.id, key: t.key, name: t.name, description: t.description ?? null, roles: t.roles, policy: t.policy, role_set: t.role_set ?? null, default_role: t.default_role ?? null, max_allowed_memberships: t.max_allowed_memberships ?? null, seat_warn_percent: t.seat_warn_percent ?? null, public_metadata: t.public_metadata, private_metadata: t.private_metadata, created_at: t.created_at, updated_at: t.updated_at });
const findBy = (t: Table, ref: string | undefined): Obj | undefined => t.get(ref) ?? t.find((r) => r.key === ref);

function seatsView(e: Engine, o: Obj): Obj {
  const used = e.db.memberships.filter((m) => m.organization_id === o.id).length;
  const pending = e.db.orgInvitations.filter((i) => i.organization_id === o.id && i.status === 'pending' && (!i.expires_at || i.expires_at > e.clock.now())).length;
  const limit: number | null = o.max_allowed_memberships ?? null;
  const percent = limit === null ? null : limit === 0 ? 100 : Math.round((used / limit) * 100);
  const warn: number | null = o.seat_warn_percent ?? null;
  return { object: 'organization_seats', organization_id: o.id, limit, used, pending_invitations: pending, available: limit === null ? null : Math.max(0, limit - used - pending), percent_used: percent, warn_percent: warn, state: limit !== null && used >= limit ? 'full' : limit !== null && warn !== null && percent !== null && percent >= warn ? 'low' : 'ok' };
}
function rolePolicyView(e: Engine, o: Obj): Obj {
  const set = o.role_set_id ? st(e).roleSets.get(o.role_set_id) : undefined;
  const allowed = set ? [...new Set(['org:admin', ...set.role_keys])] : null;
  const own = o.default_role ?? null;
  return { object: 'organization_role_policy', organization_id: o.id, role_set: set ? { id: set.id, key: set.key } : null, allowed_roles: allowed, default_role: own ?? set?.default_role_key ?? 'org:member', default_role_source: own ? 'organization' : set?.default_role_key ? 'role_set' : 'system' };
}

function orgDepthRoutes(): RouteDef[] {
  const knownRole = (e: Engine, key: string): boolean => key === 'org:admin' || e.db.roles.some((r) => r.key === key);
  const SET_FIELDS = ['key', 'name', 'description', 'role_keys', 'default_role_key'];
  const T_FIELDS = ['key', 'name', 'description', 'roles', 'policy', 'role_set', 'default_role', 'max_allowed_memberships', 'seat_warn_percent', 'public_metadata', 'private_metadata'];
  const setFields = (e: Engine, b: Obj, cur?: Obj): Obj => {
    const out: Obj = {};
    if (b.name !== undefined || !cur) {
      if (typeof b.name !== 'string' || !b.name || b.name.length > 200) throw bad('name is 1 to 200 characters.', 'name');
      out.name = b.name;
    }
    if (b.description !== undefined) out.description = strOrNull(b.description, 'description');
    if (b.role_keys !== undefined) {
      out.role_keys = strList(b.role_keys, 'role_keys', 50);
      const missing = (out.role_keys as string[]).find((k) => !knownRole(e, k));
      if (missing) throw bad(`${missing} is not an instance-wide role.`, 'role_keys');
    }
    const keys: string[] = out.role_keys ?? cur?.role_keys ?? [];
    if (b.default_role_key !== undefined) {
      const d = strOrNull(b.default_role_key, 'default_role_key', 200);
      if (d !== null && d !== 'org:admin' && !keys.includes(d)) throw bad('default_role_key must be one of role_keys (or org:admin).', 'default_role_key');
      out.default_role_key = d;
    }
    return out;
  };
  const tmplFields = (e: Engine, b: Obj, cur?: Obj): Obj => {
    const out: Obj = {};
    if (b.name !== undefined || !cur) {
      if (typeof b.name !== 'string' || !b.name || b.name.length > 200) throw bad('name is 1 to 200 characters.', 'name');
      out.name = b.name;
    }
    if (b.description !== undefined) out.description = strOrNull(b.description, 'description');
    if (b.roles !== undefined) {
      if (!Array.isArray(b.roles) || b.roles.length > 25) throw bad('roles is a list of at most 25 roles.', 'roles');
      out.roles = b.roles.map((r: unknown, i: number) => {
        if (!isObj(r) || typeof r.key !== 'string' || typeof r.name !== 'string') throw bad(`roles.${i} needs key and name.`, 'roles');
        unknownField(r, ['key', 'name', 'description', 'permissions']);
        if (e.db.roles.some((x) => x.key === r.key && x.is_system)) throw bad(`${r.key} is a system role.`, 'roles');
        const perms = r.permissions === undefined ? [] : strList(r.permissions, `roles.${i}.permissions`, 200);
        const missing = perms.find((p) => !e.db.permissions.some((x) => x.key === p));
        if (missing) throw bad(`Unknown permission ${missing}.`, 'roles');
        return { key: r.key, name: r.name, description: r.description ?? null, permissions: perms };
      });
    }
    if (b.policy !== undefined && !isObj(b.policy)) throw bad('policy is an object.', 'policy');
    if (b.role_set !== undefined && b.role_set !== null && !findBy(st(e).roleSets, b.role_set)) throw bad('role_set names no role set.', 'role_set');
    if (b.default_role !== undefined) strOrNull(b.default_role, 'default_role', 200);
    if (b.max_allowed_memberships !== undefined) intOrNull(b.max_allowed_memberships, 'max_allowed_memberships', 0, 1_000_000);
    if (b.seat_warn_percent !== undefined) intOrNull(b.seat_warn_percent, 'seat_warn_percent', 1, 100);
    for (const k of ['policy', 'role_set', 'default_role', 'max_allowed_memberships', 'seat_warn_percent', 'public_metadata', 'private_metadata']) if (b[k] !== undefined) out[k] = k === 'role_set' && b[k] ? findBy(st(e).roleSets, b[k])!.key : b[k];
    return out;
  };
  return [
    { method: 'GET', pattern: '/v1/org_role_sets', handler: (c) => ({ body: pageReply(c, st(c.engine).roleSets.all().map(roleSetView)) }) },
    { method: 'POST', pattern: '/v1/org_role_sets', handler: (c) => {
      const e = c.engine;
      unknownField(c.body, SET_FIELDS);
      if (typeof c.body.key !== 'string' || !SLUG.test(c.body.key)) throw bad('key is letters, digits and _ : - (up to 64).', 'key');
      if (st(e).roleSets.find((r) => r.key === c.body.key)) throw conflict('That role set key is taken.');
      const now = e.clock.now();
      const row = st(e).roleSets.insert({ key: c.body.key, description: null, role_keys: [], default_role_key: null, ...setFields(e, c.body), created_at: now, updated_at: now } as any);
      return { status: 201, body: roleSetView(row) };
    } },
    { method: 'GET', pattern: '/v1/org_role_sets/:id', handler: (c) => {
      const r = findBy(st(c.engine).roleSets, c.params.id);
      if (!r) throw notFound('Role set');
      return { body: roleSetView(r) };
    } },
    { method: 'PATCH', pattern: '/v1/org_role_sets/:id', handler: (c) => {
      const e = c.engine;
      const r = findBy(st(e).roleSets, c.params.id);
      if (!r) throw notFound('Role set');
      unknownField(c.body, SET_FIELDS);
      if (c.body.key !== undefined && c.body.key !== r.key) throw bad('The key is fixed at create.', 'key');
      Object.assign(r, setFields(e, c.body, r), { updated_at: e.clock.now() });
      return { body: roleSetView(r) };
    } },
    { method: 'DELETE', pattern: '/v1/org_role_sets/:id', handler: (c) => {
      const e = c.engine;
      const r = findBy(st(e).roleSets, c.params.id);
      if (!r) throw notFound('Role set');
      if (e.db.organizations.some((o) => !o.deleted && o.role_set_id === r.id)) throw conflict('An organization still uses this role set.');
      st(e).roleSets.delete(r.id);
      return { body: ack('org_role_set', r.id) };
    } },
    { method: 'GET', pattern: '/v1/organizations/:id/role_policy', handler: (c) => ({ body: rolePolicyView(c.engine, liveOrg(c.engine, c.params.id)) }) },
    { method: 'PUT', pattern: '/v1/organizations/:id/role_policy', handler: (c) => {
      const e = c.engine;
      const o = liveOrg(e, c.params.id);
      unknownField(c.body, ['role_set', 'default_role']);
      let set: Obj | undefined = o.role_set_id ? st(e).roleSets.get(o.role_set_id) : undefined;
      if (c.body.role_set !== undefined) {
        if (c.body.role_set === null) set = undefined;
        else {
          set = typeof c.body.role_set === 'string' ? findBy(st(e).roleSets, c.body.role_set) : undefined;
          if (!set) throw bad('role_set names no role set.', 'role_set');
        }
      }
      const def = c.body.default_role === undefined ? (o.default_role ?? null) : strOrNull(c.body.default_role, 'default_role', 200);
      if (def !== null && set && def !== 'org:admin' && !set.role_keys.includes(def) && !e.db.roles.some((r) => r.key === def && !r.is_system)) throw new EmulatorError('VALIDATION_FAILED', 'default_role is not allowed by the role set.', 'default_role');
      Object.assign(o, { role_set_id: set?.id ?? null, default_role: def });
      return { body: rolePolicyView(e, o) };
    } },
    { method: 'GET', pattern: '/v1/organizations/:id/seats', handler: (c) => ({ body: seatsView(c.engine, liveOrg(c.engine, c.params.id)) }) },
    { method: 'PUT', pattern: '/v1/organizations/:id/seats', handler: (c) => {
      const e = c.engine;
      const o = liveOrg(e, c.params.id);
      unknownField(c.body, ['limit', 'warn_percent']);
      if (c.body.limit !== undefined) o.max_allowed_memberships = intOrNull(c.body.limit, 'limit', 0, 1_000_000);
      if (c.body.warn_percent !== undefined) o.seat_warn_percent = intOrNull(c.body.warn_percent, 'warn_percent', 1, 100);
      const v = seatsView(e, o);
      if (v.state === 'full') e.webhooks.emit('organization.seat_limit_reached', { object: 'organization_seats', organization_id: o.id, limit: v.limit, used: v.used });
      else if (v.state === 'low') e.webhooks.emit('organization.seats_low', { object: 'organization_seats', organization_id: o.id, limit: v.limit, used: v.used, percent_used: v.percent_used });
      return { body: v };
    } },
    { method: 'GET', pattern: '/v1/org_templates', handler: (c) => ({ body: pageReply(c, st(c.engine).templates.all().map(templateView)) }) },
    { method: 'POST', pattern: '/v1/org_templates', handler: (c) => {
      const e = c.engine;
      unknownField(c.body, T_FIELDS);
      if (typeof c.body.key !== 'string' || !SLUG.test(c.body.key)) throw bad('key is letters, digits and _ : - (up to 64).', 'key');
      if (st(e).templates.find((t) => t.key === c.body.key)) throw conflict('That template key is taken.');
      const now = e.clock.now();
      const row = st(e).templates.insert({ key: c.body.key, description: null, roles: [], policy: {}, public_metadata: {}, private_metadata: {}, ...tmplFields(e, c.body), created_at: now, updated_at: now } as any);
      return { status: 201, body: templateView(row) };
    } },
    { method: 'GET', pattern: '/v1/org_templates/:id', handler: (c) => {
      const t = findBy(st(c.engine).templates, c.params.id);
      if (!t) throw notFound('Template');
      return { body: templateView(t) };
    } },
    { method: 'PATCH', pattern: '/v1/org_templates/:id', handler: (c) => {
      const e = c.engine;
      const t = findBy(st(e).templates, c.params.id);
      if (!t) throw notFound('Template');
      unknownField(c.body, T_FIELDS);
      if (c.body.key !== undefined && c.body.key !== t.key) throw bad('The key is fixed at create.', 'key');
      Object.assign(t, tmplFields(e, c.body, t), { updated_at: e.clock.now() });
      return { body: templateView(t) };
    } },
    { method: 'DELETE', pattern: '/v1/org_templates/:id', handler: (c) => {
      const t = findBy(st(c.engine).templates, c.params.id);
      if (!t) throw notFound('Template');
      st(c.engine).templates.delete(t.id);
      return { body: ack('org_template', t.id) };
    } },
    { method: 'POST', pattern: '/v1/org_templates/:id/organizations', handler: async (c) => {
      const e = c.engine;
      const t = findBy(st(e).templates, c.params.id);
      if (!t) throw notFound('Template');
      const b = c.body;
      unknownField(b, ['name', 'slug', 'external_id', 'created_by', 'max_allowed_memberships', 'public_metadata', 'private_metadata']);
      if (typeof b.name !== 'string' || !b.name) throw bad('name is required.', 'name');
      // The organization is created the normal way, then gets what the template carries.
      const res = await e.handle(new Request(`${e.issuer}/v1/organizations`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${e.keys[0]!.key}` }, body: JSON.stringify({ name: b.name, ...(b.slug ? { slug: b.slug } : {}), ...(b.external_id ? { external_id: b.external_id } : {}), ...(b.created_by ? { created_by: b.created_by } : {}), public_metadata: { ...t.public_metadata, ...(b.public_metadata ?? {}) }, private_metadata: { ...t.private_metadata, ...(b.private_metadata ?? {}) } }) }));
      const created = await res.json();
      if (res.status >= 400) throw new EmulatorError(created.errors?.[0]?.code ?? 'VALIDATION_FAILED', created.errors?.[0]?.message ?? 'The organization could not be created.', created.errors?.[0]?.param);
      const o = e.db.organizations.get(created.id)!;
      for (const r of t.roles as Obj[]) if (!e.db.roles.some((x) => x.key === r.key)) e.db.roles.insert({ key: r.key, name: r.name, description: r.description ?? null, is_system: false, visibility: 'public', permissions: r.permissions, created_at: e.clock.now() });
      const set = t.role_set ? findBy(st(e).roleSets, t.role_set) : undefined;
      Object.assign(o, { role_set_id: set?.id ?? null, default_role: t.default_role ?? null, max_allowed_memberships: b.max_allowed_memberships ?? t.max_allowed_memberships ?? null, seat_warn_percent: t.seat_warn_percent ?? null, policy: t.policy, template_id: t.id });
      return { status: 201, body: { ...created, max_allowed_memberships: o.max_allowed_memberships } };
    } },
  ];
}

// ── imports ──

function importRoutes(): RouteDef[] {
  return [
    { method: 'POST', pattern: '/v1/organizations/:id/membership_imports', handler: async (c) => {
      const e = c.engine;
      const o = liveOrg(e, c.params.id);
      const b = c.body;
      unknownField(b, ['memberships', 'csv', 'on_existing', 'invite_missing', 'default_role']);
      if ((b.memberships === undefined) === (b.csv === undefined)) throw bad('Send exactly one of memberships or csv.', 'memberships');
      let rows: Obj[];
      if (b.csv !== undefined) {
        if (typeof b.csv !== 'string' || b.csv.length > 2_000_000) throw bad('csv is a string of at most 2 MB.', 'csv');
        const [head, ...lines] = b.csv.split(/\r?\n/).filter((l: string) => l.trim() !== '');
        const cols = (head ?? '').split(',').map((x: string) => x.trim());
        if (!cols.some((x: string) => x === 'email' || x === 'user_id')) throw bad('The csv header needs email or user_id.', 'csv');
        rows = lines.map((l: string) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v.trim()]).filter(([k, v]) => k && v)));
      } else {
        if (!Array.isArray(b.memberships) || b.memberships.length === 0 || b.memberships.length > 5000) throw bad('memberships is a list of 1 to 5000 rows.', 'memberships');
        rows = b.memberships;
      }
      if (rows.length > 5000) throw bad('At most 5000 rows.', 'csv');
      if (b.on_existing !== undefined && b.on_existing !== 'skip' && b.on_existing !== 'update') throw bad('on_existing is skip or update.', 'on_existing');
      const policy = rolePolicyView(e, o);
      const results: Record<string, number> = { added: 0, updated: 0, skipped: 0, invited: 0 };
      let failed = 0;
      for (const r of rows) {
        const role = (r.role ?? b.default_role ?? policy.default_role) as string;
        const user = isObj(r) ? e.db.users.find((u) => !u.deleted && ((r.user_id && u.id === r.user_id) || (r.email && (u.emails as Obj[]).some((m) => m.verified && m.email_address.toLowerCase() === String(r.email).toLowerCase())))) : undefined;
        const allowed = policy.allowed_roles as string[] | null;
        if (allowed && !allowed.includes(role)) { failed++; continue; }
        if (!user) {
          if (b.invite_missing === true && typeof r.email === 'string') {
            e.db.orgInvitations.insert({ organization_id: o.id, email_address: r.email, role, status: 'pending', token: e.tokens.secret('invtok'), created_at: e.clock.now(), expires_at: e.clock.now() + 7 * DAY });
            results.invited!++;
          } else failed++;
          continue;
        }
        const existing = e.db.memberships.find((m) => m.organization_id === o.id && m.user_id === user.id);
        if (existing) {
          if (b.on_existing === 'update' && existing.role !== role) (existing.role = role, results.updated!++);
          else results.skipped!++;
          continue;
        }
        const seats = seatsView(e, o);
        if (seats.state === 'full') { failed++; continue; }
        addMember(e, o.id, user.id, role);
        results.added!++;
      }
      const now = e.clock.now();
      const job = st(e).imports.insert({ type: 'org_membership_import', status: 'completed', total: rows.length, processed: rows.length, succeeded: rows.length - failed, failed, error_count: failed, results, created_at: now, updated_at: now, completed_at: now } as any);
      return { status: 202, body: { object: 'job', ...job } };
    } },
    { method: 'POST', pattern: '/v1/organizations/:id/invitations/import', handler: (c) => {
      const e = c.engine;
      const o = liveOrg(e, c.params.id);
      const b = c.body;
      if (!Array.isArray(b.invitations) || b.invitations.length < 1 || b.invitations.length > 500) throw bad('invitations is a list of 1 to 500 rows.', 'invitations');
      const dry = b.dry_run === true;
      const data: Obj[] = [];
      let created = 0, unchanged = 0, invalid = 0;
      b.invitations.forEach((r: any, index: number) => {
        const err = (code: string, message: string, param: string) => (invalid++, data.push({ index, status: 'invalid_row', code, message, param }));
        if (!isObj(r) || typeof r.email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email)) return err('invalid_email', 'email is an address.', 'email');
        if (typeof r.role !== 'string' || !r.role) return err('invalid_role', 'role is required.', 'role');
        if (typeof r.token_sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(r.token_sha256)) return err('invalid_token_sha256', 'token_sha256 is the hex SHA-256 of the issued token.', 'token_sha256');
        const exp = r.expires_at === undefined ? e.clock.now() + 7 * DAY : parseTime(r.expires_at, 'expires_at');
        const hash = r.token_sha256.toLowerCase();
        const same = e.db.orgInvitations.find((i) => i.organization_id === o.id && i.status === 'pending' && String(i.email_address).toLowerCase() === r.email.toLowerCase());
        if (same && same.token_sha256 === hash) return (unchanged++, data.push({ index, status: 'unchanged', id: same.id }));
        if (same) return err('invitation_exists', 'A pending invitation to this address has another token.', 'email');
        if (dry) return (created++, data.push({ index, status: 'would_create' }));
        const row = e.db.orgInvitations.insert({ organization_id: o.id, email_address: r.email, role: r.role, status: 'pending', token: null, token_sha256: hash, created_at: e.clock.now(), expires_at: exp, public_metadata: r.public_metadata ?? {} } as any);
        created++;
        data.push({ index, status: 'created', id: row.id });
      });
      return { body: { object: 'organization_invitation_import', organization_id: o.id, dry_run: dry, created, unchanged, invalid, data } };
    } },
  ];
}

// ── IT-admin view ──

function itRoutes(): RouteDef[] {
  const connsOf = (e: Engine, orgId: string): Obj[] => (e.generic.get('sso_connections')?.filter((x) => x.organization_id === orgId) ?? []);
  const connView = (e: Engine, k: Obj): Obj => {
    const mine = st(e).logins.filter((l) => l.connection_id === k.id);
    const now = e.clock.now();
    const ok = mine.find((l) => l.outcome === 'success');
    const fail = mine.find((l) => l.outcome === 'failure');
    const test = mine.find((l) => l.outcome === 'test');
    const exp: number | null = k.saml_idp_certificate_expires_at ?? null;
    const days = exp === null ? null : Math.floor((exp - now) / DAY);
    return { object: 'sso_connection_health', id: k.id, type: k.type ?? 'oidc', status: k.status ?? 'draft', last_successful_login_at: ok?.created_at ?? null, last_failed_login_at: fail?.created_at ?? null, last_failure_code: fail?.failure_code ?? null, last_test_at: test?.created_at ?? null, successes_24h: mine.filter((l) => l.outcome === 'success' && now - l.created_at < DAY).length, failures_24h: mine.filter((l) => l.outcome === 'failure' && now - l.created_at < DAY).length, certificate: { status: exp === null ? 'none' : days! < 0 ? 'expired' : days! <= 30 ? 'expiring' : 'ok', expires_at: exp, days_left: days } };
  };
  const runView = (r: Obj): Obj => ({ object: 'directory_sync_run', id: r.id, kind: r.kind, source_id: r.source_id, organization_id: r.organization_id, trigger: r.trigger, status: r.status, stats: r.stats ?? {}, error: r.error ?? null, retry_of: r.retry_of ?? null, created_at: r.created_at, started_at: r.started_at ?? null, finished_at: r.finished_at ?? null });
  const conn = (e: Engine, id: string | undefined): Obj => {
    const k = e.generic.get('sso_connections')?.get(id);
    if (!k) throw notFound('SSO connection');
    return k;
  };
  return [
    { method: 'GET', pattern: '/v1/organizations/:id/it_health', handler: (c) => {
      const e = c.engine;
      const o = liveOrg(e, c.params.id);
      const now = e.clock.now();
      const conns = connsOf(e, o.id).map((k) => connView(e, k));
      const tokens = e.db.scimTokens.filter((t) => t.organization_id === o.id && !t.revoked);
      const reqs = scimRequestLog(e).filter((r) => r.organization_id === o.id);
      const day = reqs.filter((r) => now - r.created_at < DAY);
      const lastErr = reqs.find((r) => r.status >= 400);
      const runs = st(e).syncRuns.filter((r) => r.organization_id === o.id);
      const bySource = new Map<string, Obj>();
      for (const r of runs) if (!bySource.has(r.source_id)) bySource.set(r.source_id, r);
      const issues: Obj[] = [];
      for (const k of conns) {
        if (k.certificate.status === 'expired') issues.push({ code: 'sso_certificate_expired', severity: 'critical', message: 'The signing certificate has expired.', subject: k.id });
        else if (k.certificate.status === 'expiring') issues.push({ code: 'sso_certificate_expiring', severity: 'warning', message: `The signing certificate expires in ${k.certificate.days_left} days.`, subject: k.id });
        if (k.failures_24h > 0 && k.successes_24h === 0) issues.push({ code: 'sso_failing', severity: 'critical', message: 'Every sign-in through this connection failed in the last 24 hours.', subject: k.id });
      }
      if (day.length > 0 && day.every((r) => r.status >= 400)) issues.push({ code: 'scim_failing', severity: 'critical', message: 'Every SCIM request failed in the last 24 hours.', subject: null });
      for (const [id, r] of bySource) if (r.status === 'failed') issues.push({ code: 'directory_sync_failed', severity: 'warning', message: 'The last directory sync failed.', subject: id });
      const configured = conns.length > 0 || tokens.length > 0 || runs.length > 0;
      const status = !configured ? 'not_configured' : issues.some((i) => i.severity === 'critical') ? 'critical' : issues.length ? 'attention' : 'healthy';
      return { body: {
        object: 'organization_it_health', organization_id: o.id, status, checked_at: now, sso: { connections: conns },
        scim: { active_tokens: tokens.length, last_request_at: reqs[0]?.created_at ?? null, last_error_at: lastErr?.created_at ?? null, last_error: lastErr ? { status: lastErr.status, detail: lastErr.error_detail ?? null, method: lastErr.method, path: lastErr.path } : null, requests_24h: day.length, errors_24h: day.filter((r) => r.status >= 400).length, ip_restricted_tokens: tokens.filter((t) => Array.isArray(t.allowed_ips) && t.allowed_ips.length).length, profile_lock: o.scim_profile_lock === true },
        directory_sync: [...bySource.entries()].map(([id, r]) => ({ object: 'directory_sync_health', kind: r.kind, id, name: null, status: r.status === 'failed' ? 'failing' : 'ok', last_run: { id: r.id, status: r.status, error: r.error ?? null, trigger: r.trigger, created_at: r.created_at, finished_at: r.finished_at ?? null, stats: r.stats ?? {} }, last_success_at: runs.find((x) => x.source_id === id && x.status === 'succeeded')?.finished_at ?? null })),
        domains: (e.generic.get('organizations/domains')?.filter((d) => d._parent === o.id) ?? []).map((d) => ({ id: d.id, domain: d.domain ?? d.name ?? null, status: d.status ?? d.verification?.status ?? 'unverified', verification_method: d.verification_method ?? null, verified_at: d.verified_at ?? null, last_checked_at: d.last_checked_at ?? null })),
        recent_alerts: [], issues,
      } };
    } },
    { method: 'GET', pattern: '/v1/organizations/:id/scim/requests', handler: (c) => {
      const e = c.engine;
      const o = liveOrg(e, c.params.id);
      const q = c.query;
      const status = q.get('status');
      if (status && status !== 'ok' && status !== 'error') throw bad('status is ok or error.', 'status');
      const since = q.get('since') ? parseTime(q.get('since'), 'since') : e.clock.now() - 30 * DAY;
      const rows = scimRequestLog(e).filter((r) => r.organization_id === o.id && r.created_at >= since && (!status || (status === 'ok') === (r.status < 400)) && (!q.get('token_id') || r.token_id === q.get('token_id')) && (!q.get('resource') || r.resource === q.get('resource')));
      return { body: pageReply(c, rows.map((r) => ({ object: 'scim_request', id: r.id, organization_id: r.organization_id, token_id: r.token_id ?? null, method: r.method, path: r.path, resource: r.resource ?? null, status: r.status, error_detail: r.error_detail ?? null, ip: r.ip ?? null, user_agent: r.user_agent ?? null, duration_ms: r.duration_ms ?? null, created_at: r.created_at }))) };
    } },
    { method: 'GET', pattern: '/v1/organizations/:id/directory_sync_runs', handler: (c) => {
      const e = c.engine;
      const o = liveOrg(e, c.params.id);
      const status = c.query.get('status');
      if (status && !['queued', 'running', 'succeeded', 'failed'].includes(status)) throw bad('status is queued, running, succeeded or failed.', 'status');
      const limit = Math.min(100, Math.max(1, Number(c.query.get('limit') ?? 25) || 25));
      const rows = st(e).syncRuns.filter((r) => r.organization_id === o.id && (!status || r.status === status)).slice(0, limit);
      return { body: { object: 'list', data: rows.map(runView), has_more: false, next_cursor: null } };
    } },
    { method: 'POST', pattern: '/v1/organizations/:id/directory_sync_runs/:runId/retry', handler: (c) => {
      const e = c.engine;
      const o = liveOrg(e, c.params.id);
      const run = st(e).syncRuns.get(c.params.runId);
      if (!run || run.organization_id !== o.id) throw notFound('Directory sync run');
      if (run.status !== 'failed') throw bad('Only a failed run can be retried.', 'runId');
      if (st(e).syncRuns.some((r) => r.source_id === run.source_id && (r.status === 'queued' || r.status === 'running'))) throw conflict('That source already has a run queued or running.');
      const row = st(e).syncRuns.insert({ kind: run.kind, source_id: run.source_id, organization_id: o.id, trigger: 'manual', status: 'queued', stats: {}, error: null, retry_of: run.id, created_at: e.clock.now() } as any);
      return { status: 202, body: runView(row) };
    } },
    // Emulator control: a worker pass records a directory sync run (queued runs finish as asked).
    { method: 'POST', pattern: '/__emulator/organizations/:id/directory_sync_runs', public: true, handler: (c) => {
      const e = c.engine;
      const o = liveOrg(e, c.params.id);
      const status = c.body.status ?? 'succeeded';
      if (!['queued', 'running', 'succeeded', 'failed'].includes(status)) throw bad('status is queued, running, succeeded or failed.', 'status');
      const now = e.clock.now();
      const row = st(e).syncRuns.insert({ kind: c.body.kind ?? 'ldap', source_id: c.body.source_id ?? 'src_emulator', organization_id: o.id, trigger: 'schedule', status, stats: c.body.stats ?? {}, error: status === 'failed' ? (c.body.error ?? 'The directory did not answer.') : null, created_at: now, finished_at: status === 'succeeded' || status === 'failed' ? now : null } as any);
      return { status: 201, body: runView(row) };
    } },
    // Emulator control: record a sign-in through a connection (the real one comes from the browser flow).
    { method: 'POST', pattern: '/__emulator/sso_connections/:id/logins', public: true, handler: (c) => {
      const e = c.engine;
      const k = conn(e, c.params.id);
      const outcome = c.body.outcome ?? 'success';
      if (!['success', 'failure', 'test'].includes(outcome)) throw bad('outcome is success, failure or test.', 'outcome');
      const row = st(e).logins.insert({ connection_id: k.id, organization_id: k.organization_id ?? null, outcome, failure_code: outcome === 'failure' ? (c.body.failure_code ?? 'invalid_assertion') : null, user_id: c.body.user_id ?? null, method: k.type ?? null, ip: c.body.ip ?? null, created_at: e.clock.now() } as any);
      return { status: 201, body: row };
    } },
    { method: 'GET', pattern: '/v1/sso_connections/:id/login_history', handler: (c) => {
      const e = c.engine;
      const k = conn(e, c.params.id);
      const outcome = c.query.get('outcome');
      if (outcome && !['success', 'failure', 'test'].includes(outcome)) throw bad('outcome is success, failure or test.', 'outcome');
      const all = st(e).logins.filter((l) => l.connection_id === k.id && e.clock.now() - l.created_at <= 90 * DAY);
      const h = connView(e, k);
      const page = pageReply(c, all.filter((l) => !outcome || l.outcome === outcome).map((l) => ({ object: 'sso_login_attempt', id: l.id, connection_id: l.connection_id, organization_id: l.organization_id ?? null, outcome: l.outcome, failure_code: l.failure_code ?? null, user_id: l.user_id ?? null, method: l.method ?? null, ip: l.ip ?? null, created_at: l.created_at })));
      return { body: { ...page, summary: { last_successful_login_at: h.last_successful_login_at, last_failed_login_at: h.last_failed_login_at, successes_24h: h.successes_24h, failures_24h: h.failures_24h } } };
    } },
    { method: 'POST', pattern: '/v1/sso_connections/:id/test', handler: async (c) => {
      const e = c.engine;
      const k = conn(e, c.params.id);
      unknownField(c.body, ['oidc_issuer']);
      const checked: string[] = [];
      let ok = true;
      let message = 'The configuration looks complete.';
      let endpoints: Obj | null = null;
      const fail = (m: string) => ((ok = false), (message = m));
      if ((k.type ?? 'oidc') === 'saml') {
        const needs: Array<[string, unknown]> = [['saml_idp_entity_id', k.saml_idp_entity_id], ['saml_idp_sso_url', k.saml_idp_sso_url], ['saml_idp_certificate', k.saml_idp_certificate ?? k.has_saml_idp_certificate]];
        for (const [name, v] of needs) {
          checked.push(name);
          if (!v) fail(`${name} is not set.`);
        }
        if (k.saml_idp_sso_url && !String(k.saml_idp_sso_url).startsWith('https://')) fail('saml_idp_sso_url must be https.');
        if (k.saml_require_encrypted_assertions) checked.push('encryption_key');
      } else {
        const issuer = String(c.body.oidc_issuer ?? k.oidc_issuer ?? '');
        checked.push('oidc_issuer');
        if (!issuer.startsWith('https://')) fail('oidc_issuer is not an https URL.');
        else {
          try {
            const res = await (e.options.fetch ?? fetch)(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, { headers: { accept: 'application/json' } });
            const doc: any = res.ok ? await res.json() : null;
            checked.push('discovery');
            if (!doc) fail(`Discovery answered ${res.status}.`);
            else if (doc.issuer !== issuer) fail('The issuer in the discovery document does not match.');
            else endpoints = { authorization_endpoint: doc.authorization_endpoint, token_endpoint: doc.token_endpoint };
          } catch {
            fail('The issuer could not be reached.');
          }
        }
      }
      st(e).logins.insert({ connection_id: k.id, organization_id: k.organization_id ?? null, outcome: 'test', failure_code: null, method: 'config_test', created_at: e.clock.now() } as any);
      return { body: { object: 'sso_connection_test', id: k.id, ok, message, endpoints, checked, not_checked: ['client credentials', 'assertion signature'] } };
    } },
    { method: 'POST', pattern: '/v1/sso_connections/:id/test_login', handler: (c) => {
      const e = c.engine;
      const k = conn(e, c.params.id);
      if ((k.type ?? 'oidc') !== 'oidc') throw bad('An interactive test sign-in is available for OIDC connections.', 'id');
      if (!k.oidc_issuer) throw bad('The connection has no oidc_issuer.', 'id');
      const u = new URL(`${String(k.oidc_issuer).replace(/\/$/, '')}/authorize`);
      u.searchParams.set('client_id', k.oidc_client_id ?? '');
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('scope', 'openid email profile');
      u.searchParams.set('redirect_uri', `${e.issuer}/v1/sso_connections/${k.id}/test_callback`);
      u.searchParams.set('state', randomToken(16));
      st(e).logins.insert({ connection_id: k.id, organization_id: k.organization_id ?? null, outcome: 'test', failure_code: null, method: 'test_login', created_at: e.clock.now() } as any);
      return { body: { object: 'sso_connection_test_login', authorization_url: u.toString() } };
    } },
  ];
}

// ── organization webhook endpoints ──

async function signStandard(secret: string, id: string, ts: number, body: string): Promise<string> {
  const raw = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(atob(raw.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `v1,${btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${body}`)))))}`;
}

function orgWebhookRoutes(): RouteDef[] {
  const base = '/v1/organizations/:id/webhook_endpoints';
  const endpoint = (c: RouteContext): Obj => {
    const o = liveOrg(c.engine, c.params.id);
    const row = c.engine.generic.get('organizations/webhook_endpoints')?.get(c.params.endpointId);
    if (!row || row._parent !== o.id) throw notFound('Webhook endpoint');
    return row;
  };
  const ORG_EVENT = /^(organization|organization_membership|organization_invitation|organization_domain|role)\./;
  const attempt = async (e: Engine, ep: Obj, eventId: string, type: string, payload: Obj): Promise<Obj> => {
    const started = e.clock.now();
    const body = JSON.stringify({ type, data: payload });
    ep.secret ||= `whsec_${btoa(randomToken(24))}`;
    const ts = Math.floor(started / 1000);
    let status: number | null = null;
    let err: string | null = null;
    let snippet: string | null = null;
    try {
      const res = await (e.options.fetch ?? fetch)(ep.url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', 'webhook-id': eventId, 'webhook-timestamp': String(ts), 'webhook-signature': await signStandard(ep.secret, eventId, ts, body) }, body, signal: AbortSignal.timeout(10_000) });
      status = res.status;
      snippet = (await res.text()).slice(0, 1024);
      if (res.status >= 300 && res.status < 400) err = 'webhook_redirect_not_followed';
      else if (res.status >= 400) err = 'webhook_http_error';
    } catch (x) {
      err = (x as Error).name === 'TimeoutError' ? 'webhook_timeout' : 'webhook_network_error';
    }
    const ok = err === null && status !== null && status < 300;
    const row = st(e).orgDeliveries.insert({ endpoint_id: ep.id, event_id: eventId, event_type: type, status: ok ? 'success' : 'failed', http_status: status, error: err, payload, created_at: started } as any);
    return { row, ok, status, err, snippet, latency: Math.max(0, e.clock.now() - started) };
  };
  return [
    { method: 'POST', pattern: `${base}/:endpointId/reveal_secret`, handler: (c) => {
      const ep = endpoint(c);
      ep.secret ||= `whsec_${btoa(randomToken(24))}`;
      return { body: { object: 'webhook_secret', secret: ep.secret } };
    } },
    { method: 'POST', pattern: `${base}/:endpointId/test`, handler: async (c) => {
      const e = c.engine;
      const ep = endpoint(c);
      const id = e.db.newId('evt');
      const wait = c.query.get('wait');
      if (wait !== null && !/^\d+s?$/.test(wait)) throw bad('wait is a number of seconds such as 10s.', 'wait');
      if (wait === null) {
        const row = st(e).orgDeliveries.insert({ endpoint_id: ep.id, event_id: id, event_type: 'webhook.test', status: 'pending', http_status: null, error: null, payload: {}, created_at: e.clock.now() } as any);
        return { status: 201, body: { object: 'webhook_test_result', ok: false, delivery_id: row.id, event_id: id, event_type: 'webhook.test', url: ep.url, status: 'pending', http_status: null, latency_ms: null, response_snippet: null, error: null } };
      }
      const r = await attempt(e, ep, id, 'webhook.test', { object: 'webhook_test', organization_id: c.params.id });
      return { body: { object: 'webhook_test_result', ok: r.ok, delivery_id: r.row.id, event_id: id, event_type: 'webhook.test', url: ep.url, status: r.ok ? 'success' : 'failed', http_status: r.status, latency_ms: r.latency, response_snippet: r.snippet, error: r.err } };
    } },
    { method: 'POST', pattern: `${base}/:endpointId/deliveries/:deliveryId/redeliver`, handler: async (c) => {
      const e = c.engine;
      const ep = endpoint(c);
      const d = st(e).orgDeliveries.get(c.params.deliveryId);
      if (!d || d.endpoint_id !== ep.id) throw notFound('Delivery');
      if (e.clock.now() - d.created_at > 90 * DAY) throw conflict('The event has passed its 90-day retention.');
      const r = await attempt(e, ep, d.event_id, d.event_type, d.payload);
      return { status: 201, body: { object: 'webhook_delivery', id: r.row.id, event_id: d.event_id, status: r.ok ? 'success' : 'failed', note: 'Redelivered as a fresh attempt with the same event id.' } };
    } },
    { method: 'POST', pattern: `${base}/:endpointId/replay`, handler: async (c) => {
      const e = c.engine;
      const o = liveOrg(e, c.params.id);
      const ep = endpoint(c);
      if (ep.active === false || ep.disabled_at) throw conflict('The endpoint is disabled: enable it, then replay.');
      const raw = c.query.get('since') ?? c.body.since;
      if (raw === undefined || raw === null || raw === '') throw bad('since is required (a time, or "failing" for failing_since).', 'since');
      const since = raw === 'failing' ? Number(ep.failing_since ?? 0) : parseTime(raw, 'since');
      const untilRaw = c.query.get('until') ?? c.body.until;
      const until = untilRaw === undefined || untilRaw === null ? Infinity : parseTime(untilRaw, 'until');
      const types = ((c.query.get('event_type') ?? c.body.event_type) as string | undefined)?.split(',').map((s) => s.trim()).filter(Boolean);
      const subscribed = (t: string): boolean => !Array.isArray(ep.enabled_events) || ep.enabled_events.length === 0 || ep.enabled_events.includes('*') || ep.enabled_events.includes(t);
      const sent = new Set(st(e).orgDeliveries.filter((d) => d.endpoint_id === ep.id && d.status === 'success').map((d) => d.event_id));
      let queued = 0;
      for (const ev of e.webhooks.events) {
        if (queued >= 1000) break;
        const d = (ev.payload as Obj)?.data ?? {};
        if (!ORG_EVENT.test(ev.type) || (d.organization_id ?? d.id) !== o.id || ev.created_at < since || ev.created_at > until || !subscribed(ev.type) || (types && !types.includes(ev.type)) || sent.has(ev.id)) continue;
        await attempt(e, ep, ev.id, ev.type, d);
        queued++;
      }
      return { status: 202, body: { object: 'webhook_replay', endpoint_id: ep.id, since, queued } };
    } },
  ];
}

// ── risk signals, abuse signals, traits schema, small reads ──

const POINTS: Record<string, number> = { low: 10, medium: 25, high: 50, critical: 100 };

function signalRoutes(): RouteDef[] {
  const SEV = ['low', 'medium', 'high', 'critical'];
  const one = (e: Engine, id: string | undefined): Obj => {
    const r = signalTable(e).get(id);
    if (!r) throw notFound('Risk signal');
    return r;
  };
  const level = (n: number): string => (n >= 50 ? 'high' : n >= 25 ? 'medium' : 'low');
  const action = (n: number, threshold: number): string => (n >= 100 ? 'block' : n >= threshold ? 'require_second_factor' : 'none');
  return [
    { method: 'POST', pattern: '/v1/risk_signals', handler: (c) => {
      const e = c.engine;
      const b = c.body;
      const subjects = ['user_id', 'email', 'ip'].filter((k) => b[k] !== undefined);
      if (subjects.length !== 1) throw bad('Name the subject with exactly one of user_id, email or ip.', 'user_id');
      let subject: Obj;
      if (b.user_id !== undefined) subject = { type: 'user', value: liveUser(e, b.user_id).id };
      else if (b.email !== undefined) {
        const u = e.db.users.find((x) => !x.deleted && (x.emails as Obj[]).some((m) => m.verified && m.email_address.toLowerCase() === String(b.email).toLowerCase()));
        if (!u) throw bad('No user has that verified email address.', 'email');
        subject = { type: 'user', value: u.id };
      } else {
        if (typeof b.ip !== 'string' || !/^[0-9a-f:.]+$/i.test(b.ip)) throw bad('ip is an IPv4 or IPv6 address.', 'ip');
        subject = { type: 'ip', value: b.ip };
      }
      if (typeof b.signal_type !== 'string' || !/^[a-z0-9_.:-]{1,64}$/.test(b.signal_type)) throw bad('signal_type is lowercase letters, digits and _ . : - (up to 64).', 'signal_type');
      if (!SEV.includes(b.severity)) throw bad('severity is low, medium, high or critical.', 'severity');
      const ttl = b.ttl_seconds ?? 3600;
      if (!Number.isInteger(ttl) || ttl < 60 || ttl > 2_592_000) throw bad('ttl_seconds is 60 to 2592000.', 'ttl_seconds');
      if (b.metadata !== undefined && (!isObj(b.metadata) || canonical(b.metadata).length > 2048)) throw bad('metadata is an object of at most 2 KB.', 'metadata');
      const now = e.clock.now();
      const row = signalTable(e).insert({ object: 'risk_signal', subject, signal_type: b.signal_type, severity: b.severity, source: b.source ?? 'api', metadata: b.metadata ?? {}, expires_at: now + ttl * 1000, revoked_at: null, status: 'active', created_at: now } as any);
      e.webhooks.emit('risk_signal.created', { object: 'risk_signal', id: row.id, subject, signal_type: row.signal_type, severity: row.severity, expires_at: row.expires_at });
      return { status: 201, body: signalView(e, row) };
    } },
    { method: 'GET', pattern: '/v1/risk_signals', handler: (c) => {
      const e = c.engine;
      const q = c.query;
      const status = q.get('status') ?? 'all';
      if (status !== 'active' && status !== 'all') throw bad('status is active or all.', 'status');
      const limit = Math.min(200, Math.max(1, Number(q.get('limit') ?? 50) || 50));
      const before = q.get('before');
      const rows = signalTable(e).all().filter((r) => (!q.get('user_id') || (r.subject?.type === 'user' && r.subject.value === q.get('user_id'))) && (!q.get('ip') || (r.subject?.type === 'ip' && r.subject.value === q.get('ip'))) && (!before || r.created_at < Number(before))).map((r) => signalView(e, r)).filter((r) => status === 'all' || r.status === 'active');
      const data = rows.slice(0, limit);
      const more = rows.length > data.length;
      return { body: { object: 'list', data, has_more: more, next_cursor: more ? String(data[data.length - 1]!.created_at) : null } };
    } },
    { method: 'GET', pattern: '/v1/risk_signals/:id', handler: (c) => ({ body: signalView(c.engine, one(c.engine, c.params.id)) }) },
    { method: 'DELETE', pattern: '/v1/risk_signals/:id', handler: (c) => {
      const e = c.engine;
      const r = one(e, c.params.id);
      if (!r.revoked_at) r.revoked_at = e.clock.now();
      return { body: signalView(e, r) };
    } },
    { method: 'POST', pattern: '/v1/risk_based_mfa/replay', handler: (c) => {
      const e = c.engine;
      const b = c.body;
      unknownField(b, ['days', 'user_id', 'limit', 'candidate']);
      const days = b.days ?? 7;
      if (!Number.isInteger(days) || days < 1 || days > 30) throw bad('days is 1 to 30.', 'days');
      const limit = b.limit ?? 5000;
      if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw bad('limit is 1 to 10000.', 'limit');
      if (b.candidate !== undefined && !isObj(b.candidate)) throw bad('candidate is an object.', 'candidate');
      const until = e.clock.now();
      const since = until - days * DAY;
      const cur = 50;
      const cand = typeof b.candidate?.step_up_threshold === 'number' ? b.candidate.step_up_threshold : cur;
      // The recorded sign-ins are the sessions: each is scored by the signals live for its user at the time it started.
      const sessions = e.db.sessions.filter((s) => s.created_at >= since && s.created_at <= until && (!b.user_id || s.user_id === b.user_id));
      const truncated = sessions.length > limit;
      const used = sessions.slice(0, limit);
      const score = (s: Obj): number => Math.min(100, signalTable(e).filter((r) => r.subject?.type === 'user' && r.subject.value === s.user_id && r.created_at <= s.created_at && r.expires_at > s.created_at && !(r.revoked_at && r.revoked_at <= s.created_at)).reduce((n, r) => n + (POINTS[r.severity] ?? 0), 0));
      const tally = (th: number) => {
        const levels = { low: 0, medium: 0, high: 0 } as Record<string, number>;
        const actions: Record<string, number> = {};
        for (const s of used) {
          const n = score(s);
          levels[level(n)]!++;
          actions[action(n, th)] = (actions[action(n, th)] ?? 0) + 1;
        }
        return { levels, actions };
      };
      const rank: Record<string, number> = { none: 0, notify: 1, require_enroll: 2, require_second_factor: 3, block: 4 };
      const samples: Obj[] = [];
      let changed = 0, adds = 0, removes = 0;
      for (const s of used) {
        const n = score(s);
        const a = action(n, cur);
        const z = action(n, cand);
        if (a === z) continue;
        changed++;
        if (rank[z]! > rank[a]!) adds++;
        else removes++;
        if (samples.length < 25) samples.push({ user_id: s.user_id, at: s.created_at, ip: s.ip_address ?? null, current: { level: level(n), score: n, action: a, signals: [] }, candidate: { level: level(n), score: n, action: z, signals: [] } });
      }
      return { body: { object: 'risk_replay', window: { since, until, days }, truncated, sign_ins: used.length, users: new Set(used.map((s) => s.user_id)).size, current: tally(cur), candidate: tally(cand), changed, adds_friction: adds, removes_friction: removes, samples, notes: ['Sign-ins are the sessions the emulator holds; reputation feeds are not replayed.'] } };
    } },
    { method: 'GET', pattern: '/v1/abuse_signals', handler: (c) => {
      const q = c.query;
      for (const [k, allowed] of [['kind', ['sign_up', 'recovery']], ['outcome', ['allowed', 'scored', 'blocked']]] as Array<[string, string[]]>) if (q.get(k) && !allowed.includes(q.get(k)!)) throw bad(`${k} is ${allowed.join(', ')}.`, k);
      const rows = st(c.engine).abuse.filter((r) => (!q.get('kind') || r.kind === q.get('kind')) && (!q.get('outcome') || r.outcome === q.get('outcome')) && (!q.get('attempt_id') || r.attempt_id === q.get('attempt_id')));
      return { body: pageReply(c, rows.map((r) => ({ object: 'abuse_signal', id: r.id, kind: r.kind, outcome: r.outcome, ip: r.ip ?? null, asn: r.asn ?? null, attempt_id: r.attempt_id ?? null, risk_score: r.risk_score ?? null, reasons: r.reasons ?? [], created_at: r.created_at }))) };
    } },
    { method: 'GET', pattern: '/v1/abuse_signals/summary', handler: (c) => {
      const e = c.engine;
      const days = Number(c.query.get('days') ?? 7);
      if (!Number.isInteger(days) || days < 1 || days > 30) throw bad('days is 1 to 30.', 'days');
      const counts = new Map<string, Obj>();
      for (const r of st(e).abuse.filter((x) => e.clock.now() - x.created_at <= days * DAY)) {
        const k = `${r.kind}|${r.outcome}`;
        const cur = counts.get(k) ?? { kind: r.kind, outcome: r.outcome, n: 0 };
        cur.n++;
        counts.set(k, cur);
      }
      return { body: { object: 'abuse_signal_summary', days, counts: [...counts.values()] } };
    } },
    // Emulator control: record what abuse protection decided about a sign-up or recovery request.
    { method: 'POST', pattern: '/__emulator/abuse_signals', public: true, handler: (c) => {
      const e = c.engine;
      const b = c.body;
      if (!['sign_up', 'recovery'].includes(b.kind) || !['allowed', 'scored', 'blocked'].includes(b.outcome)) throw bad('kind is sign_up or recovery; outcome is allowed, scored or blocked.', 'kind');
      return { status: 201, body: st(e).abuse.insert({ kind: b.kind, outcome: b.outcome, ip: b.ip ?? null, asn: b.asn ?? null, attempt_id: b.attempt_id ?? null, risk_score: b.risk_score ?? null, reasons: Array.isArray(b.reasons) ? b.reasons : [], created_at: e.clock.now() } as any) };
    } },
  ];
}

const BUILTIN_FIELDS = [['email_address', 'string'], ['username', 'string'], ['first_name', 'string'], ['last_name', 'string'], ['external_id', 'string'], ['banned', 'boolean'], ['locked', 'boolean'], ['created_at', 'integer'], ['last_sign_in_at', 'integer']];
const TRAIT_TARGETS = ['public_metadata', 'unsafe_metadata', 'private_metadata', 'organization_public_metadata', 'organization_private_metadata'];

function userRoutes(): RouteDef[] {
  return [
    { method: 'GET', pattern: '/v1/instance/user_traits_schema', handler: (c) => ({ body: { object: 'user_traits_schema', ...st(c.engine).traits } }) },
    { method: 'PUT', pattern: '/v1/instance/user_traits_schema', handler: (c) => {
      const e = c.engine;
      const s = st(e).traits;
      const b = c.body;
      unknownField(b, ['schemas', 'enforcement', 'version']);
      if (b.version !== undefined && b.version !== s.version) throw conflict('The stored schema has another version: read it again.');
      if (b.enforcement !== undefined && !['off', 'warn', 'enforce'].includes(b.enforcement)) throw bad('enforcement is off, warn or enforce.', 'enforcement');
      if (b.schemas !== undefined) {
        if (!isObj(b.schemas)) throw new EmulatorError('VALIDATION_FAILED', 'schemas is an object.', 'schemas');
        for (const [k, v] of Object.entries(b.schemas)) {
          if (!TRAIT_TARGETS.includes(k)) throw new EmulatorError('VALIDATION_FAILED', `${k} is not a target: ${TRAIT_TARGETS.join(', ')}.`, `schemas.${k}`);
          if (!isObj(v) || (v.type !== undefined && v.type !== 'object')) throw new EmulatorError('VALIDATION_FAILED', `schemas.${k} is a JSON Schema whose root is an object.`, `schemas.${k}`);
        }
        s.schemas = b.schemas;
      }
      if (b.enforcement !== undefined) s.enforcement = b.enforcement;
      if (b.schemas !== undefined || b.enforcement !== undefined) Object.assign(s, { version: s.version + 1, updated_at: e.clock.now() });
      return { body: { object: 'user_traits_schema', ...s } };
    } },
    { method: 'GET', pattern: '/v1/users/search/fields', handler: (c) => {
      const out: Obj[] = BUILTIN_FIELDS.map(([field, type]) => ({ field, source: 'builtin', type }));
      for (const [target, schema] of Object.entries<any>(st(c.engine).traits.schemas)) {
        if (!target.endsWith('metadata') || target.startsWith('organization_')) continue;
        const req: string[] = schema.required ?? [];
        for (const [name, p] of Object.entries<any>(schema.properties ?? {})) out.push({ field: `${target}.${name}`, source: 'schema', ...(p.type ? { type: p.type } : {}), ...(Array.isArray(p.enum) ? { enum: p.enum } : {}), ...(p.description ? { description: p.description } : {}), required: req.includes(name) });
      }
      return { body: listOf(out) };
    } },
    { method: 'POST', pattern: '/v1/users/search/views/:id/count', handler: (c) => {
      const e = c.engine;
      const v = e.generic.get('users/search/views')?.get(c.params.id);
      if (!v) throw notFound('Search view');
      const n = e.db.users.filter((u) => !u.deleted).filter((u) => matches(u, v.filter ?? {})).length;
      e.generic.get('users/search/views')!.update(v.id, { member_count: n, counted_at: e.clock.now() } as any);
      return { body: { object: 'user_search_view', ...e.generic.get('users/search/views')!.get(v.id) } };
    } },
    { method: 'GET', pattern: '/v1/users/:id/owned_organizations', handler: (c) => {
      const e = c.engine;
      const u = liveUser(e, c.params.id);
      const data = e.db.organizations.filter((o) => !o.deleted).flatMap((o) => {
        const members = e.db.memberships.filter((m) => m.organization_id === o.id);
        const admins = members.filter((m) => m.role === 'org:admin');
        if (admins.length !== 1 || admins[0]!.user_id !== u.id || members.length < 2) return [];
        return [{ object: 'owned_organization', id: o.id, name: o.name, slug: o.slug, other_members: members.length - 1 }];
      });
      return { body: listOf(data) };
    } },
    { method: 'POST', pattern: '/v1/users/:id/deletion/reconfirm', handler: (c) => {
      const e = c.engine;
      const u = liveUser(e, c.params.id);
      const req = dsrRows(e).find((r) => r.user_id === u.id && r.type === 'erasure' && (r.status === 'paused' || r.paused === true));
      if (!req) {
        if (dsrRows(e).some((r) => r.user_id === u.id && r.type === 'erasure' && r.status === 'scheduled')) return { body: presentUser(e, u) }; // idempotent: nothing is paused
        throw conflict('This user has no paused deletion.');
      }
      Object.assign(req, { status: 'scheduled', paused: false, updated_at: e.clock.now() });
      e.webhooks.emit('user.deletion_resumed', { object: 'user', id: u.id, deletion_effective_at: req.scheduled_for ?? null, data_subject_request_id: req.id });
      return { body: presentUser(e, u) };
    } },
    { method: 'GET', pattern: '/v1/users/:id/identity_verifications/:attemptId', handler: (c) => {
      const e = c.engine;
      const u = liveUser(e, c.params.id);
      const a = verificationRows(e).get(c.params.attemptId);
      if (!a || a.user_id !== u.id) throw notFound('Identity verification');
      return { body: attemptView(a) };
    } },
    { method: 'POST', pattern: '/v1/users/:id/identity_verifications/import', handler: (c) => {
      const e = c.engine;
      const u = liveUser(e, c.params.id);
      unknownField(c.body, ['provider', 'session_id']);
      if (!['stripe_identity', 'persona', 'veriff', 'onfido'].includes(c.body.provider)) throw bad('provider is stripe_identity, persona, veriff or onfido.', 'provider');
      if (typeof c.body.session_id !== 'string' || !c.body.session_id) throw bad('session_id is the verification service session id.', 'session_id');
      if (verificationRows(e).find((r) => r.session_id === c.body.session_id && r.provider === c.body.provider)) throw conflict('That session was already imported.');
      const now = e.clock.now();
      const row = verificationRows(e).insert({ user_id: u.id, provider: c.body.provider, session_id: c.body.session_id, status: 'approved', imported: true, verified_at: now, created_at: now, completed_at: now } as any);
      e.webhooks.emit('identity_verification.updated', attemptView(row));
      return { status: 201, body: attemptView(row) };
    } },
  ];
}
const attemptView = (a: Obj): Obj => ({ object: 'identity_verification', id: a.id, user_id: a.user_id, provider: a.provider ?? 'stripe_identity', status: a.status, reason: a.reason ?? null, last_error: a.last_error ?? null, attempts: a.attempts ?? 0, imported: a.imported === true, verified_at: a.verified_at ?? null, verified_attributes_status: a.verified_attributes_status ?? null, url: a.status === 'pending' ? (a.url ?? null) : null, decided_by: a.decided_by ?? null, created_at: a.created_at, completed_at: a.completed_at ?? null });

/** A saved search filter node: { field, op, value } leaves joined by { and: [...] } / { or: [...] } / { not: node }. */
function matches(u: Obj, f: Obj): boolean {
  if (Array.isArray(f.and)) return f.and.every((x: Obj) => matches(u, x));
  if (Array.isArray(f.or)) return f.or.some((x: Obj) => matches(u, x));
  if (isObj(f.not)) return !matches(u, f.not);
  if (typeof f.field !== 'string') return true;
  const path = f.field.split('.');
  const get = (): unknown => {
    if (f.field === 'email_address') return (u.emails as Obj[]).map((m) => m.email_address);
    let cur: any = u;
    for (const p of path) cur = cur?.[p];
    return cur;
  };
  const v = get();
  const vals = Array.isArray(v) ? v : [v];
  switch (f.op ?? 'eq') {
    case 'eq': return vals.some((x) => x === f.value);
    case 'neq': return !vals.some((x) => x === f.value);
    case 'contains': return vals.some((x) => String(x ?? '').toLowerCase().includes(String(f.value).toLowerCase()));
    case 'exists': return v !== undefined && v !== null;
    case 'gt': return vals.some((x) => typeof x === 'number' && x > f.value);
    case 'lt': return vals.some((x) => typeof x === 'number' && x < f.value);
    default: return false;
  }
}

// ── web bot auth and agent request verification ──

const dirEntry = (v: unknown, param: string): Obj => {
  const d = typeof v === 'string' ? { directory: v } : v;
  if (!isObj(d) || typeof d.directory !== 'string') throw bad(`${param} entries are a directory URL or host, or { directory, name }.`, param);
  let host: string;
  try {
    host = new URL(d.directory.includes('://') ? d.directory : `https://${d.directory}`).host;
  } catch {
    throw bad(`${d.directory} is not a directory URL or host.`, param);
  }
  if (d.name !== undefined && (typeof d.name !== 'string' || d.name.length > 120)) throw bad('name is at most 120 characters.', param);
  return { id: `wbd_${host}`, directory: `https://${host}`, name: d.name ?? host };
};
const botView = (e: Engine): Obj => ({ object: 'web_bot_auth', allow: st(e).botLists.allow, block: st(e).botLists.block });

function botRoutes(): RouteDef[] {
  const setList = (e: Engine, key: 'allow' | 'block', raw: unknown): void => {
    if (!Array.isArray(raw) || raw.length > 100) throw bad(`${key} is a list of at most 100 entries.`, key);
    const seen = new Set<string>();
    st(e).botLists[key] = raw.map((x) => dirEntry(x, key)).filter((d) => !seen.has(d.id) && !!seen.add(d.id));
  };
  const other = (k: 'allow' | 'block') => (k === 'allow' ? 'block' : 'allow');
  const b64 = (s: string): Uint8Array => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
  return [
    { method: 'GET', pattern: '/v1/web_bot_auth', handler: (c) => ({ body: botView(c.engine) }) },
    { method: 'PUT', pattern: '/v1/web_bot_auth', handler: (c) => {
      const e = c.engine;
      unknownField(c.body, ['allow', 'block']);
      const prev = structuredClone(st(e).botLists);
      try {
        for (const k of ['allow', 'block'] as const) if (c.body[k] !== undefined) setList(e, k, c.body[k]);
        const ids = new Set(st(e).botLists.allow.map((d) => d.id));
        if (st(e).botLists.block.some((d) => ids.has(d.id))) throw bad('A directory cannot be on both lists.', 'block');
      } catch (err) {
        st(e).botLists = prev;
        throw err;
      }
      return { body: botView(e) };
    } },
    { method: 'GET', pattern: '/v1/web_bot_auth/directories', handler: (c) => {
      const L = st(c.engine).botLists;
      return { body: { object: 'list', data: [...L.allow.map((d) => ({ object: 'web_bot_directory', ...d, list: 'allow' })), ...L.block.map((d) => ({ object: 'web_bot_directory', ...d, list: 'block' }))], has_more: false } };
    } },
    { method: 'POST', pattern: '/v1/web_bot_auth/directories', handler: (c) => {
      const e = c.engine;
      unknownField(c.body, ['directory', 'list', 'name']);
      if (c.body.list !== 'allow' && c.body.list !== 'block') throw bad('list is allow or block.', 'list');
      const d = dirEntry({ directory: c.body.directory, name: c.body.name }, 'directory');
      const L = st(e).botLists;
      L[other(c.body.list)] = L[other(c.body.list)].filter((x) => x.id !== d.id);
      const list = L[c.body.list as 'allow' | 'block'];
      if (!list.some((x) => x.id === d.id)) {
        if (list.length >= 100) throw bad('At most 100 per list.', 'list');
        list.push(d);
      }
      return { status: 201, body: { object: 'web_bot_directory', ...d, list: c.body.list } };
    } },
    { method: 'DELETE', pattern: '/v1/web_bot_auth/directories/:id', handler: (c) => {
      const L = st(c.engine).botLists;
      const had = [...L.allow, ...L.block].some((d) => d.id === c.params.id);
      if (!had) throw notFound('Directory');
      L.allow = L.allow.filter((d) => d.id !== c.params.id);
      L.block = L.block.filter((d) => d.id !== c.params.id);
      return { body: { object: 'web_bot_directory', id: c.params.id, deleted: true } };
    } },
    { method: 'POST', pattern: '/v1/agents/verify_request', handler: async (c) => {
      const e = c.engine;
      const b = c.body;
      unknownField(b, ['method', 'url', 'headers', 'reject_replays']);
      if (typeof b.method !== 'string' || typeof b.url !== 'string' || !isObj(b.headers)) throw bad('method, url and headers are required.', 'method');
      let url: URL;
      try {
        url = new URL(b.url);
      } catch {
        throw bad('url is an absolute URL.', 'url');
      }
      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries(b.headers)) h[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
      const verdict = (verified: boolean, reason: string | null, agent: Obj | null = null): Reply2 => {
        const dir = agent ? dirEntry(agent.directory, 'directory') : null;
        const tier = dir && st(e).botLists.block.some((x) => x.id === dir.id) ? 'blocked' : dir && st(e).botLists.allow.some((x) => x.id === dir.id) ? 'allowed' : verified ? 'verified' : 'unverified';
        return { body: { object: 'web_bot_auth_verification', verified, agent: verified ? agent : null, tier, decision: tier === 'blocked' ? 'block' : tier === 'allowed' ? 'allow' : 'unknown', reason: verified ? null : reason } };
      };
      if (!h.signature || !h['signature-input'] || !h['signature-agent']) return verdict(false, 'no_signature');
      const m = /^([\w-]+)=\(([^)]*)\)(.*)$/.exec(h['signature-input']);
      const sigMatch = new RegExp(`^${m?.[1] ?? 'sig1'}=:([^:]+):`).exec(h.signature);
      if (!m || !sigMatch) return verdict(false, 'bad_signature');
      const params = m[3]!;
      const keyid = /;keyid="([^"]+)"/.exec(params)?.[1];
      const created = Number(/;created=(\d+)/.exec(params)?.[1]);
      const expires = Number(/;expires=(\d+)/.exec(params)?.[1]);
      const nonce = /;nonce="([^"]+)"/.exec(params)?.[1];
      if (!/;tag="web-bot-auth"/.test(params) || !keyid) return verdict(false, 'bad_signature');
      const nowS = Math.floor(e.clock.now() / 1000);
      if (Number.isFinite(expires) && expires < nowS) return verdict(false, 'expired');
      if (Number.isFinite(created) && created > nowS + 60) return verdict(false, 'not_yet_valid');
      const directory = h['signature-agent'].replace(/^"|"$/g, '');
      let keys: any[];
      try {
        const res = await (e.options.fetch ?? fetch)(`${directory.replace(/\/$/, '')}/.well-known/http-message-signatures-directory`, { headers: { accept: 'application/http-message-signatures-directory+json' } });
        if (!res.ok) return verdict(false, 'key_not_found');
        keys = ((await res.json()) as any).keys ?? [];
      } catch {
        return verdict(false, 'key_not_found');
      }
      const jwk = keys.find((k) => k.kid === keyid || k.x === keyid);
      if (!jwk || jwk.crv !== 'Ed25519') return verdict(false, 'key_not_found');
      // The signature base (RFC 9421): each covered component, then the signature parameters.
      const covered = [...m[2]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
      const lines = covered.map((comp) => {
        const val = comp === '@method' ? b.method.toUpperCase() : comp === '@authority' ? url.host : comp === '@path' ? url.pathname : comp === '@target-uri' ? url.toString() : comp === '@scheme' ? url.protocol.slice(0, -1) : comp === '@query' ? url.search || '?' : (h[comp] ?? '');
        return `"${comp}": ${val}`;
      });
      lines.push(`"@signature-params": (${m[2]})${params}`);
      let good = false;
      try {
        const key = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, { name: 'Ed25519' }, false, ['verify']);
        good = await crypto.subtle.verify({ name: 'Ed25519' }, key, b64(sigMatch[1]!) as BufferSource, new TextEncoder().encode(lines.join('\n')));
      } catch {
        good = false;
      }
      if (!good) return verdict(false, 'bad_signature');
      if (b.reject_replays === true && nonce) {
        const seen = `${keyid}|${nonce}`;
        if (st(e).botSeen.has(seen)) return verdict(false, 'replayed');
        st(e).botSeen.add(seen);
      }
      return verdict(true, null, { directory, key_id: keyid, name: dirEntry(directory, 'directory').name });
    } },
  ];
}
interface Reply2 { body: Obj }

// ── key rotation drills, config limits, impersonation, change feeds, revoked tokens, apps, connection completion, SCIM rotation ──

const CONFIG_LIMITS = {
  resource_types: { max_roles_per_type: 200, key_pattern: '^[a-z][a-z0-9_.-]{0,62}$', name_max_length: 200 },
  app_roles: { max_permissions_per_role: 100, max_roles_per_instance: 200 },
  permissions: { max_implied_per_permission: 50, key_max_length: 160, max_parts: 6, part_max_length: 64 },
  scopes: { description_max_length: 500, label_max_length: 200 },
};

function miscRoutes(): RouteDef[] {
  const drillView = (d: Obj): Obj => ({ object: 'data_key_drill', id: d.id, ok: d.ok, data_keys: d.data_keys, vault_versions: d.vault_versions, vault_versions_not_examined: d.vault_versions_not_examined, failed: d.failed, failure_reason: d.failure_reason ?? null, used_previous: d.used_previous, items: d.items, created_at: d.created_at });
  const assignmentFeed = (e: Engine): Obj[] => {
    let seq = 0;
    const out: Obj[] = [];
    for (const ev of e.webhooks.events) {
      const m = /^resource_role_assignment\.(created|deleted)$/.exec(ev.type);
      if (!m) continue;
      const d: Obj = (ev.payload as Obj)?.data ?? {};
      out.push({ object: 'resource_role_assignment_change', seq: ++seq, change: m[1], assignment_id: d.id, resource_id: d.resource_id, resource_type: d.resource_type, resource_external_id: d.resource_external_id, subject: d.subject, role: d.role, inherit: d.inherit, created_at: ev.created_at });
    }
    return out;
  };
  return [
    { method: 'GET', pattern: '/v1/config/limits', handler: () => ({ body: { object: 'config_limits', limits: CONFIG_LIMITS } }) },
    { method: 'GET', pattern: '/v1/impersonations/requests/:id', handler: (c) => {
      const r = c.engine.generic.get('impersonations/requests')?.get(c.params.id);
      if (!r) throw notFound('Impersonation request');
      const expired = r.status === 'pending' && r.expires_at <= c.engine.clock.now();
      return { body: { object: 'impersonation_request', id: r.id, status: expired ? 'expired' : r.status, user_id: r.user_id, staff_user_id: r.staff_user_id, reason: r.reason ?? null, reason_code: r.reason_code ?? null, read_only: r.read_only === true, max_duration_seconds: r.max_duration_seconds ?? 3600, decided_by: r.decided_by ?? null, decided_at: r.decided_at ?? null, impersonation_id: r.impersonation_id ?? null, expires_at: r.expires_at, created_at: r.created_at } };
    } },
    { method: 'POST', pattern: '/v1/instance/data_key_provider/rotation_drill', handler: (c) => {
      const e = c.engine;
      if (c.body.previous !== undefined) {
        if (!isObj(c.body.previous) || typeof c.body.previous.provider !== 'string') throw bad('previous is { provider, config, credentials }.', 'previous');
      }
      // shortcut: the emulator has no KMS: every data key and vault version it holds is already on the configured key, so a drill proves nothing moves.
      const row = st(e).drills.insert({ ok: true, data_keys: 0, vault_versions: 0, vault_versions_not_examined: 0, failed: 0, failure_reason: null, used_previous: c.body.previous !== undefined, items: [], created_at: e.clock.now() } as any);
      return { body: drillView(row) };
    } },
    { method: 'GET', pattern: '/v1/instance/data_key_provider/rotation_drills', handler: (c) => ({ body: { object: 'list', data: st(c.engine).drills.all().slice(0, 20).map(drillView), has_more: st(c.engine).drills.size > 20 } }) },
    { method: 'GET', pattern: '/v1/instance/data_key_provider/rotation_drills/:id', handler: (c) => {
      const d = st(c.engine).drills.get(c.params.id);
      if (!d) throw notFound('Rotation drill');
      return { body: drillView(d) };
    } },
    { method: 'GET', pattern: '/v1/resource_role_assignments/changes', handler: (c) => {
      const e = c.engine;
      const after = c.query.get('after');
      if (after !== null && !/^\d{1,15}$/.test(after)) throw bad('after is a cursor from this feed.', 'after');
      const limit = Math.min(1000, Math.max(1, Number(c.query.get('limit') ?? 100) || 100));
      const all = assignmentFeed(e);
      const rest = all.filter((x) => x.seq > Number(after ?? 0));
      const data = rest.slice(0, limit);
      return { body: { object: 'list', data, has_more: rest.length > data.length, next_cursor: String(data.length ? data[data.length - 1]!.seq : (after ?? 0)) } };
    } },
    { method: 'GET', pattern: '/v1/resource_servers/:id/revoked_tokens', handler: (c) => {
      const e = c.engine;
      const rs = e.generic.get('resource_servers')?.find((r) => r.id === c.params.id || r.identifier === c.params.id);
      if (!rs) throw notFound('Resource server');
      const retention = 30 * 86_400;
      const now = e.clock.now();
      const windowStart = Math.max(Number(c.query.get('since') ?? 0) || 0, now - retention * 1000);
      const limit = Math.min(5000, Math.max(1, Number(c.query.get('limit') ?? 1000) || 1000));
      const after = Number(c.query.get('after') ?? 0) || 0;
      const rows: Array<{ seq: number; row: Obj }> = [];
      let seq = 0;
      for (const ev of e.webhooks.events) {
        if (ev.type !== 'oauth_tokens.revoked' && ev.type !== 'grant.revoked') continue;
        seq++;
        const d: Obj = (ev.payload as Obj)?.data ?? {};
        if (ev.created_at < windowStart || seq <= after) continue;
        rows.push({ seq, row: { family_id: d.family_id ?? null, jti: d.jti ?? null, user_id: d.user_id ?? null, client_id: d.client_id ?? null, reason: d.reason ?? (ev.type === 'grant.revoked' ? 'grant_revoked' : 'admin_revoked'), revoked_at: d.revoked_at ?? ev.created_at } });
      }
      const page = rows.slice(0, limit);
      return { body: { data: page.map((r) => r.row), has_more: rows.length > page.length, next_cursor: page.length ? String(page[page.length - 1]!.seq) : (c.query.get('after') ?? null), server_time: now, window_start: windowStart, retention_seconds: retention } };
    } },
    // An adoption code is issued by the app's owner; the emulator issues one on request.
    { method: 'POST', pattern: '/__emulator/atlas_id_apps/adoption_codes', public: true, handler: (c) => {
      const e = c.engine;
      const code = `adopt_${randomToken(18)}`;
      const app = { object: 'atlas_id_app', id: c.body.id ?? e.db.newId('aia'), client_id: c.body.client_id ?? randomToken(12), name: c.body.name ?? 'Sign in with Atlas app', managed_by_instance_id: e.instanceId, allowed_scopes: c.body.allowed_scopes ?? ['openid', 'email', 'profile'], created_at: e.clock.now(), managed_via: 'adopted', button_rendered_origins: [] };
      st(e).adoptionCodes.set(code, app);
      return { status: 201, body: { code, app_id: app.id } };
    } },
    { method: 'POST', pattern: '/v1/atlas_id_apps/adopt', handler: (c) => {
      const e = c.engine;
      unknownField(c.body, ['code']);
      if (typeof c.body.code !== 'string') throw bad('code is the adoption code.', 'code');
      const app = st(e).adoptionCodes.get(c.body.code);
      if (!app) throw notFound('Adoption code'); // unknown, spent, expired and foreign codes are the same 404
      st(e).adoptionCodes.delete(c.body.code);
      const had = st(e).adopted.has(app.id);
      st(e).adopted.set(app.id, app);
      return { body: { ...app, changed: !had } };
    } },
    { method: 'POST', pattern: '/v1/atlas_id_apps/:id/release', handler: (c) => {
      if (!st(c.engine).adopted.delete(c.params.id!)) throw notFound('Adopted app');
      return { body: { object: 'atlas_id_app_release', app_id: c.params.id, released: true } };
    } },
    { method: 'POST', pattern: '/v1/scim_tokens/:id/rotate', handler: (c) => {
      const e = c.engine;
      const t = e.db.scimTokens.get(c.params.id);
      if (!t || t.revoked) throw notFound('SCIM token');
      const secret = `scim_${randomToken(32)}`;
      Object.assign(t, { secret, prefix: secret.slice(0, 10), rotated_at: e.clock.now() });
      e.webhooks.emit('scim_token.rotated', { object: 'scim_token', id: t.id, organization_id: t.organization_id });
      return { body: { object: 'scim_token', id: t.id, name: t.name ?? null, organization_id: t.organization_id, connection_id: t.connection_id ?? null, prefix: t.prefix, revoked: false, created_at: t.created_at, rotated_at: t.rotated_at, token: secret } };
    } },
    { method: 'POST', pattern: '/v1/connections/oauth/complete', handler: async (c) => {
      const e = c.engine;
      const b = c.body;
      unknownField(b, ['code', 'state', 'redirect_uri', 'oauth_client_id', 'query']);
      if (typeof b.code !== 'string' || typeof b.state !== 'string') throw bad('code and state are required.', 'code');
      const pending = e.generic.get('connections/oauth_states')?.find((s) => s.state === b.state);
      if (!pending) throw new EmulatorError('VALIDATION_FAILED', 'The state is unknown or was already used: start the connect again.', 'state');
      if (b.oauth_client_id !== undefined && b.oauth_client_id !== pending.oauth_client_id) throw bad('The state was started with another OAuth client.', 'oauth_client_id');
      if (b.redirect_uri !== undefined && b.redirect_uri !== pending.redirect_uri) throw bad("redirect_uri is not the client's registered redirect_uri.", 'redirect_uri');
      e.generic.get('connections/oauth_states')!.delete(pending.id);
      const table = gt(e, 'connections', 'connection');
      const prior = table.find((x) => x.id === pending.connection_id);
      const hash = (await hex(b.code)).slice(0, 12);
      const conn = prior ?? table.insert({ object: 'connection', owner: pending.owner ?? { type: 'external' }, kind: 'oauth', provider: pending.provider, name: pending.provider, status: 'active', environment: 'production', created_at: e.clock.now() } as any);
      Object.assign(conn, { status: 'active', oauth_client_id: pending.oauth_client_id ?? null, has_secret: true, token_hash: hash, updated_at: e.clock.now() });
      return { body: { object: 'connection_oauth_completion', connection: conn, connection_ids: [conn.id], created: !prior, reconnected_existing: !!prior, redirect_url: pending.return_url ?? `${e.issuer}/v1/connection_reconnect_done` } };
    } },
    // Emulator control: the connect a customer page started, whose provider redirect it will forward.
    { method: 'POST', pattern: '/__emulator/connections/oauth_states', public: true, handler: (c) => {
      const e = c.engine;
      const state = randomToken(16);
      const row = gt(e, 'connections/oauth_states', 'ocs').insert({ state, provider: c.body.provider ?? 'github', oauth_client_id: c.body.oauth_client_id ?? null, redirect_uri: c.body.redirect_uri ?? null, connection_id: c.body.connection_id ?? null, owner: c.body.owner ?? null, return_url: c.body.return_url ?? null } as any);
      return { status: 201, body: { state, id: row.id } };
    } },
  ];
}

export function ndbOrgHandlers(): RouteDef[] {
  return [...campaignRoutes(), ...orgDepthRoutes(), ...importRoutes(), ...itRoutes(), ...orgWebhookRoutes(), ...signalRoutes(), ...userRoutes(), ...botRoutes(), ...miscRoutes()];
}
