/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteDef } from '../engine';
import { EmulatorError, notFound } from '../errors';
import type { Obj } from '../openapi';
import { Table } from '../store';
import { engineState } from './support';

/**
 * The agent delegation graph and continuous access evaluation. A delegation says an agent acts under a grant from a user
 * (root) or from another agent (child), for named scopes, until a time. Children only narrow (scopes, lifetime, resource), the
 * chain has a depth limit, revoking a delegation revokes everything below it, and a machine that holds any delegation mints
 * tokens only under a live one, narrowed to its scopes and carrying `delegation`, `act` and `posture` claims. With continuous
 * evaluation on, the delegator's live posture (account, MFA freshness, risk, device) is re-checked on every mint and evaluate.
 */
const bad = (m: string, p?: string) => new EmulatorError('VALIDATION_FAILED', m, p);
const conflict = (m: string) => new EmulatorError('CONFLICT', m);
const SCOPE = /^[A-Za-z0-9:_./-]{1,100}$/;
const MAX_CHILDREN = 100;
export const EVALUATION_VALID_FOR_SECONDS = 30;
const RISK = { low: 0, medium: 1, high: 2 } as const;
type Risk = keyof typeof RISK;

export interface Fabric {
  continuousEvaluation: boolean;
  maxMfaAgeSeconds: number | null;
  maxRiskLevel: Risk | null;
  requireTrustedDevice: boolean;
  onFailure: 'revoke' | 'deny';
  maxDelegationDepth: number;
  defaultDelegationTtlSeconds: number;
}
const defaultFabric = (): Fabric => ({ continuousEvaluation: false, maxMfaAgeSeconds: null, maxRiskLevel: null, requireTrustedDevice: false, onFailure: 'revoke', maxDelegationDepth: 4, defaultDelegationTtlSeconds: 86_400 });

interface State {
  audit: Obj[];
  cfg: Fabric;
  /** user id -> posture the test set (MFA time, risk, device compliance) */
  posture: Map<string, { mfa_at?: number | null; risk?: Risk | null; device_compliant?: boolean }>;
  delegations: Table;
  evaluations: Table;
}
const st = engineState((e: Engine): State => ({ audit: [], cfg: defaultFabric(), posture: new Map(), delegations: new Table('agent_delegations', e.clock.now, 'dlg'), evaluations: new Table('agent_access_evaluations', e.clock.now, 'aev') }));

/** Audit rows for every authorization-surface mutation (read back with `GET /__emulator/authz/audit`). */
export function auditAuthz(e: Engine, action: string, targetType: string, targetId: string, metadata: Obj = {}): void {
  st(e).audit.push({ id: e.db.newId('audit'), action, actor_type: 'api_key', actor_id: 'emulator', target_type: targetType, target_id: targetId, metadata, created_at: e.clock.now() });
}
export const authzAuditRows = (e: Engine): Obj[] => st(e).audit;

// ── views ──

const table = (e: Engine) => st(e).delegations;
export const delegationView = (d: Obj): Obj => ({
  object: 'agent_delegation',
  id: d.id,
  child_machine_id: d.child_machine_id,
  parent_delegation_id: d.parent_delegation_id ?? null,
  root_delegation_id: d.root_delegation_id,
  parent_machine_id: d.parent_machine_id ?? null,
  delegator_user_id: d.delegator_user_id ?? null,
  organization_id: d.organization_id ?? null,
  depth: d.depth,
  scopes: d.scopes,
  resource: d.resource ?? null,
  status: d.status,
  expires_at: d.expires_at ?? null,
  revoked_at: d.revoked_at ?? null,
  revoked_by: d.revoked_by ?? null,
  revoked_reason: d.revoked_reason ?? null,
  posture: d.posture ?? null,
  last_decision: d.last_decision ?? null,
  last_evaluated_at: d.last_evaluated_at ?? null,
  created_at: d.created_at,
});
const isLive = (d: Obj, now: number): boolean => d.status === 'active' && (!d.expires_at || d.expires_at > now);
/** The ancestors of a delegation, root first, ending with the delegation itself. */
const chainOf = (e: Engine, d: Obj): Obj[] => {
  const out: Obj[] = [];
  for (let cur: Obj | undefined = d; cur && out.length < 20; cur = cur.parent_delegation_id ? table(e).get(cur.parent_delegation_id) : undefined) out.unshift(cur);
  return out;
};
/** A delegation and everything below it. */
const subtreeOf = (e: Engine, id: string): Obj[] => {
  const root = table(e).get(id);
  if (!root) return [];
  const out = [root];
  for (let i = 0; i < out.length; i++) out.push(...table(e).filter((d) => d.parent_delegation_id === out[i]!.id).reverse());
  return out;
};

