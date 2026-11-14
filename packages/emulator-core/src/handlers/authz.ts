/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteDef } from '../engine';
import { EmulatorError, notFound } from '../errors';
import type { Obj } from '../openapi';
import { Table } from '../store';
import { engineState, intIn } from './support';
import { listReply } from './util';

/**
 * Authorization introspection on the engine's own state: `POST /v1/authz/explain` (why a user has or lacks a permission,
 * with every contributing role), `POST /v1/authz/rbac/check` (the same check, written to the decision log),
 * `POST /v1/authz/what_if` (replay the logged decisions under a candidate role edit and see what flips), managed FGA sync
 * (memberships and org roles become tuples in one store, with backfill, runs and purge) and the authorization event feed.
 * Layers the emulator has no data for (groups, resource roles, ABAC, access policies, FGA checks) are reported as
 * `skipped` with a reason and never decide, exactly as a layer that errored would not.
 */
const LAYERS = ['rbac', 'org_roles', 'groups', 'resource_roles', 'abac', 'access_policies', 'fga'] as const;
const MAX_WAIT_MS = 25_000;
const REPLAY_LIMIT_DEFAULT = 2000;
const REPLAY_LIMIT_MAX = 10_000;

const bad = (message: string, param: string) => new EmulatorError('VALIDATION_FAILED', message, param);

interface Tuple {
  user: string;
  relation: string;
  object: string;
}
interface AuthzState {
  decisions: Table;
  whatIf: Table;
  runs: Table;
  events: Obj[];
  seq: number;
  config: { enabled: boolean; store_id: string | null; memberships: boolean; org_roles: boolean; groups: boolean; updated_at: number | null };
  managed: Map<string, Tuple>;
}
const st = engineState((e: Engine): AuthzState => ({
  decisions: new Table('authz_decisions', e.clock.now, 'azd'),
  whatIf: new Table('authz_what_if_runs', e.clock.now, 'wif'),
  runs: new Table('fga_sync_runs', e.clock.now, 'fsr'),
  events: [],
  seq: 0,
  config: { enabled: false, store_id: null, memberships: true, org_roles: true, groups: true, updated_at: null },
  managed: new Map(),
}));

const permMatches = (have: string, want: string): boolean => have === want || have === '*' || (have.endsWith(':*') && want.startsWith(have.slice(0, -1)));

/** What a user's organization roles grant for one permission, optionally under role edits (`edits`: role key -> { add, remove }). */
function rbac(e: Engine, userId: string, permission: string, organizationId?: string, edits?: Map<string, { add: string[]; remove: string[] }>): { allowed: boolean; contributions: Obj[] } {
  const contributions: Obj[] = [];
  for (const m of e.db.memberships.filter((x) => x.user_id === userId && (!organizationId || x.organization_id === organizationId))) {
    const role = e.db.roles.find((r) => r.key === m.role);
    const edit = edits?.get(m.role);
    const perms = ((role?.permissions as string[] | undefined) ?? []).filter((p) => !edit?.remove.includes(p)).concat(edit?.add ?? []);
    const matched = perms.some((p) => permMatches(p, permission));
    contributions.push({ layer: 'rbac', effect: 'allow', matched, permission, via: { kind: 'org_role', key: m.role, organization_id: m.organization_id } });
  }
  return { allowed: contributions.some((c) => c.matched), contributions };
}

function explain(e: Engine, userId: string, permission: string, organizationId: string | undefined): Obj {
  if (!e.db.users.get(userId)) throw notFound('User');
  const r = rbac(e, userId, permission, organizationId);
  const skipped = (reason: string): Obj => ({ status: 'skipped', effect: 'none', reason, contributions: [] });
  const layers: Obj = { rbac: { status: 'evaluated', effect: r.allowed ? 'allow' : 'none', contributions: r.contributions }, org_roles: skipped('No delegated roles in the emulator.') };
  for (const l of LAYERS.slice(2)) layers[l] = skipped(`The emulator holds no ${l.replace('_', ' ')} data.`);
  const deciding = r.contributions.filter((c) => c.matched);
  const decision = r.allowed ? 'allow' : 'deny';
  return { object: 'authz_explanation', subject: { id: userId }, permission, organization_id: organizationId ?? null, decision, combination: 'deny_overrides', summary: r.allowed ? `Allowed by ${deciding.map((c) => c.via.key).join(', ')}.` : 'No layer allows this: denied by default.', deciding, layers, evaluated_at: e.clock.now() };
}

