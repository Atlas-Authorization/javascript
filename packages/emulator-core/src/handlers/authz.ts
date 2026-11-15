/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteDef } from '../engine';
import { EmulatorError, notFound } from '../errors';
import type { Obj } from '../openapi';
import { firstOf, headerSignals } from './access-signals';
import { CedarParseError, type CedarRequest, parseCedar } from './cedar';
import { type RoleEdit, abacDecide, candidatePdp, explainAccess, fgaCheck, latestModel, loadPdp, parseExplainBody, rbacCheck, recordRbacCheck, replayRoleDecision } from './authz-layers';
import { type Tuple, applyTuples, pushEvent, reconcileManaged, st, storeExists } from './authz-state';
import { intIn } from './support';
import { listReply } from './util';

/**
 * Authorization introspection on the engine's own state: `POST /v1/authz/explain` (why a user has or lacks a permission,
 * asked of all seven layers: organization and app roles, groups, resource roles, ABAC, access policies and FGA tuples),
 * `POST /v1/authz/rbac/check` (the role check, written to the decision log), `POST /v1/authz/what_if` (replay the logged
 * role, ABAC and FGA decisions under a candidate change and see what flips), managed FGA sync (memberships, org roles and
 * groups become tuples in one store, live on every change, with backfill, runs and purge) and the authorization event feed.
 * The data the layers read is written by the routes in authz-data.
 */
const MAX_WAIT_MS = 25_000;
const REPLAY_LIMIT_DEFAULT = 2000;
const REPLAY_LIMIT_MAX = 10_000;
const SAMPLE_CAP = 50;

const bad = (message: string, param: string) => new EmulatorError('VALIDATION_FAILED', message, param);