// ── posture and evaluation ──

interface Posture {
  usable: boolean;
  activeSessions: number;
  mfaAt: number | null;
  risk: Risk | null;
  deviceCompliant: boolean;
}
function loadPosture(e: Engine, userId: string): Posture {
  const u = e.db.users.get(userId);
  const now = e.clock.now();
  const usable = !!u && !u.deleted && u.banned !== true && u.locked !== true;
  const sessions = e.db.sessions.filter((s) => s.user_id === userId && s.status === 'active' && (!s.expires_at || s.expires_at > now));
  const set = st(e).posture.get(userId) ?? {};
  let mfaAt: number | null = set.mfa_at ?? null;
  let risk: Risk | null = set.risk ?? null;
  for (const s of sessions) {
    if (set.mfa_at === undefined && s.step_up_method && s.auth_time && (mfaAt === null || s.auth_time > mfaAt)) mfaAt = s.auth_time;
    const level = s.risk?.level as Risk | undefined;
    if (set.risk === undefined && level && (risk === null || RISK[level] > RISK[risk])) risk = level;
  }
  return { usable, activeSessions: sessions.length, mfaAt, risk, deviceCompliant: set.device_compliant === true };
}
const postureClaim = (p: Posture, now: number): Obj => ({ mfa_at: p.mfaAt ? Math.floor(p.mfaAt / 1000) : null, risk: p.risk, device: p.deviceCompliant ? 'compliant' : 'unknown', evaluated_at: Math.floor(now / 1000) });

function verdictOf(cfg: Fabric, p: Posture, now: number): { decision: 'allow' | 'deny'; reasons: string[] } {
  const reasons: string[] = [];
  if (!p.usable) reasons.push('delegator_unavailable');
  if ((cfg.maxMfaAgeSeconds !== null || cfg.maxRiskLevel !== null) && p.activeSessions === 0) reasons.push('no_active_session');
  if (cfg.maxMfaAgeSeconds !== null && p.activeSessions > 0 && (!p.mfaAt || now - p.mfaAt > cfg.maxMfaAgeSeconds * 1000)) reasons.push('mfa_stale');
  if (cfg.maxRiskLevel !== null && p.risk !== null && RISK[p.risk] > RISK[cfg.maxRiskLevel]) reasons.push('risk_too_high');
  if (cfg.requireTrustedDevice && !p.deviceCompliant) reasons.push('untrusted_device');
  return { decision: reasons.length ? 'deny' : 'allow', reasons };
}
interface Evaluation {
  decision: 'allow' | 'deny' | 'revoked';
  reasons: string[];
  posture: Obj | null;
}
function evaluate(e: Engine, d: Obj): Evaluation {
  const now = e.clock.now();
  if (d.status !== 'active') return { decision: 'revoked', reasons: ['delegation_revoked'], posture: null };
  if (!isLive(d, now)) return { decision: 'deny', reasons: ['delegation_expired'], posture: null };
  const dead = chainOf(e, d).find((c) => !isLive(c, now));
  if (dead) return { decision: dead.status !== 'active' ? 'revoked' : 'deny', reasons: [dead.status !== 'active' ? 'delegation_revoked' : 'delegation_expired'], posture: null };
  if (!d.delegator_user_id) return { decision: 'allow', reasons: [], posture: null };
  const p = loadPosture(e, d.delegator_user_id);
  const cfg = st(e).cfg;
  // The instance policy applies only when continuous evaluation is on; the delegator's account state always does.
  const v = verdictOf(cfg.continuousEvaluation ? cfg : { ...cfg, maxMfaAgeSeconds: null, maxRiskLevel: null, requireTrustedDevice: false }, p, now);
  return { decision: v.decision, reasons: v.reasons, posture: postureClaim(p, now) };
}

