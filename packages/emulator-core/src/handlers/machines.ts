/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteDef } from '../engine';
import { EmulatorError, notFound } from '../errors';
import type { Obj } from '../openapi';
import { bump, listReply, need } from './util';

export function presentMachine(e: Engine, m: Obj): Obj {
  return e.shape('Machine', {
    object: 'machine',
    id: m.id,
    name: m.name,
    organization_id: m.organization_id ?? null,
    owner_user_id: m.owner_user_id ?? null,
    status: m.status,
    effective_status: m.status,
    metadata: m.metadata ?? {},
    created_at: m.created_at,
    updated_at: m.updated_at,
  });
}

export function presentGrant(e: Engine, g: Obj): Obj {
  return e.shape('MachineGrant', {
    object: 'machine_grant',
    id: g.id,
    machine_id: g.machine_id,
    resource_server_id: g.resource_server_id,
    scopes: g.scopes,
    constraints: g.constraints ?? null,
    expires_at: g.expires_at ?? null,
    created_at: g.created_at,
    updated_at: g.updated_at,
  });
}

const liveMachine = (e: Engine, id: string | undefined): Obj => {
  const m = e.db.machines.get(id);
  if (!m || m.deleted) throw notFound('Machine');
  return m;
};

// ── usage counters ─────────────────────────────────────────────────────

type Window = 'none' | 'minute' | 'hour' | 'day' | 'month';
interface CounterState {
  windowStart: number | null;
  used: number;
  flags: Set<number>;
}
interface Lease {
  id: string;
  grantId: string;
  counter: string;
  amount: number;
  expiresAt: number;
  status: 'active' | 'released' | 'expired';
  windowStart: number | null;
}
interface ConsumeRecord {
  decision: Obj;
  taken: number;
  refunded: number;
  lease: boolean;
  windowStart: number | null;
}

const usageStore = new WeakMap<Engine, { counters: Map<string, CounterState>; consumes: Map<string, ConsumeRecord>; refunds: Map<string, Obj>; leases: Map<string, Lease> }>();
const usageOf = (e: Engine) => {
  let s = usageStore.get(e);
  if (!s) usageStore.set(e, (s = { counters: new Map(), consumes: new Map(), refunds: new Map(), leases: new Map() }));
  return s;
};
export const resetUsage = (e: Engine): void => void usageStore.delete(e);