const obj = (v: unknown, field: string): Obj => {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw bad(`${field} must be an object.`, field);
  return v as Obj;
};
const strList = (v: unknown, field: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x)) throw bad(`${field} must be a list of strings.`, field);
  return v as string[];
};
const tupleList = (v: unknown, field: string): Tuple[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw bad(`${field} must be a list of tuples.`, field);
  return v.map((t, i) => {
    const o = obj(t, `${field}[${i}]`);
    if (typeof o.user !== 'string' || typeof o.relation !== 'string' || typeof (o.object ?? o.target) !== 'string') throw bad(`${field}[${i}] requires user, relation and object.`, field);
    if (!/^[^:#]+:[^#]+(#[^#]+)?$/.test(o.user)) throw bad(`${field}[${i}].user is malformed.`, field);
    return { user: o.user, relation: o.relation, object: (o.object ?? o.target) as string };
  });
};
const policySources = (v: unknown, field: string): Array<{ name: string; source: string }> => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw bad(`${field} must be a list.`, field);
  return v.map((p, i) => {
    const o = obj(p, `${field}[${i}]`);
    if (typeof o.name !== 'string' || !o.name || typeof o.source !== 'string' || !o.source) throw bad(`${field}[${i}] needs name and source.`, field);
    try {
      parseCedar(o.source);
    } catch (err) {
      if (err instanceof CedarParseError) throw bad(`${field}[${i}].source: ${err.message} (at character ${err.position})`, field);
      throw err;
    }
    return { name: o.name, source: o.source };
  });
};
const time = (v: unknown, field: string): number | undefined => {
  if (v === undefined || v === null) return undefined;
  const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  if (Number.isNaN(t)) throw bad(`${field} must be a millisecond timestamp or an ISO date.`, field);
  return t;
};

interface Candidate {
  abac?: { add: Array<{ name: string; source: string }>; replace: Array<{ name: string; source: string }>; remove: string[] };
  rbac?: { roles: RoleEdit[] };
  fga?: { storeId: string; writes: Tuple[]; deletes: Tuple[] };
  accessPolicy?: Obj;
}
function parseCandidate(cand: Obj): Candidate {
  const out: Candidate = {};
  if (cand.abac !== undefined) {
    const a = obj(cand.abac, 'candidate.abac');
    out.abac = { add: policySources(a.add, 'candidate.abac.add'), replace: policySources(a.replace, 'candidate.abac.replace'), remove: strList(a.remove, 'candidate.abac.remove') };
  }
  if (cand.rbac !== undefined) {
    const r = obj(cand.rbac, 'candidate.rbac');
    if (!Array.isArray(r.roles) || r.roles.length === 0 || r.roles.length > 200) throw bad('candidate.rbac.roles must list 1-200 role edits.', 'candidate.rbac.roles');
    out.rbac = {
      roles: r.roles.map((x: unknown, i: number) => {
        const o = obj(x, `candidate.rbac.roles[${i}]`);
        if (o.type !== 'org_role' && o.type !== 'app_role') throw bad('type must be org_role or app_role.', `candidate.rbac.roles[${i}].type`);
        if (typeof o.key !== 'string' || !o.key) throw bad('key is required.', `candidate.rbac.roles[${i}].key`);
        return { type: o.type, key: o.key, organizationId: typeof o.organization_id === 'string' ? o.organization_id : undefined, addPermissions: strList(o.add_permissions, 'add_permissions'), removePermissions: strList(o.remove_permissions, 'remove_permissions') };
      }),
    };
  }
  if (cand.fga !== undefined) {
    const f = obj(cand.fga, 'candidate.fga');
    if (typeof f.store_id !== 'string' || !f.store_id) throw bad('candidate.fga.store_id is required.', 'candidate.fga.store_id');
    out.fga = { storeId: f.store_id, writes: tupleList(f.writes, 'candidate.fga.writes'), deletes: tupleList(f.deletes, 'candidate.fga.deletes') };
  }
  if (cand.access_policy !== undefined) out.accessPolicy = obj(obj(cand.access_policy, 'candidate.access_policy').draft ?? cand.access_policy, 'candidate.access_policy.draft');
  if (!out.abac && !out.rbac && !out.fga && !out.accessPolicy) throw bad('candidate needs at least one of abac, rbac, fga, access_policy.', 'candidate');
  return out;
}

interface SourceStats {
  replayed: number;
  unchanged: number;
  allow_to_deny: number;
  deny_to_allow: number;
  baseline_mismatch: number;
}

function runWhatIf(e: Engine, body: Obj): Obj {
  const c = parseCandidate(obj(body.candidate, 'candidate'));
  const until = time(body.until, 'until') ?? e.clock.now();
  let since = time(body.since, 'since');
  if (since === undefined) {
    const days = body.days === undefined ? 7 : body.days;
    if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > 30) throw bad('days must be an integer from 1 to 30.', 'days');
    since = until - (days as number) * 86_400_000;
  }
  if (since >= until) throw bad('since must be before until.', 'since');
  if (until - since > 31 * 86_400_000) throw bad('The window can be at most 31 days.', 'since');
  const limit = body.limit === undefined ? REPLAY_LIMIT_DEFAULT : body.limit;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > REPLAY_LIMIT_MAX) throw bad(`limit must be an integer from 1 to ${REPLAY_LIMIT_MAX}.`, 'limit');
  if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 200)) throw bad('name must be a string of at most 200 characters.', 'name');
  if (body.save !== undefined && typeof body.save !== 'boolean') throw bad('save must be a boolean.', 'save');
  if (c.fga && !storeExists(e, c.fga.storeId)) throw bad('Unknown FGA store.', 'candidate.fga.store_id');
  if (c.fga && !latestModel(e, c.fga.storeId)) throw bad('The FGA store has no authorization model.', 'candidate.fga.store_id');

  const by: Record<string, SourceStats> = {};
  const skippedBy: Record<string, number> = {};
  const skip = (reason: string) => void (skippedBy[reason] = (skippedBy[reason] ?? 0) + 1);
  const flips: Obj[] = [];
  const principals = new Set<string>();
  let replayed = 0;
  const note = (row: Obj, before: 'allow' | 'deny', after: 'allow' | 'deny', mismatch: boolean) => {
    replayed++;
    const s = (by[row.source] ??= { replayed: 0, unchanged: 0, allow_to_deny: 0, deny_to_allow: 0, baseline_mismatch: 0 });
    s.replayed++;
    if (mismatch) s.baseline_mismatch++;
    if (before === after) return void s.unchanged++;
    if (before === 'allow') s.allow_to_deny++;
    else s.deny_to_allow++;
    if (row.principal) principals.add(row.principal);
    if (flips.length < SAMPLE_CAP) flips.push({ decision_id: row.id, source: row.source, principal: row.principal, action: row.action, resource: row.resource, before, after, at: row.at });
  };
  const pdp = c.abac ? loadPdp(e) : null;
  const cpdp = c.abac && pdp ? candidatePdp(pdp, c.abac) : null;
  const all = st(e).decisions.all().filter((d) => d.at >= since! && d.at <= until);
  const rows = all.slice(0, limit as number);
  for (const row of rows) {
    try {
      if (['abac', 'authzen', 'mcp_gateway', 'pdp'].includes(row.source) && pdp && cpdp) {
        const req = row.input as CedarRequest | null;
        if (!req || typeof req !== 'object' || !req.principal || !req.resource) {
          skip('no_input');
          continue;
        }
        const now = abacDecide(pdp, req).decision;
        note(row, now, abacDecide(cpdp, req).decision, now !== row.decision);
      } else if (row.source === 'rbac' && c.rbac) {
        if (row.result?.kind !== 'role' || !row.action) {
          skip('rbac_not_role_based');
          continue;
        }
        note(row, row.decision, replayRoleDecision(row.result, c.rbac.roles, row.action) ? 'allow' : 'deny', false);
      } else if (row.source === 'fga' && c.fga) {
        if (row.policyVersion?.store_id !== c.fga.storeId) {
          skip('other_store');
          continue;
        }
        const i = row.input ?? {};
        if (!i.user || !i.relation || !i.object) {
          skip('no_input');
          continue;
        }
        const req = { user: i.user, relation: i.relation, object: i.object, contextual: i.contextual_tuples };
        const now = fgaCheck(e, c.fga.storeId, req) ? 'allow' : 'deny';
        note(row, now, fgaCheck(e, c.fga.storeId, req, { writes: c.fga.writes, deletes: c.fga.deletes }) ? 'allow' : 'deny', now !== row.decision);
      } else skip(row.source === 'access_policy' ? 'access_policy_replayed_separately' : 'no_matching_candidate');
    } catch {
      skip('replay_error');
    }
  }
  // shortcut: the emulator keeps no sampled sign-ins, so an access-policy candidate has nothing to replay against.
  if (c.accessPolicy) skip('access_policy_no_sampled_sign_ins');
  const totals = { unchanged: 0, allow_to_deny: 0, deny_to_allow: 0 };
  for (const s of Object.values(by)) {
    totals.unchanged += s.unchanged;
    totals.allow_to_deny += s.allow_to_deny;
    totals.deny_to_allow += s.deny_to_allow;
  }
  const result: Obj = { object: 'authz_what_if', name: body.name ?? null, window: { since, until }, evaluated: rows.length, replayed, truncated: all.length > rows.length, skipped: skippedBy, by_source: by, totals, affected_principals: principals.size, samples: flips };
  if (body.save === false) return { ...result, status: 200 };
  const describe = {
    ...(c.abac ? { abac: c.abac } : {}),
    ...(c.rbac ? { rbac: { roles: c.rbac.roles.map((r) => ({ type: r.type, key: r.key, organization_id: r.organizationId ?? null, add_permissions: r.addPermissions, remove_permissions: r.removePermissions })) } } : {}),
    ...(c.fga ? { fga: { store_id: c.fga.storeId, writes: c.fga.writes, deletes: c.fga.deletes } } : {}),
    ...(c.accessPolicy ? { access_policy: { draft: c.accessPolicy } } : {}),
  };
  const saved = st(e).whatIf.insert({ name: body.name ?? null, candidate: describe, window_start: since, window_end: until, summary: { evaluated: rows.length, replayed, truncated: result.truncated, totals, affected_principals: principals.size, by_source: by }, result, created_at: e.clock.now() });
  return { ...result, id: saved.id, created_at: saved.created_at, status: 201 };
}