function revokeSubtree(e: Engine, ids: Obj[], reason: string): Obj[] {
  const now = e.clock.now();
  const out: Obj[] = [];
  for (const d of ids) {
    if (d.status !== 'active') continue;
    table(e).update(d.id, { status: 'revoked', revoked_at: now, revoked_by: 'secret_key', revoked_reason: reason });
    out.push(table(e).get(d.id)!);
  }
  return out;
}
function finishRevocation(e: Engine, revoked: Obj[], rootId: string | null, opts: { reason: string; disableAgents: boolean; trigger: string }): Obj {
  const machineIds = [...new Set(revoked.map((r) => r.child_machine_id))];
  const disabled: string[] = [];
  if (opts.disableAgents) {
    const now = e.clock.now();
    for (const mid of machineIds) {
      if (table(e).filter((d) => d.child_machine_id === mid && isLive(d, now)).length === 0) {
        const m = e.db.machines.get(mid);
        if (m && !m.deleted) (e.db.machines.update(mid, { status: 'revoked', updated_at: now }), disabled.push(mid));
      }
    }
  }
  if (revoked.length) {
    const data = { object: 'agent_delegation_revocation', root_id: rootId, reason: opts.reason, trigger: opts.trigger, delegation_ids: revoked.map((r) => r.id), machine_ids: machineIds, disabled_machine_ids: disabled, count: revoked.length };
    auditAuthz(e, 'agent.delegation_revoked', 'agent_delegation', rootId ?? revoked[0]!.id, data);
    e.webhooks.emit('agent.delegation_revoked', data);
  }
  return { object: 'agent_delegation_revocation', revoked: revoked.map(delegationView), disabled_machine_ids: disabled, count: revoked.length };
}

/** Record a change of standing and, on a deny, act as the instance's `onFailure` says. Returns the evaluation. */
function enforce(e: Engine, root: Obj, ev: Evaluation): Evaluation {
  const s = st(e);
  const now = e.clock.now();
  if (ev.decision !== (root.last_decision ?? 'allow')) s.evaluations.insert({ delegation_id: root.id, decision: ev.decision, reasons: ev.reasons, posture: ev.posture ?? {}, evaluated_at: now });
  table(e).update(root.id, { last_decision: ev.decision, last_evaluated_at: now });
  if (ev.decision === 'deny') {
    const revokeNow = s.cfg.onFailure === 'revoke' && !ev.reasons.includes('delegation_expired');
    e.webhooks.emit('agent.access_denied', { object: 'agent_access_evaluation', delegation_id: root.id, root_delegation_id: root.root_delegation_id, child_machine_id: root.child_machine_id, reasons: ev.reasons, action: revokeNow ? 'revoked' : 'denied' });
    if (revokeNow) finishRevocation(e, revokeSubtree(e, subtreeOf(e, root.root_delegation_id), `access_evaluation:${ev.reasons.join(',')}`), root.root_delegation_id, { reason: `access_evaluation:${ev.reasons.join(',')}`, disableAgents: false, trigger: 'evaluation' });
  }
  return ev;
}
const rootOf = (e: Engine, d: Obj): Obj => (d.parent_delegation_id ? (table(e).get(d.root_delegation_id) ?? d) : d);

// ── token minting hook ──

/**
 * Called by every machine-token mint. A machine with no delegation is unaffected. One that has any must hold a live delegation:
 * the one named by `delegation_id`, or the newest live one. Returns what the mint must apply: scopes narrowed to the delegated
 * scopes (never widened), a lifetime cap and the `delegation`, `act` and `posture` claims. Refuses (403) when none is live or
 * the continuous evaluation fails.
 */
