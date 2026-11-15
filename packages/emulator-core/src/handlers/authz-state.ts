/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine } from '../engine';
import type { Obj } from '../openapi';
import { Table, type Row } from '../store';
import { engineState } from './support';

/** State shared by the authorization handlers: decision log, what-if runs, sync, FGA tuples, group membership, role assignments. */
export interface Tuple {
  user: string;
  relation: string;
  object: string;
  condition?: { name: string; context?: Obj };
  expires_at?: number;
}
export interface StoredTuple extends Tuple {
  created_at: number;
}
export interface AuthzState {
  decisions: Table;
  whatIf: Table;
  runs: Table;
  /** group_id, user_id, source, source_ref, created_at */
  members: Table;
  /** user id -> app role ids assigned directly */
  userRoles: Map<string, Set<string>>;
  events: Obj[];
  seq: number;
  config: { enabled: boolean; store_id: string | null; memberships: boolean; org_roles: boolean; groups: boolean; updated_at: number | null };
  /** Tuples the sync owns (key -> tuple). */
  managed: Map<string, Tuple>;
  /** store id -> (tuple key -> tuple) */
  tuples: Map<string, Map<string, StoredTuple>>;
  revisions: Map<string, number>;
}
export const st = engineState(
  (e: Engine): AuthzState => ({
    decisions: new Table('authz_decisions', e.clock.now, 'azd'),
    whatIf: new Table('authz_what_if_runs', e.clock.now, 'wif'),
    runs: new Table('fga_sync_runs', e.clock.now, 'fsr'),
    members: new Table('group_members', e.clock.now, 'igm'),
    userRoles: new Map(),
    events: [],
    seq: 0,
    config: { enabled: false, store_id: null, memberships: true, org_roles: true, groups: true, updated_at: null },
    managed: new Map(),
    tuples: new Map(),
    revisions: new Map(),
  }),
);

export const tupleKey = (t: Tuple): string => `${t.user}|${t.relation}|${t.object}`;

export function pushEvent(e: Engine, kind: string, storeId: string | null, source: string, data: Obj): void {
  const s = st(e);
  s.events.push({ object: 'authz_event', id: e.db.newId('azev'), seq: ++s.seq, kind, store_id: storeId, store_revision: storeId ? (s.revisions.get(storeId) ?? 0) : s.seq, source, data, created_at: e.clock.now() });
}

/** A generic collection's table, created on first use with the id prefix the generic layer would use. */
export function genericTable(e: Engine, collection: string, prefix: string): Table {
  let t = e.generic.get(collection);
  if (!t) e.generic.set(collection, (t = new Table(collection, e.clock.now, prefix)));
  return t;
}

export const storeExists = (e: Engine, id: string): boolean => !!e.generic.get('fga/stores')?.get(id);
export const liveUser = (e: Engine, id: string | undefined): Row | undefined => {
  const u = e.db.users.get(id);
  return u && !u.deleted ? u : undefined;
};

/** The live (unexpired) tuples of a store. */
export function storeTuples(e: Engine, storeId: string): StoredTuple[] {
  const now = e.clock.now();
  return [...(st(e).tuples.get(storeId)?.values() ?? [])].filter((t) => t.expires_at === undefined || t.expires_at > now);
}

/**
 * Apply tuple writes and deletes to a store, bump its revision and announce the change the way the real service does:
 * one authorization feed entry per side and one webhook per non-empty side, carrying the count and a sample.
 * Returns the revision.
 */
export function applyTuples(e: Engine, storeId: string, writes: Tuple[], deletes: Tuple[], source: 'api' | 'sync'): number {
  const s = st(e);
  let m = s.tuples.get(storeId);
  if (!m) s.tuples.set(storeId, (m = new Map()));
  for (const t of deletes) m.delete(tupleKey(t));
  for (const t of writes) m.set(tupleKey(t), { ...t, created_at: e.clock.now() });
  const revision = (s.revisions.get(storeId) ?? 0) + 1;
  s.revisions.set(storeId, revision);
  const sides: Array<['written' | 'deleted', Tuple[]]> = [['written', writes], ['deleted', deletes]];
  for (const [side, list] of sides) {
    if (!list.length) continue;
    pushEvent(e, `tuples_${side}`, storeId, source, { count: list.length });
    e.webhooks.emit(`fga.tuple_${side}`, { object: 'fga_tuple_batch', store_id: storeId, store_revision: revision, source, count: list.length, tuples: list.slice(0, 25).map((t) => ({ user: t.user, relation: t.relation, object: t.object })), truncated: list.length > 25 });
  }
  return revision;
}