const whatIfView = (r: Obj, full: boolean): Obj => ({ object: 'authz_what_if_run', id: r.id, name: r.name, candidate: r.candidate, window: { since: r.window_start, until: r.window_end }, summary: r.summary, ...(full ? { result: r.result } : {}), created_by: null, created_at: r.created_at });

/** One sync run: write what should exist; with `repair`, also delete managed tuples that no longer should. Only managed tuples are ever touched. */
function runSync(e: Engine, kind: 'backfill' | 'initial', repair: boolean): Obj {
  const s = st(e);
  const now = e.clock.now();
  const { written, deleted } = reconcileManaged(e, repair);
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

export function authzHandlers(): RouteDef[] {
  return [
    {
      method: 'POST',
      pattern: '/v1/authz/explain',
      scope: 'authz_decisions:read',
      handler: (c) => {
        const input = parseExplainBody(c.body);
        // Signals a caller proxies in headers (country, risk level, device trust) apply when the body does not say.
        input.access = { ...input.access, signals: firstOf(input.access?.signals, headerSignals(c.request.headers)) };
        return { body: explainAccess(c.engine, input) };
      },
    },
    {
      // The same role check, written to the decision log (the corpus what-if replays).
      method: 'POST',
      pattern: '/v1/authz/rbac/check',
      scope: 'authz_decisions:read',
      handler: (c) => {
        const e = c.engine;
        const subject = (c.body.subject ?? {}) as Obj;
        if (typeof subject.id !== 'string' || !subject.id) throw bad('subject.id is required.', 'subject.id');
        if (typeof c.body.permission !== 'string' || !c.body.permission) throw bad('permission is required.', 'permission');
        if (c.body.organization_id !== undefined && typeof c.body.organization_id !== 'string') throw bad('organization_id must be a string.', 'organization_id');
        const input = { userId: subject.id, permission: c.body.permission, organizationId: c.body.organization_id as string | undefined };
        const r = rbacCheck(e, input);
        recordRbacCheck(e, input, r);
        const rules = [...r.layers.rbac.contributions, ...r.layers.org_roles.contributions, ...r.layers.groups.contributions].filter((x: Obj) => x.matched);
        return { body: { object: 'rbac_check', allowed: r.allowed, decision: r.allowed ? 'allow' : 'deny', grants: r.grants, rules } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/authz/what_if',
      scope: 'authz_decisions:read',
      handler: (c) => {
        const { status, ...body } = runWhatIf(c.engine, c.body) as Obj;
        return { status, body };
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
        const owned = [...s.managed.values()];
        s.managed.clear();
        if (owned.length) applyTuples(e, s.config.store_id, [], owned, 'sync');
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