export function delegationForMint(e: Engine, machineId: string, req: Obj): { scopes: string[]; ttlSeconds: number; claims: Obj } | null {
  const mine = table(e).filter((d) => d.child_machine_id === machineId);
  if (!mine.length) return null;
  const now = e.clock.now();
  let d: Obj | undefined;
  if (typeof req.delegation_id === 'string' && req.delegation_id) {
    d = mine.find((x) => x.id === req.delegation_id);
    if (!d) throw new EmulatorError('FORBIDDEN', 'That delegation does not belong to this machine.', 'delegation_id');
  } else d = mine.find((x) => isLive(x, now));
  if (!d || !isLive(d, now)) throw new EmulatorError('FORBIDDEN', 'This machine has no live delegation: it may not mint tokens.');
  const root = rootOf(e, d);
  const ev = enforce(e, root, evaluate(e, d));
  if (ev.decision !== 'allow') throw new EmulatorError('FORBIDDEN', `The delegation is not usable right now (${ev.reasons.join(', ')}).`);
  const chain = chainOf(e, d);
  const principals: string[] = [];
  if (chain[0]?.delegator_user_id) principals.push(chain[0].delegator_user_id);
  for (const c of chain.slice(0, -1)) principals.push(c.child_machine_id);
  let act: Obj | undefined;
  for (const sub of principals) act = act ? { sub, act } : { sub };
  const ttlSeconds = d.expires_at ? Math.max(1, Math.floor((d.expires_at - now) / 1000)) : Number.MAX_SAFE_INTEGER;
  return {
    scopes: d.scopes,
    ttlSeconds,
    claims: { delegation: { id: d.id, root: d.root_delegation_id, depth: d.depth, delegator: chain[0]?.delegator_user_id ?? null, scopes: d.scopes }, ...(act ? { act } : {}), posture: ev.posture ?? undefined },
  };
}
/** What `POST /v1/m2m_tokens/verify` adds for a token minted under a delegation: null when it has none, `revoked` when it is no longer live. */
export function delegationOfToken(e: Engine, claims: Obj): { live: boolean; delegation: Obj } | null {
  const id = claims.delegation?.id;
  if (typeof id !== 'string') return null;
  const d = table(e).get(id);
  if (!d) return { live: false, delegation: delegationView({ id, status: 'revoked', scopes: [] }) };
  const now = e.clock.now();
  return { live: chainOf(e, d).every((c) => isLive(c, now)), delegation: delegationView(d) };
}

// ── routes ──

const obj = (b: unknown): Obj => b as Obj;
const reasonOf = (b: Obj): string => {
  if (b.reason === undefined) return 'operator';
  if (typeof b.reason !== 'string' || !b.reason.trim() || b.reason.length > 200) throw bad('reason must be a short string.', 'reason');
  return b.reason.trim();
};
// shortcut: unknown body fields are ignored (the engine's own strict mode rejects them where the document lists the route).
const known = (_b: Obj, _fields: readonly string[]): void => undefined;
const DELEGATION_FIELDS = ['child_machine_id', 'delegator_user_id', 'parent_delegation_id', 'scopes', 'resource', 'expires_in_seconds', 'expires_at', 'organization_id'] as const;