function pushEvent(e: Engine, kind: string, storeId: string | null, source: string, data: Obj): void {
  const s = st(e);
  s.events.push({ object: 'authz_event', id: e.db.newId('azev'), seq: ++s.seq, kind, store_id: storeId, store_revision: s.seq, source, data, created_at: e.clock.now() });
}

const parseEdits = (body: Obj): Map<string, { add: string[]; remove: string[] }> | undefined => {
  const roles = body.candidate?.rbac?.roles;
  if (roles === undefined) return undefined;
  if (!Array.isArray(roles) || !roles.length || roles.length > 200) throw bad('candidate.rbac.roles must list 1-200 role edits.', 'candidate.rbac.roles');
  const out = new Map<string, { add: string[]; remove: string[] }>();
  roles.forEach((r: Obj, i: number) => {
    if (!r || typeof r !== 'object' || (r.type !== 'org_role' && r.type !== 'app_role')) throw bad('type must be org_role or app_role.', `candidate.rbac.roles[${i}].type`);
    if (typeof r.key !== 'string' || !r.key) throw bad('key is required.', `candidate.rbac.roles[${i}].key`);
    const list = (v: unknown, f: string): string[] => {
      if (v === undefined) return [];
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw bad(`${f} must be a list of permissions.`, `candidate.rbac.roles[${i}].${f}`);
      return v as string[];
    };
    const prev = out.get(r.key) ?? { add: [], remove: [] };
    out.set(r.key, { add: [...prev.add, ...list(r.add_permissions, 'add_permissions')], remove: [...prev.remove, ...list(r.remove_permissions, 'remove_permissions')] });
  });
  return out;
};

const desiredTuples = (e: Engine): Tuple[] => {
  const cfg = st(e).config;
  const out: Tuple[] = [];
  for (const m of e.db.memberships.all()) {
    const u = e.db.users.get(m.user_id);
    if (!u || u.deleted) continue;
    if (cfg.memberships) out.push({ user: `user:${m.user_id}`, relation: 'member', object: `organization:${m.organization_id}` });
    if (cfg.org_roles && m.role) out.push({ user: `user:${m.user_id}`, relation: String(m.role).replace(/^org:/, ''), object: `organization:${m.organization_id}` });
  }
  return out;
};
const tupleKey = (t: Tuple) => `${t.user}|${t.relation}|${t.object}`;

/** One sync run: write what should exist; with `repair`, also delete managed tuples that no longer should. Only managed tuples are ever touched. */
function runSync(e: Engine, kind: 'backfill' | 'initial', repair: boolean): Obj {
  const s = st(e);
  const now = e.clock.now();
  const want = new Map(desiredTuples(e).map((t) => [tupleKey(t), t]));
  let written = 0;
  let deleted = 0;
  for (const [k, t] of want) {
    if (s.managed.has(k)) continue;
    s.managed.set(k, t);
    written++;
    pushEvent(e, 'tuple_written', s.config.store_id, 'sync', { ...t });
    e.webhooks.emit('fga.tuple_written', { object: 'fga_tuple_batch', store_id: s.config.store_id, store_revision: null, source: 'sync', count: 1, tuples: [{ ...t }] });
  }
  if (repair) {
    for (const [k, t] of [...s.managed]) {
      if (want.has(k)) continue;
      s.managed.delete(k);
      deleted++;
      pushEvent(e, 'tuple_deleted', s.config.store_id, 'sync', { ...t });
      e.webhooks.emit('fga.tuple_deleted', { object: 'fga_tuple_batch', store_id: s.config.store_id, store_revision: null, source: 'sync', count: 1, tuples: [{ ...t }] });
    }
  }
  const run = s.runs.insert({ kind, status: 'completed', store_id: s.config.store_id, repair, written, deleted, managed: s.managed.size, error: null, created_at: now, completed_at: now });
  pushEvent(e, 'sync_run', s.config.store_id, 'sync', { run_id: run.id, written, deleted });
  e.webhooks.emit('fga_sync.completed', { object: 'fga_sync_run', id: run.id, store_id: s.config.store_id, written, deleted });
  return run;
}