// ── groups ──

const groupTable = (e: Engine): Table | undefined => e.generic.get('groups');
export const findGroup = (e: Engine, idOrSlug: string | undefined): Row | undefined => groupTable(e)?.find((g) => g.id === idOrSlug || g.slug === idOrSlug);
export const groupMembers = (e: Engine, groupId: string): Row[] => st(e).members.filter((m) => m.group_id === groupId && !!liveUser(e, m.user_id));

/** Direct groups of a user, then every ancestor by parent_id (eight levels at most). */
export function effectiveGroups(e: Engine, userId: string): Row[] {
  const out = new Map<string, Row>();
  let frontier = st(e).members.filter((m) => m.user_id === userId).map((m) => groupTable(e)?.get(m.group_id)).filter((g): g is Row => !!g);
  for (let depth = 0; frontier.length && depth < 8; depth++) {
    const next: Row[] = [];
    for (const g of frontier) {
      if (out.has(g.id)) continue;
      out.set(g.id, g);
      const p = g.parent_id ? groupTable(e)?.get(g.parent_id) : undefined;
      if (p) next.push(p);
    }
    frontier = next;
  }
  return [...out.values()];
}
/** Ids and slugs of the effective groups, what policy conditions and resource subjects match against. */
export const effectiveGroupKeys = (e: Engine, userId: string): string[] => [...new Set(effectiveGroups(e, userId).flatMap((g) => [g.id, g.slug].filter(Boolean)))];

// ── app roles ──

export const appRoleTable = (e: Engine): Table | undefined => e.generic.get('app_roles');
export const findAppRole = (e: Engine, ref: string): Row | undefined => appRoleTable(e)?.find((r) => r.id === ref || r.key === ref);
export const directAppRoles = (e: Engine, userId: string): Row[] => [...(st(e).userRoles.get(userId) ?? [])].map((id) => appRoleTable(e)?.get(id)).filter((r): r is Row => !!r);

// ── managed sync ──

/** The tuples the sync should own right now: memberships, org roles and groups per the sync config. */
export function desiredTuples(e: Engine): Tuple[] {
  const cfg = st(e).config;
  const out: Tuple[] = [];
  for (const m of e.db.memberships.all()) {
    if (!liveUser(e, m.user_id)) continue;
    if (cfg.memberships) out.push({ user: `user:${m.user_id}`, relation: 'member', object: `organization:${m.organization_id}` });
    if (cfg.org_roles && m.role) out.push({ user: `user:${m.user_id}`, relation: String(m.role).replace(/^org:/, ''), object: `organization:${m.organization_id}` });
  }
  if (cfg.groups) {
    for (const g of groupTable(e)?.all() ?? []) {
      for (const m of groupMembers(e, g.id)) out.push({ user: `user:${m.user_id}`, relation: 'member', object: `group:${g.slug}` });
      const p = g.parent_id ? groupTable(e)?.get(g.parent_id) : undefined;
      if (p) out.push({ user: `group:${g.slug}#member`, relation: 'member', object: `group:${p.slug}` });
    }
  }
  return out;
}

/**
 * Bring the managed tuples in line with what should exist. A tuple that already exists in the store (written by the API)
 * is never taken over, so the sync never deletes what it did not write. Returns the counts.
 */
export function reconcileManaged(e: Engine, repair: boolean): { written: number; deleted: number } {
  const s = st(e);
  const storeId = s.config.store_id;
  if (!storeId) return { written: 0, deleted: 0 };
  const want = new Map(desiredTuples(e).map((t) => [tupleKey(t), t]));
  const have = s.tuples.get(storeId) ?? new Map();
  const writes: Tuple[] = [];
  const deletes: Tuple[] = [];
  for (const [k, t] of want) {
    if (s.managed.has(k) || have.has(k)) continue;
    s.managed.set(k, t);
    writes.push(t);
  }
  if (repair) {
    for (const [k, t] of [...s.managed]) {
      if (want.has(k)) continue;
      s.managed.delete(k);
      deletes.push(t);
    }
  }
  if (writes.length || deletes.length) applyTuples(e, storeId, writes, deletes, 'sync');
  return { written: writes.length, deleted: deletes.length };
}

/**
 * Call after any change to organization memberships, a user delete or group membership. With managed sync on, the
 * managed tuples are written and deleted right away (source `sync`) instead of waiting for a backfill.
 */
export function onMembershipChanged(e: Engine): void {
  const s = st(e);
  if (s.config.enabled && s.config.store_id) reconcileManaged(e, true);
}