function createDelegation(e: Engine, body: Obj): Obj {
  const cfg = st(e).cfg;
  const now = e.clock.now();
  if (typeof body.child_machine_id !== 'string' || !body.child_machine_id) throw bad('child_machine_id is required.', 'child_machine_id');
  if (!Array.isArray(body.scopes) || !body.scopes.length || body.scopes.length > 50 || body.scopes.some((s: unknown) => typeof s !== 'string' || !SCOPE.test(s))) throw bad('scopes must be a list of 1 to 50 scope names.', 'scopes');
  const scopes = [...new Set(body.scopes as string[])];
  if (body.resource !== undefined && body.resource !== null && (typeof body.resource !== 'string' || body.resource.length > 255)) throw bad('resource must be a string.', 'resource');
  const resource: string | null = (body.resource as string | null | undefined) ?? null;
  const child = e.db.machines.get(body.child_machine_id);
  if (!child || child.deleted) throw notFound('Machine');
  if (child.status !== 'active') throw conflict('The machine must be active to receive a delegation.');
  let parent: Obj | undefined;
  let delegator: string | null = null;
  if (typeof body.parent_delegation_id === 'string' && body.parent_delegation_id) {
    if (body.delegator_user_id !== undefined) throw bad('A delegation under a parent takes its delegator from the root: omit delegator_user_id.', 'delegator_user_id');
    parent = table(e).get(body.parent_delegation_id);
    if (!parent) throw new EmulatorError('NOT_FOUND', 'Unknown parent delegation.');
    if (!isLive(parent, now)) throw conflict('The parent delegation is revoked or expired.');
    if (parent.depth >= cfg.maxDelegationDepth) throw conflict(`Delegations can be at most ${cfg.maxDelegationDepth} deep.`);
    if (table(e).filter((d) => d.parent_delegation_id === parent!.id && d.status === 'active').length >= MAX_CHILDREN) throw conflict(`A delegation can have at most ${MAX_CHILDREN} active children.`);
    if (parent.child_machine_id === child.id) throw bad('An agent cannot delegate to itself.', 'child_machine_id');
    if (chainOf(e, parent).some((c) => c.child_machine_id === child.id)) throw bad('That agent is already an ancestor in this chain: a delegation cannot loop.', 'child_machine_id');
    const extra = scopes.filter((s) => !parent!.scopes.includes(s));
    if (extra.length) throw bad(`A child delegation cannot hold scopes its parent lacks: ${extra.join(', ')}.`, 'scopes');
    if (parent.resource && resource && parent.resource !== resource) throw bad("A child delegation stays on its parent's resource.", 'resource');
    delegator = parent.delegator_user_id ?? null;
  } else {
    if (typeof body.delegator_user_id !== 'string' || !body.delegator_user_id) throw bad('delegator_user_id is required for a root delegation (or give parent_delegation_id).', 'delegator_user_id');
    const u = e.db.users.get(body.delegator_user_id);
    if (!u || u.deleted || u.banned === true || u.locked === true) throw new EmulatorError('NOT_FOUND', 'Unknown user.');
    delegator = u.id;
  }
  let expiresAt: number;
  if (body.expires_at !== undefined && body.expires_in_seconds !== undefined) throw bad('Send expires_at or expires_in_seconds, not both.', 'expires_at');
  if (body.expires_in_seconds !== undefined) {
    const s = body.expires_in_seconds;
    if (typeof s !== 'number' || !Number.isInteger(s) || s < 60 || s > 2_592_000) throw bad('expires_in_seconds must be a whole number of seconds from 60 to 2592000.', 'expires_in_seconds');
    expiresAt = now + s * 1000;
  } else if (body.expires_at !== undefined) {
    const at = typeof body.expires_at === 'number' || typeof body.expires_at === 'string' ? new Date(body.expires_at).getTime() : NaN;
    if (Number.isNaN(at) || at <= now || at - now > 2_592_000_000) throw bad('expires_at must be a future time within 30 days.', 'expires_at');
    expiresAt = at;
  } else expiresAt = now + cfg.defaultDelegationTtlSeconds * 1000;
  if (parent?.expires_at && expiresAt > parent.expires_at) expiresAt = parent.expires_at;
  let posture: Obj | null = null;
  if (!parent && delegator) {
    const p = loadPosture(e, delegator);
    posture = postureClaim(p, now);
    // A root delegation is refused when the live policy already fails: it would be revoked at once.
    if (cfg.continuousEvaluation) {
      const v = verdictOf(cfg, p, now);
      if (v.decision === 'deny') throw new EmulatorError('FORBIDDEN', `The delegator does not meet the instance's access policy (${v.reasons.join(', ')}).`);
    }
  }
  const row = table(e).insert({ child_machine_id: child.id, parent_delegation_id: parent?.id ?? null, root_delegation_id: parent?.root_delegation_id ?? '', parent_machine_id: parent?.child_machine_id ?? null, delegator_user_id: delegator, organization_id: typeof body.organization_id === 'string' ? body.organization_id : null, depth: (parent?.depth ?? 0) + 1, scopes, resource, status: 'active', expires_at: expiresAt, revoked_at: null, revoked_by: null, revoked_reason: null, posture, last_decision: null, last_evaluated_at: null, created_at: now });
  if (!parent) table(e).update(row.id, { root_delegation_id: row.id });
  const fresh = table(e).get(row.id)!;
  auditAuthz(e, 'agent.delegation_created', 'agent_delegation', fresh.id, { child_machine_id: fresh.child_machine_id, parent_delegation_id: fresh.parent_delegation_id, delegator_user_id: fresh.delegator_user_id, depth: fresh.depth, scopes: fresh.scopes, expires_at: fresh.expires_at });
  e.webhooks.emit('agent.delegation_created', { object: 'agent_delegation', id: fresh.id, child_machine_id: fresh.child_machine_id, parent_delegation_id: fresh.parent_delegation_id, root_delegation_id: fresh.root_delegation_id, delegator_user_id: fresh.delegator_user_id, depth: fresh.depth, scopes: fresh.scopes, expires_at: fresh.expires_at });
  return delegationView(fresh);
}