function windowStart(now: number, w: Window): number | null {
  if (w === 'none') return null;
  const d = new Date(now);
  if (w === 'minute') return Math.floor(now / 60_000) * 60_000;
  if (w === 'hour') return Math.floor(now / 3_600_000) * 3_600_000;
  if (w === 'day') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
function windowEnd(start: number | null, w: Window): number | null {
  if (start === null) return null;
  if (w === 'minute') return start + 60_000;
  if (w === 'hour') return start + 3_600_000;
  if (w === 'day') return start + 86_400_000;
  const d = new Date(start);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

function stateFor(e: Engine, grant: Obj, name: string, def: Obj): CounterState {
  const store = usageOf(e).counters;
  const id = `${grant.id}|${name}`;
  const start = windowStart(e.clock.now(), def.window ?? 'none');
  let st = store.get(id);
  if (!st || st.windowStart !== start) store.set(id, (st = { windowStart: start, used: st && def.window === 'none' ? st.used : 0, flags: new Set() }));
  return st;
}

function sweepLeases(e: Engine): void {
  const now = e.clock.now();
  const s = usageOf(e);
  for (const l of s.leases.values()) {
    if (l.status !== 'active' || l.expiresAt > now) continue;
    l.status = 'expired';
    const grant = e.db.grants.get(l.grantId);
    const def = grant?.constraints?.counters?.[l.counter];
    const st = s.counters.get(`${l.grantId}|${l.counter}`);
    if (def && st && st.windowStart === l.windowStart) st.used = Math.max(0, st.used - l.amount);
  }
}

function resolveGrant(e: Engine, type: string, id: string | undefined): Obj {
  if (type !== 'machine' && type !== 'agent') throw new EmulatorError('VALIDATION_FAILED', 'grantType must be machine or agent.', 'grantType');
  // Agent grants are not modelled by the emulator.
  const g = type === 'machine' ? e.db.grants.get(id) : undefined;
  if (!g) throw notFound('Grant');
  return g;
}

function decision(e: Engine, grant: Obj, name: string, def: Obj, st: CounterState, amount: number, allowed: boolean, reason: string | null, extra: Obj = {}): Obj {
  const limit = def.limit as number;
  return {
    object: 'usage_decision',
    allowed,
    counter: name,
    amount,
    used: st.used,
    limit,
    remaining: Math.max(0, limit - st.used),
    window: def.window ?? 'none',
    window_start: st.windowStart,
    resets_at: windowEnd(st.windowStart, def.window ?? 'none'),
    reason,
    replayed: false,
    ...extra,
  };
}

function usageHandlers(): RouteDef[] {
  const base = '/v1/grants/:grantType/:id';
  return [
    {
      method: 'POST',
      pattern: `${base}/consume`,
      handler: (c) => {
        const e = c.engine;
        const grant = resolveGrant(e, c.params.grantType ?? '', c.params.id);
        sweepLeases(e);
        const name = String(need(c.body, 'counter'));
        const key = String(need(c.body, 'idempotency_key'));
        const def = grant.constraints?.counters?.[name];
        if (!def) throw new EmulatorError('VALIDATION_FAILED', `This grant defines no counter named ${name}.`, 'counter');
        const s = usageOf(e);
        const recKey = `${grant.id}|${name}|${key}`;
        const seen = s.consumes.get(recKey);
        if (seen) return { body: { ...seen.decision, replayed: true } };
        let amount = typeof c.body.amount === 'number' ? c.body.amount : 1;
        if (def.amount_field) {
          if (c.body.lease === true) throw new EmulatorError('VALIDATION_FAILED', 'A counter with amount_field cannot be leased.', 'lease');
          const v = c.body.context?.[def.amount_field];
          if (typeof v !== 'number' || !(v > 0)) throw new EmulatorError('VALIDATION_FAILED', `context.${def.amount_field} must be a positive number.`, 'context');
          amount = v;
        }
        if (!(amount > 0)) throw new EmulatorError('VALIDATION_FAILED', 'amount must be positive.', 'amount');
        const st = stateFor(e, grant, name, def);
        const machine = e.db.machines.get(grant.machine_id);
        const now = e.clock.now();
        let result: Obj;
        let taken = 0;
        if (grant.expires_at && grant.expires_at <= now) result = decision(e, grant, name, def, st, amount, false, 'grant_expired');
        else if (!machine || machine.deleted || machine.status === 'revoked') result = decision(e, grant, name, def, st, amount, false, 'grant_inactive');
        else if (st.used + amount > def.limit) result = decision(e, grant, name, def, st, amount, false, 'limit_reached');
        else {
          st.used += amount;
          taken = amount;
          let extra: Obj = {};
          if (c.body.lease === true) {
            const ttl = Math.min(typeof c.body.ttl_seconds === 'number' ? c.body.ttl_seconds : 60, 300) * 1000;
            const end = windowEnd(st.windowStart, def.window ?? 'none');
            const lease: Lease = { id: e.db.newId('ulse'), grantId: grant.id, counter: name, amount, expiresAt: Math.min(now + ttl, end ?? Infinity), status: 'active', windowStart: st.windowStart };
            s.leases.set(lease.id, lease);
            extra = { lease: { id: lease.id, amount, expires_at: lease.expiresAt } };
          }
          result = decision(e, grant, name, def, st, amount, true, null, extra);
          for (const pct of [80, 100]) {
            if (st.used * 100 >= def.limit * pct && !st.flags.has(pct)) {
              st.flags.add(pct);
              const data = { object: 'grant_usage_threshold', grant_type: c.params.grantType, grant_id: grant.id, machine_id: grant.machine_id, counter: name, threshold: pct, used: st.used, limit: def.limit, window: def.window ?? 'none', window_start: st.windowStart, resets_at: result.resets_at };
              e.webhooks.emit('grant.usage_threshold', data);
              if (pct === 100) e.webhooks.emit('grant.exhausted', data);
            }
          }
        }
        s.consumes.set(recKey, { decision: result, taken, refunded: 0, lease: c.body.lease === true, windowStart: st.windowStart });
        return { body: result };
      },
    },
    {
      method: 'POST',
      pattern: `${base}/refund`,
      handler: (c) => {
        const e = c.engine;
        const grant = resolveGrant(e, c.params.grantType ?? '', c.params.id);
        const name = String(need(c.body, 'counter'));
        const key = String(need(c.body, 'idempotency_key'));
        const orig = String(need(c.body, 'consume_idempotency_key'));
        const def = grant.constraints?.counters?.[name];
        if (!def) throw new EmulatorError('VALIDATION_FAILED', `This grant defines no counter named ${name}.`, 'counter');
        const s = usageOf(e);
        const refundKey = `${grant.id}|${name}|${key}`;
        const prior = s.refunds.get(refundKey);
        if (prior) return { body: { ...prior, replayed: true } };
        const st = stateFor(e, grant, name, def);
        const rec = s.consumes.get(`${grant.id}|${name}|${orig}`);
        const out = (refunded: boolean, amount: number, reason: string | null): Obj => ({ object: 'usage_refund', refunded, counter: name, amount, used: st.used, reason, replayed: false });
        let r: Obj;
        if (!rec || rec.taken === 0) r = out(false, 0, 'unknown_consume');
        else if (rec.lease) r = out(false, 0, 'not_refundable');
        else {
          const want = typeof c.body.amount === 'number' ? c.body.amount : rec.taken - rec.refunded;
          if (!(want > 0) || want > rec.taken - rec.refunded) r = out(false, 0, 'exceeds_consumed');
          else {
            rec.refunded += want;
            if (st.windowStart === rec.windowStart) st.used = Math.max(0, st.used - want);
            r = out(true, want, null);
          }
        }
        s.refunds.set(refundKey, r);
        return { body: r };
      },
    },
    {
      method: 'GET',
      pattern: `${base}/usage`,
      handler: (c) => {
        const e = c.engine;
        const grant = resolveGrant(e, c.params.grantType ?? '', c.params.id);
        sweepLeases(e);
        const defs: Obj = grant.constraints?.counters ?? {};
        const machine = e.db.machines.get(grant.machine_id);
        return {
          body: {
            object: 'grant_usage',
            grant_type: c.params.grantType,
            grant_id: grant.id,
            machine_id: grant.machine_id,
            live: !(grant.expires_at && grant.expires_at <= e.clock.now()) && machine?.status !== 'revoked',
            counters: Object.entries(defs).map(([name, def]) => {
              const st = stateFor(e, grant, name, def);
              return { counter: name, limit: def.limit, window: def.window ?? 'none', amount_field: def.amount_field ?? null, window_start: st.windowStart, resets_at: windowEnd(st.windowStart, def.window ?? 'none'), used: st.used, remaining: Math.max(0, def.limit - st.used) };
            }),
            leases: [...usageOf(e).leases.values()].filter((l) => l.grantId === grant.id && l.status === 'active').map((l) => ({ id: l.id, counter: l.counter, amount: l.amount, expires_at: l.expiresAt })),
          },
        };
      },
    },
    {
      method: 'POST',
      pattern: `${base}/leases/:leaseId/release`,
      handler: (c) => {
        const e = c.engine;
        const grant = resolveGrant(e, c.params.grantType ?? '', c.params.id);
        sweepLeases(e);
        const l = usageOf(e).leases.get(c.params.leaseId ?? '');
        if (!l || l.grantId !== grant.id) throw notFound('Lease');
        let returned = 0;
        let consumed = Math.min(typeof c.body.consumed === 'number' ? c.body.consumed : 0, l.amount);
        if (l.status === 'active') {
          returned = l.amount - consumed;
          l.status = 'released';
          const st = usageOf(e).counters.get(`${grant.id}|${l.counter}`);
          if (st && st.windowStart === l.windowStart) st.used = Math.max(0, st.used - returned);
        } else consumed = l.status === 'released' ? l.amount : 0;
        return { body: { object: 'usage_lease', id: l.id, counter: l.counter, amount: l.amount, consumed, returned, status: l.status, expires_at: l.expiresAt } };
      },
    },
  ];
}

// ── machines and grants ────────────────────────────────────────────────

export function machinesHandlers(): RouteDef[] {
  const mEvent = (e: Engine, type: string, m: Obj, op: 'create' | 'update' | 'delete') =>
    e.changed({ type, data: presentMachine(e, m), resource: 'machine', id: m.id, op });
  const gEvent = (e: Engine, type: string, g: Obj, op: 'create' | 'update' | 'delete') =>
    e.changed({ type, data: presentGrant(e, g), resource: 'machine_grant', id: g.id, op });

  const stampExpiry = (e: Engine, body: Obj): number | null | undefined => {
    if (body.expires_at === null) return null;
    if (typeof body.expires_at === 'number') return body.expires_at;
    if (typeof body.expires_in_seconds === 'number') return e.clock.now() + body.expires_in_seconds * 1000;
    return undefined;
  };
  const checkCounters = (constraints: Obj | null | undefined): void => {
    const counters = constraints?.counters;
    if (counters === undefined) return;
    const names = Object.keys(counters ?? {});
    if (!names.length || names.length > 10) throw new EmulatorError('VALIDATION_FAILED', 'constraints.counters needs 1 to 10 counters.', 'constraints.counters');
    for (const n of names) {
      const d = counters[n];
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(n)) throw new EmulatorError('VALIDATION_FAILED', `Counter name ${n} is not valid.`, 'constraints.counters');
      if (!d || typeof d.limit !== 'number' || !(d.limit > 0)) throw new EmulatorError('VALIDATION_FAILED', `Counter ${n} needs a positive limit.`, `constraints.counters.${n}.limit`);
      if (d.window !== undefined && !['none', 'minute', 'hour', 'day', 'month'].includes(d.window)) throw new EmulatorError('VALIDATION_FAILED', `Counter ${n} has an unknown window.`, `constraints.counters.${n}.window`);
    }
  };

  return [
    { method: 'GET', pattern: '/v1/machines', handler: (c) => listReply(c, c.engine.db.machines.filter((m) => !m.deleted), (m) => presentMachine(c.engine, m)) },
    {
      method: 'POST',
      pattern: '/v1/machines',
      handler: (c) => {
        const e = c.engine;
        const name = String(need(c.body, 'name'));
        if (c.body.owner_user_id && !e.db.users.get(c.body.owner_user_id)) throw new EmulatorError('NOT_FOUND', 'owner_user_id is not a user.', 'owner_user_id');
        const now = e.clock.now();
        const secret = e.tokens.secret('mk');
        const m = e.db.machines.insert({ name, owner_user_id: c.body.owner_user_id ?? null, organization_id: null, status: 'active', metadata: c.body.data ?? {}, secret, created_at: now, updated_at: now });
        mEvent(e, 'machine.enrolled', m, 'create');
        return { status: 201, body: { ...presentMachine(e, m), secret } };
      },
    },
    { method: 'GET', pattern: '/v1/machines/:id', handler: (c) => ({ body: presentMachine(c.engine, liveMachine(c.engine, c.params.id)) }) },
    {
      method: 'PATCH',
      pattern: '/v1/machines/:id',
      handler: (c) => {
        const e = c.engine;
        const m = liveMachine(e, c.params.id);
        if (typeof c.body.name === 'string') m.name = c.body.name;
        bump(e, m);
        mEvent(e, 'machine.updated', m, 'update');
        return { body: presentMachine(e, m) };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/machines/:id',
      handler: (c) => {
        const e = c.engine;
        const m = liveMachine(e, c.params.id);
        m.deleted = true;
        e.changed({ type: 'machine.revoked', data: { object: 'machine', id: m.id, deleted: true }, resource: 'machine', id: m.id, op: 'delete' });
        return { body: { object: 'machine', id: m.id, deleted: true } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/machines/:id/revoke',
      handler: (c) => {
        const e = c.engine;
        const m = liveMachine(e, c.params.id);
        m.status = 'revoked';
        bump(e, m);
        mEvent(e, 'machine.revoked', m, 'update');
        return { body: presentMachine(e, m) };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/machines/:id/approve',
      handler: (c) => {
        const e = c.engine;
        const m = liveMachine(e, c.params.id);
        m.status = 'active';
        bump(e, m);
        mEvent(e, 'machine.updated', m, 'update');
        return { body: presentMachine(e, m) };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/machines/:id/rotate_secret',
      handler: (c) => {
        const e = c.engine;
        const m = liveMachine(e, c.params.id);
        m.secret = e.tokens.secret('mk');
        bump(e, m);
        return { body: { ...presentMachine(e, m), secret: m.secret } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/m2m_tokens/verify',
      handler: (c) => {
        const e = c.engine;
        const secret = String(c.body.secret ?? c.body.token ?? '');
        const m = e.db.machines.find((x) => !x.deleted && x.secret === secret);
        if (!m || m.status === 'revoked') return { body: { object: 'm2m_token_verification', valid: false } };
        return { body: { object: 'm2m_token_verification', valid: true, machine_id: m.id, name: m.name } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/machines/:id/grants',
      handler: (c) => {
        const m = liveMachine(c.engine, c.params.id);
        return listReply(c, c.engine.db.grants.filter((g) => g.machine_id === m.id), (g) => presentGrant(c.engine, g));
      },
    },
    {
      method: 'POST',
      pattern: '/v1/machines/:id/grants',
      handler: (c) => {
        const e = c.engine;
        const m = liveMachine(e, c.params.id);
        const rs = String(need(c.body, 'resource_server_id'));
        checkCounters(c.body.constraints);
        const now = e.clock.now();
        const live = e.db.grants.find((g) => g.machine_id === m.id && g.resource_server_id === rs && !(g.expires_at && g.expires_at <= now));
        if (live) throw new EmulatorError('IDENTIFIER_EXISTS', 'This machine already has a live grant for that resource server. Delete it first, or wait for it to expire.');
        const expiresAt = stampExpiry(e, c.body);
        const g = e.db.grants.insert({ machine_id: m.id, resource_server_id: rs, scopes: c.body.scopes ?? [], constraints: c.body.constraints ?? null, expires_at: expiresAt ?? null, created_at: now, updated_at: now });
        gEvent(e, 'machine_grant.created', g, 'create');
        return { status: 201, body: presentGrant(e, g) };
      },
    },
    {
      method: 'PATCH',
      pattern: '/v1/machines/:id/grants/:grantId',
      handler: (c) => {
        const e = c.engine;
        const m = liveMachine(e, c.params.id);
        const g = e.db.grants.get(c.params.grantId);
        if (!g || g.machine_id !== m.id) throw notFound('Grant');
        if (g.expires_at && g.expires_at <= e.clock.now()) throw new EmulatorError('IDENTIFIER_EXISTS', 'That grant has expired.');
        const fields = ['scopes', 'constraints', 'expires_at', 'expires_in_seconds'].filter((k) => k in c.body);
        if (!fields.length) throw new EmulatorError('VALIDATION_FAILED', 'Send at least one field to change.');
        if ('constraints' in c.body) {
          checkCounters(c.body.constraints);
          g.constraints = c.body.constraints;
        }
        if ('scopes' in c.body) g.scopes = c.body.scopes;
        if ('expires_at' in c.body || 'expires_in_seconds' in c.body) g.expires_at = stampExpiry(e, c.body) ?? null;
        bump(e, g);
        gEvent(e, 'machine_grant.updated', g, 'update');
        return { body: presentGrant(e, g) };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/machines/:id/grants/:grantId',
      handler: (c) => {
        const e = c.engine;
        const m = liveMachine(e, c.params.id);
        const g = e.db.grants.get(c.params.grantId);
        if (!g || g.machine_id !== m.id) throw notFound('Grant');
        e.db.grants.delete(g.id);
        e.changed({ type: 'machine_grant.revoked', data: { object: 'machine_grant', id: g.id, machine_id: m.id }, resource: 'machine_grant', id: g.id, op: 'delete' });
        return { body: { object: 'machine_grant', id: g.id, deleted: true } };
      },
    },
    ...usageHandlers(),
  ];
}