const runView = (r: Obj): Obj => ({ object: 'fga_sync_run', id: r.id, kind: r.kind, status: r.status, store_id: r.store_id, repair: r.repair, tuples_written: r.written, tuples_deleted: r.deleted, managed_tuples: r.managed, error: r.error, created_at: r.created_at, completed_at: r.completed_at });
const statusView = (e: Engine): Obj => {
  const s = st(e);
  const last = s.runs.all()[0];
  return { object: 'fga_sync', enabled: s.config.enabled, store_id: s.config.store_id, memberships: s.config.memberships, org_roles: s.config.org_roles, groups: s.config.groups, managed_tuples: s.managed.size, last_run: last ? runView(last) : null, updated_at: s.config.updated_at };
};
const storeExists = (e: Engine, id: string): boolean => !!e.generic.get('fga/stores')?.get(id);

export function authzHandlers(): RouteDef[] {
  const whatIfView = (r: Obj, full: boolean): Obj => ({ object: 'authz_what_if_run', id: r.id, status: 'completed', created_at: r.created_at, window: r.window, evaluated: r.evaluated, changed: r.changed, flipped_to_allow: r.flipped_to_allow, flipped_to_deny: r.flipped_to_deny, truncated: r.truncated, not_evaluated: r.not_evaluated, ...(full ? { samples: r.samples } : {}) });
  return [
    {
      method: 'POST',
      pattern: '/v1/authz/explain',
      scope: 'authz_decisions:read',
      handler: (c) => {
        const id = c.body.subject?.id;
        if (typeof id !== 'string' || !id) throw bad('subject.id is required.', 'subject.id');
        const permission = c.body.permission ?? c.body.action;
        if (typeof permission !== 'string' || !permission) throw bad('permission (or action) is required.', 'permission');
        if (c.body.organization_id !== undefined && typeof c.body.organization_id !== 'string') throw bad('organization_id must be a string.', 'organization_id');
        return { body: explain(c.engine, id, permission, c.body.organization_id) };
      },
    },
    {
      // The same role check, written to the decision log (the corpus what-if replays).
      method: 'POST',
      pattern: '/v1/authz/rbac/check',
      scope: 'authz_decisions:read',
      handler: (c) => {
        const e = c.engine;
        const id = c.body.subject?.id;
        if (typeof id !== 'string' || !id) throw bad('subject.id is required.', 'subject.id');
        if (typeof c.body.permission !== 'string' || !c.body.permission) throw bad('permission is required.', 'permission');
        if (!e.db.users.get(id)) throw notFound('User');
        const r = rbac(e, id, c.body.permission, c.body.organization_id);
        const held = r.contributions.filter((x) => x.matched);
        st(e).decisions.insert({ source: 'rbac', user_id: id, permission: c.body.permission, organization_id: c.body.organization_id ?? null, allowed: r.allowed, at: e.clock.now() });
        return { body: { object: 'rbac_check', allowed: r.allowed, decision: r.allowed ? 'allow' : 'deny', grants: held.map((h) => h.via.key), rules: held } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/authz/what_if',
      scope: 'authz_decisions:read',
      handler: (c) => {
        const e = c.engine;
        const cand = c.body.candidate;
        if (!cand || typeof cand !== 'object' || Array.isArray(cand)) throw bad('candidate is required.', 'candidate');
        const edits = parseEdits(c.body);
        const notEvaluated: string[] = [];
        for (const k of ['abac', 'fga', 'access_policy']) if (cand[k] !== undefined) notEvaluated.push(k);
        if (cand.fga !== undefined && (!cand.fga || typeof cand.fga.store_id !== 'string' || !cand.fga.store_id)) throw bad('candidate.fga.store_id is required.', 'candidate.fga.store_id');
        if (!edits && !notEvaluated.length) throw bad('candidate needs at least one of abac, rbac, fga, access_policy.', 'candidate');
        const until = c.body.until === undefined ? e.clock.now() : Date.parse(String(c.body.until));
        const days = intIn(c.body.days, 'days', 1, 30, 7);
        const since = c.body.since === undefined ? until - days * 86_400_000 : Date.parse(String(c.body.since));
        if (Number.isNaN(until) || Number.isNaN(since)) throw bad('since and until must be ISO 8601 times.', 'since');
        if (since >= until) throw bad('since must be before until.', 'since');
        if (until - since > 31 * 86_400_000) throw bad('The window can be at most 31 days.', 'since');
        const limit = intIn(c.body.limit, 'limit', 1, REPLAY_LIMIT_MAX, REPLAY_LIMIT_DEFAULT);
        const all = st(e).decisions.all().filter((d) => d.at >= since && d.at <= until);
        const rows = all.slice(0, limit);
        const flips: Obj[] = [];
        let toAllow = 0;
        let toDeny = 0;
        for (const d of rows) {
          if (!edits) break;
          const next = rbac(e, d.user_id, d.permission, d.organization_id ?? undefined, edits).allowed;
          if (next === d.allowed) continue;
          next ? toAllow++ : toDeny++;
          flips.push({ decision_id: d.id, user_id: d.user_id, permission: d.permission, organization_id: d.organization_id, before: d.allowed ? 'allow' : 'deny', after: next ? 'allow' : 'deny' });
        }
        const result = { evaluated: rows.length, changed: flips.length, flipped_to_allow: toAllow, flipped_to_deny: toDeny, truncated: all.length > rows.length, not_evaluated: notEvaluated, samples: flips.slice(0, 25), window: { since, until } };
        if (c.body.save === false) return { body: { object: 'authz_what_if_run', id: null, status: 'completed', created_at: e.clock.now(), ...result } };
        const row = st(e).whatIf.insert({ ...result, created_at: e.clock.now() });
        return { status: 201, body: whatIfView(row, true) };
      },
    },
    { method: 'GET', pattern: '/v1/authz/what_if', scope: 'authz_decisions:read', handler: (c) => listReply(c, st(c.engine).whatIf.all(), (r) => whatIfView(r, false)) },
    {
      method: 'GET',
      pattern: '/v1/authz/what_if/:id',
      scope: 'authz_decisions:read',
      handler: (c) => {
        const r = st(c.engine).whatIf.get(c.params.id);
        if (!r) throw notFound('What-if run');
        return { body: whatIfView(r, true) };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/authz/what_if/:id',
      scope: 'authz_decisions:write',
      handler: (c) => {
        if (!st(c.engine).whatIf.delete(c.params.id ?? '')) throw notFound('What-if run');
        return { body: { object: 'authz_what_if_run', id: c.params.id, deleted: true } };
      },
    },
    // ── managed FGA sync ──
    { method: 'GET', pattern: '/v1/fga/sync', scope: 'fga:read', handler: (c) => ({ body: statusView(c.engine) }) },
    {
      method: 'PUT',
      pattern: '/v1/fga/sync',
      scope: 'fga:write',
      handler: (c) => {
        const e = c.engine;
        const s = st(e);
        const b = c.body;
        for (const k of ['enabled', 'memberships', 'org_roles', 'groups'] as const) if (b[k] !== undefined && typeof b[k] !== 'boolean') throw bad(`${k} must be true or false.`, k);
        const storeId = b.store_id === undefined ? s.config.store_id : b.store_id;
        if (storeId !== null && (typeof storeId !== 'string' || !storeExists(e, storeId))) throw bad('store_id must be an existing FGA store.', 'store_id');
        // Owned tuples live in one store: it cannot change under them.
        if (storeId !== s.config.store_id && s.managed.size) throw new EmulatorError('CONFLICT', 'The sync owns tuples in the current store. Purge them before changing the store.', 'store_id');
        const enabled = b.enabled ?? s.config.enabled;
        if (enabled && !storeId) throw bad('Enabling sync needs a store_id.', 'store_id');
        const turningOn = enabled && !s.config.enabled;
        Object.assign(s.config, { enabled, store_id: storeId, memberships: b.memberships ?? s.config.memberships, org_roles: b.org_roles ?? s.config.org_roles, groups: b.groups ?? s.config.groups, updated_at: e.clock.now() });
        if (turningOn) runSync(e, 'initial', false);
        return { body: statusView(e) };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/fga/sync/backfill',
      scope: 'fga:write',
      handler: (c) => {
        const e = c.engine;
        if (c.body.repair !== undefined && typeof c.body.repair !== 'boolean') throw bad('repair must be a boolean.', 'repair');
        if (!st(e).config.enabled || !st(e).config.store_id) throw bad('Enable sync with a store before running a backfill.', 'enabled');
        return { status: 202, body: runView(runSync(e, 'backfill', c.body.repair === true)) };
      },
    },
    { method: 'GET', pattern: '/v1/fga/sync/runs', scope: 'fga:read', handler: (c) => listReply(c, st(c.engine).runs.all(), runView) },
    {
      method: 'GET',
      pattern: '/v1/fga/sync/runs/:id',
      scope: 'fga:read',
      handler: (c) => {
        const r = st(c.engine).runs.get(c.params.id);
        if (!r) throw notFound('Sync run');
        return { body: runView(r) };
      },
    },
    {
      // Remove only the tuples the sync wrote, and forget them. Sync must be off.
      method: 'POST',
      pattern: '/v1/fga/sync/purge',
      scope: 'fga:write',
      handler: (c) => {
        const e = c.engine;
        const s = st(e);
        if (c.body.confirm !== true) throw bad('Send confirm: true to remove the tuples the sync wrote.', 'confirm');
        if (!s.config.store_id) throw notFound('Sync store');
        if (s.config.enabled) throw new EmulatorError('CONFLICT', 'Disable sync before purging.');
        const n = s.managed.size;
        for (const t of s.managed.values()) pushEvent(e, 'tuple_deleted', s.config.store_id, 'sync', { ...t });
        s.managed.clear();
        return { body: { object: 'fga.sync_purge', store_id: s.config.store_id, deleted: n, released: 0 } };
      },
    },
    // ── the authorization event feed ──
    {
      method: 'GET',
      pattern: '/v1/authz/events',
      scope: 'fga:read',
      handler: async (c) => {
        const e = c.engine;
        const s = st(e);
        const rawAfter = c.query.get('after');
        const after = rawAfter === 'latest' ? s.seq : rawAfter === null ? 0 : Number(rawAfter);
        if (!Number.isInteger(after) || after < 0) throw bad('after must be a sequence number or "latest".', 'after');
        const limit = intIn(c.query.get('limit') ?? undefined, 'limit', 1, 500, 100);
        const waitMs = intIn(c.query.get('wait_ms') ?? undefined, 'wait_ms', 0, MAX_WAIT_MS, 0);
        const kinds = c.query.get('kinds')?.split(',').filter(Boolean);
        const store = c.query.get('store_id');
        const pick = () => s.events.filter((x) => x.seq > after && (!kinds || kinds.includes(x.kind)) && (!store || x.store_id === store));
        const deadline = Date.now() + waitMs;
        while (!pick().length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
        const all = pick();
        const page = all.slice(0, limit);
        return { body: { object: 'list', data: page, has_more: all.length > limit, next_after: page.length ? page[page.length - 1]!.seq : after } };
      },
    },
  ];
}