const find = (e: Engine, id: string | undefined): Obj => {
  const d = table(e).get(id);
  if (!d) throw new EmulatorError('NOT_FOUND', 'Unknown delegation.');
  return d;
};

export function emu4TrustAuthzHandlers(): RouteDef[] {
  const base = '/v1/agent_delegations';
  const boolField = (b: Obj, k: string) => {
    if (b[k] !== undefined && typeof b[k] !== 'boolean') throw bad(`${k} must be true or false.`, k);
  };
  return [
    { method: 'POST', pattern: base, scope: 'machines:write', handler: (c) => (known(obj(c.body), DELEGATION_FIELDS), { status: 201, body: createDelegation(c.engine, obj(c.body)) }) },
    {
      method: 'GET',
      pattern: base,
      scope: 'machines:read',
      handler: (c) => {
        const q = c.query;
        const status = q.get('status');
        if (status !== null && status !== 'active' && status !== 'revoked') throw bad('status must be active or revoked.', 'status');
        const limit = Math.min(Math.max(Math.trunc(Number(q.get('limit') ?? 50)) || 50, 1), 200);
        let rows = table(c.engine).all().filter((d) => (!q.get('machine_id') || d.child_machine_id === q.get('machine_id')) && (!q.get('delegator_user_id') || d.delegator_user_id === q.get('delegator_user_id')) && (!q.get('root_id') || d.root_delegation_id === q.get('root_id')) && (!status || d.status === status));
        const after = q.get('starting_after');
        if (after) rows = rows.slice(rows.findIndex((d) => d.id === after) + 1);
        return { body: { object: 'list', data: rows.slice(0, limit).map(delegationView), has_more: rows.length > limit } };
      },
    },
    {
      method: 'POST',
      pattern: `${base}/revoke_for_user`,
      scope: 'machines:write',
      handler: (c) => {
        const b = obj(c.body);
        known(b, ['user_id', 'reason', 'disable_agents']);
        if (typeof b.user_id !== 'string' || !b.user_id) throw bad('user_id is required.', 'user_id');
        boolField(b, 'disable_agents');
        const e = c.engine;
        const roots = table(e).filter((d) => d.delegator_user_id === b.user_id && d.status === 'active');
        const revoked = revokeSubtree(e, roots.flatMap((r) => subtreeOf(e, r.id)).filter((d, i, a) => a.findIndex((x) => x.id === d.id) === i), reasonOf(b));
        return { body: finishRevocation(e, revoked, null, { reason: reasonOf(b), disableAgents: b.disable_agents === true, trigger: 'operator' }) };
      },
    },
    {
      method: 'GET',
      pattern: `${base}/:id`,
      scope: 'machines:read',
      handler: (c) => {
        const d = find(c.engine, c.params.id);
        const evs = st(c.engine).evaluations.filter((x) => x.delegation_id === d.id).slice(0, 10);
        return { body: { ...delegationView(d), evaluations: evs.map((x) => ({ decision: x.decision, reasons: x.reasons, evaluated_at: x.evaluated_at })) } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/agent_delegations/:id/graph',
      scope: 'machines:read',
      handler: (c) => {
        const e = c.engine;
        const d = find(e, c.params.id);
        const nodes = subtreeOf(e, d.id).sort((a, b) => a.depth - b.depth);
        return { body: { object: 'agent_delegation_graph', root_id: d.root_delegation_id, ancestors: chainOf(e, d).filter((a) => a.id !== d.id).map(delegationView), nodes: nodes.map(delegationView), edges: nodes.filter((n) => n.parent_delegation_id).map((n) => ({ from: n.parent_delegation_id, to: n.id, parent_machine_id: n.parent_machine_id, child_machine_id: n.child_machine_id })) } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/agent_delegations/:id/revoke',
      scope: 'machines:write',
      handler: (c) => {
        const e = c.engine;
        const b = obj(c.body);
        known(b, ['reason', 'disable_agents']);
        boolField(b, 'disable_agents');
        const d = find(e, c.params.id);
        return { body: finishRevocation(e, revokeSubtree(e, subtreeOf(e, d.id), reasonOf(b)), d.id, { reason: reasonOf(b), disableAgents: b.disable_agents === true, trigger: 'operator' }) };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/agent_delegations/:id/evaluate',
      scope: 'machines:read',
      handler: (c) => {
        const e = c.engine;
        const b = obj(c.body);
        known(b, ['enforce']);
        boolField(b, 'enforce');
        const d = find(e, c.params.id);
        const ev = evaluate(e, d);
        if (b.enforce === true && d.status === 'active') enforce(e, rootOf(e, d), ev);
        return { headers: { 'cache-control': 'no-store' }, body: { object: 'agent_access_evaluation', delegation_id: d.id, decision: ev.decision, reasons: ev.reasons, posture: ev.posture, valid_for_seconds: ev.decision === 'allow' ? EVALUATION_VALID_FOR_SECONDS : 0, evaluated_at: e.clock.now() } };
      },
    },
    // ── emulator control: the instance policy, the delegator's live posture and the worker sweep ──
    { method: 'GET', pattern: '/__emulator/agent_fabric', public: true, handler: (c) => ({ body: st(c.engine).cfg }) },
    {
      method: 'PUT',
      pattern: '/__emulator/agent_fabric',
      public: true,
      handler: (c) => {
        const b = obj(c.body);
        const next: Fabric = { ...defaultFabric(), ...st(c.engine).cfg, ...b };
        const int = (k: keyof Fabric, min: number, max: number, nullable: boolean) => {
          const v = next[k] as unknown;
          if (nullable && v === null) return;
          if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw bad(`${k} must be a whole number from ${min} to ${max}${nullable ? ' (or null)' : ''}.`, k);
        };
        if (typeof next.continuousEvaluation !== 'boolean' || typeof next.requireTrustedDevice !== 'boolean') throw bad('continuousEvaluation and requireTrustedDevice are true or false.', 'continuousEvaluation');
        if (next.maxRiskLevel !== null && !(next.maxRiskLevel in RISK)) throw bad('maxRiskLevel must be low, medium, high or null.', 'maxRiskLevel');
        if (next.onFailure !== 'revoke' && next.onFailure !== 'deny') throw bad('onFailure must be revoke or deny.', 'onFailure');
        int('maxMfaAgeSeconds', 60, 86_400, true);
        int('maxDelegationDepth', 1, 8, false);
        int('defaultDelegationTtlSeconds', 60, 2_592_000, false);
        st(c.engine).cfg = next;
        return { body: next };
      },
    },
    {
      method: 'PUT',
      pattern: '/__emulator/agent_posture/:userId',
      public: true,
      handler: (c) => {
        const b = obj(c.body);
        const p: { mfa_at?: number | null; risk?: Risk | null; device_compliant?: boolean } = {};
        if (b.mfa_at !== undefined) (b.mfa_at === null || Number.isFinite(b.mfa_at) ? (p.mfa_at = b.mfa_at as number | null) : (() => { throw bad('mfa_at is epoch milliseconds or null.', 'mfa_at'); })());
        if (b.risk !== undefined) (b.risk === null || (typeof b.risk === 'string' && b.risk in RISK) ? (p.risk = b.risk as Risk | null) : (() => { throw bad('risk must be low, medium, high or null.', 'risk'); })());
        if (b.device_compliant !== undefined) (typeof b.device_compliant === 'boolean' ? (p.device_compliant = b.device_compliant) : (() => { throw bad('device_compliant must be true or false.', 'device_compliant'); })());
        st(c.engine).posture.set(c.params.userId!, { ...(st(c.engine).posture.get(c.params.userId!) ?? {}), ...p });
        return { body: { user_id: c.params.userId, ...st(c.engine).posture.get(c.params.userId!) } };
      },
    },
    {
      // What the worker does every minute: re-evaluate every live root delegation (only while continuous evaluation is on).
      method: 'POST',
      pattern: '/__emulator/agent_fabric/sweep',
      public: true,
      handler: (c) => {
        const e = c.engine;
        const out = { evaluated: 0, denied: 0 };
        if (!st(e).cfg.continuousEvaluation) return { body: out };
        for (const root of table(e).filter((d) => !d.parent_delegation_id && d.status === 'active')) {
          const ev = enforce(e, root, evaluate(e, root));
          out.evaluated++;
          if (ev.decision !== 'allow') out.denied++;
        }
        return { body: out };
      },
    },
    { method: 'GET', pattern: '/__emulator/authz/audit', public: true, handler: (c) => ({ body: { object: 'list', data: [...st(c.engine).audit].reverse() } }) },
  ];
}
