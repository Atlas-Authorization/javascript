import type { ConsumeBody, GrantType, RefundBody, UsageDecision, UsageLease, UsageRefund } from './client/grant-usage';

/**
 * Usage gate: spend a grant's named counters (`constraints.counters`) from your own API or agent,
 * without a network round trip per call when you do not need one.
 *
 * Two modes. `remote` (default): every `consume` is one atomic call to Atlas. `lease`: the gate
 * reserves a block of `leaseSize` from the counter, spends it locally and returns the unspent part
 * when the lease is handed back, so a hot path pays one call per block. A leased amount counts as
 * spent on the server until released or expired, so size the block to what you can afford to strand.
 * Counters whose amount comes from the request (`amount_field`) are never leased.
 *
 * `check` is a free local pre-check from the token claims. It only ever DENIES (an expired token, a
 * counter the grant does not define, or a usage hint that already shows the counter used up); a pass
 * is never an authorization. The decision that counts is always `consume`.
 */

/** The slice of the management client the gate needs. */
export interface UsageGateClient {
  grantUsage: {
    consume(type: GrantType, id: string, body: ConsumeBody): Promise<UsageDecision>;
    refund(type: GrantType, id: string, body: RefundBody): Promise<UsageRefund>;
    releaseLease(type: GrantType, id: string, leaseId: string, body?: { consumed?: number }): Promise<UsageLease>;
  };
}

/** The token claims the local check reads. Anything missing simply cannot deny. */
export interface UsageClaims {
  /** Epoch seconds. */
  exp?: number;
  /** The grant's constraints as minted into the token. */
  constraints?: { counters?: Record<string, unknown> } & Record<string, unknown>;
  /** Optional usage hint: `{ counter: { used, limit, resets_at? } }` as of mint time. */
  cnt?: Record<string, { used: number; limit: number; resets_at?: number | null }>;
  grant_id?: string;
  grant_type?: GrantType;
  [claim: string]: unknown;
}

export type LocalVerdict =
  | { ok: true }
  | { ok: false; reason: 'no_grant' | 'expired' | 'unknown_counter' | 'exhausted' };

export interface LeaseState {
  grantType: GrantType;
  grantId: string;
  counter: string;
  leaseId: string;
  size: number;
  remaining: number;
  /** Epoch ms, from the server. */
  expiresAt: number;
}

/** Where open leases live. Synchronous on purpose: a lease spend must be atomic in one process. */
export interface UsageGateStore {
  get(key: string): LeaseState | undefined;
  set(key: string, lease: LeaseState): void;
  delete(key: string): void;
  values(): LeaseState[];
}

export function memoryUsageGateStore(): UsageGateStore {
  const m = new Map<string, LeaseState>();
  return { get: (k) => m.get(k), set: (k, v) => void m.set(k, v), delete: (k) => void m.delete(k), values: () => [...m.values()] };
}

export interface GateConsumeInput {
  grantType: GrantType;
  grantId: string;
  counter: string;
  /** Default 1. Leave out for a counter with `amount_field` and pass the value in `context`. */
  amount?: number;
  /** Required. A retry with the same key never spends twice. */
  idempotencyKey: string;
  context?: Record<string, unknown>;
}

export interface ConsumeResult {
  allowed: boolean;
  reason: UsageDecision['reason'];
  counter: string;
  amount: number;
  /** Remaining in the window (remote) or in the local lease (lease). Null when unknown. */
  remaining: number | null;
  /** Epoch ms the window ends, when known. */
  resetsAt: number | null;
  source: 'remote' | 'lease';
  /** True when this is the stored answer to an earlier call with the same key. */
  replayed: boolean;
}

export interface GateRefundInput {
  grantType: GrantType;
  grantId: string;
  counter: string;
  amount?: number;
  /** Idempotency key of this refund. */
  idempotencyKey: string;
  /** Idempotency key of the consume to reverse. */
  consumeIdempotencyKey: string;
}

export interface UsageGateOptions {
  client: UsageGateClient;
  store?: UsageGateStore;
  mode?: 'remote' | 'lease';
  /** Lease mode: how much to reserve per block. Default 10. */
  leaseSize?: number;
  /** Lease mode: lease time to live requested from Atlas (1 to 300). Default 60. */
  leaseTtlSeconds?: number;
  /** Hand a lease back this long before it expires, so a spent block is never counted twice. Default 2000 ms. */
  leaseSafetyMs?: number;
  /** Injectable clock (epoch ms). */
  now?: () => number;
}

export interface UsageGate {
  check(claims: UsageClaims | null | undefined, opts: { counter: string; amount?: number }): LocalVerdict;
  consume(input: GateConsumeInput): Promise<ConsumeResult>;
  refund(input: GateRefundInput): Promise<{ refunded: boolean; reason: UsageRefund['reason'] | 'lease_released'; source: 'remote' | 'lease' }>;
  /** Hand every open lease back with what was spent. Call on shutdown. */
  close(): Promise<void>;
}

const leaseKey = (t: GrantType, id: string, c: string) => `${t}:${id}:${c}`;

export function createUsageGate(options: UsageGateOptions): UsageGate {
  const { client } = options;
  const store = options.store ?? memoryUsageGateStore();
  const mode = options.mode ?? 'remote';
  const leaseSize = Math.max(1, Math.floor(options.leaseSize ?? 10));
  const ttl = Math.min(300, Math.max(1, Math.floor(options.leaseTtlSeconds ?? 60)));
  const safety = options.leaseSafetyMs ?? 2000;
  const now = options.now ?? (() => Date.now());

  /** Counters the server refused to lease (amount_field): always remote from then on. */
  const noLease = new Set<string>();
  /** In-flight lease acquisitions, so two callers never reserve two blocks at once. */
  const acquiring = new Map<string, Promise<LeaseState | null>>();
  /** idempotencyKey -> the stored local result, so a retry within a lease replays instead of spending twice. */
  const localDecisions = new Map<string, { result: ConsumeResult; lease: string; leaseKey: string }>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  async function release(key: string): Promise<void> {
    const lease = store.get(key);
    if (!lease) return;
    store.delete(key);
    const t = timers.get(key);
    if (t) clearTimeout(t);
    timers.delete(key);
    try {
      await client.grantUsage.releaseLease(lease.grantType, lease.grantId, lease.leaseId, { consumed: lease.size - lease.remaining });
    } catch {
      // An expired or already-settled lease: the server has settled it; nothing more to do.
    }
  }

  async function acquire(input: GateConsumeInput, key: string): Promise<LeaseState | null> {
    const live = store.get(key);
    if (live && live.expiresAt - safety > now()) return live;
    if (live) await release(key);
    const pending = acquiring.get(key);
    if (pending) return pending;
    const p = (async (): Promise<LeaseState | null> => {
      let d: UsageDecision;
      try {
        d = await client.grantUsage.consume(input.grantType, input.grantId, {
          counter: input.counter,
          amount: leaseSize,
          idempotency_key: `${input.idempotencyKey}:lease`,
          lease: true,
          ttl_seconds: ttl,
        });
      } catch (e) {
        const status = (e as { status?: number }).status;
        if (status === 400 || status === 422) noLease.add(key); // amount_field counter or lease refused
        return null;
      }
      if (!d.allowed || !d.lease) return null; // too little left for a whole block: caller spends remotely
      const lease: LeaseState = {
        grantType: input.grantType,
        grantId: input.grantId,
        counter: input.counter,
        leaseId: d.lease.id,
        size: d.lease.amount,
        remaining: d.lease.amount,
        expiresAt: d.lease.expires_at,
      };
      store.set(key, lease);
      const delay = Math.max(0, lease.expiresAt - safety - now());
      const timer = setTimeout(() => void release(key), delay);
      (timer as { unref?: () => void }).unref?.();
      timers.set(key, timer);
      return lease;
    })().finally(() => acquiring.delete(key));
    acquiring.set(key, p);
    return p;
  }

  const fromDecision = (d: UsageDecision): ConsumeResult => ({
    allowed: d.allowed,
    reason: d.reason,
    counter: d.counter,
    amount: d.amount,
    remaining: d.remaining,
    resetsAt: d.resets_at,
    source: 'remote',
    replayed: !!d.replayed,
  });

  return {
    check(claims, { counter, amount = 1 }) {
      if (!claims || typeof claims !== 'object' || !claims.constraints) return { ok: false, reason: 'no_grant' };
      if (typeof claims.exp === 'number' && claims.exp * 1000 <= now()) return { ok: false, reason: 'expired' };
      const counters = claims.constraints.counters;
      if (!counters || typeof counters !== 'object' || !(counter in counters)) return { ok: false, reason: 'unknown_counter' };
      const hint = claims.cnt?.[counter];
      if (hint && hint.used + amount > hint.limit && (hint.resets_at == null || hint.resets_at > now())) {
        return { ok: false, reason: 'exhausted' };
      }
      return { ok: true };
    },

    async consume(input) {
      const amount = input.amount ?? 1;
      const key = leaseKey(input.grantType, input.grantId, input.counter);
      const remote = async () =>
        fromDecision(
          await client.grantUsage.consume(input.grantType, input.grantId, {
            counter: input.counter,
            ...(input.amount === undefined ? {} : { amount: input.amount }),
            idempotency_key: input.idempotencyKey,
            ...(input.context ? { context: input.context } : {}),
          }),
        );
      // Never lease when the request carries the amount (amount_field), the amount is not a plain number, or the server refused before.
      if (mode !== 'lease' || input.context || noLease.has(key) || !Number.isInteger(amount) || amount < 1 || amount > leaseSize) {
        return remote();
      }
      const prior = localDecisions.get(input.idempotencyKey);
      if (prior && prior.leaseKey === key) return { ...prior.result, replayed: true };
      const lease = await acquire(input, key);
      if (!lease || lease.remaining < amount) return remote();
      lease.remaining -= amount;
      store.set(key, lease);
      const result: ConsumeResult = {
        allowed: true,
        reason: null,
        counter: input.counter,
        amount,
        remaining: lease.remaining,
        resetsAt: null,
        source: 'lease',
        replayed: false,
      };
      localDecisions.set(input.idempotencyKey, { result, lease: lease.leaseId, leaseKey: key });
      if (localDecisions.size > 10_000) localDecisions.delete(localDecisions.keys().next().value as string);
      return result;
    },

    async refund(input) {
      const local = localDecisions.get(input.consumeIdempotencyKey);
      if (local) {
        // A leased consume is not refundable on the server; give it back to the local block if that block is still open.
        const lease = store.get(local.leaseKey);
        if (!lease || lease.leaseId !== local.lease) return { refunded: false, reason: 'lease_released', source: 'lease' };
        const amount = Math.min(input.amount ?? local.result.amount, local.result.amount);
        lease.remaining = Math.min(lease.size, lease.remaining + amount);
        store.set(local.leaseKey, lease);
        localDecisions.delete(input.consumeIdempotencyKey);
        return { refunded: true, reason: null, source: 'lease' };
      }
      const r = await client.grantUsage.refund(input.grantType, input.grantId, {
        counter: input.counter,
        ...(input.amount === undefined ? {} : { amount: input.amount }),
        idempotency_key: input.idempotencyKey,
        consume_idempotency_key: input.consumeIdempotencyKey,
      });
      return { refunded: r.refunded, reason: r.reason, source: 'remote' };
    },

    async close() {
      await Promise.allSettled(store.values().map((l) => release(leaseKey(l.grantType, l.grantId, l.counter))));
    },
  };
}

// ── Framework-neutral request gate ────────────────────────────────────────────

export interface GrantUsageRequest {
  claims: UsageClaims | null | undefined;
  headers: Record<string, string | string[] | undefined> | { get(name: string): string | null };
}

export type GrantUsageOutcome =
  | { allowed: true; result: ConsumeResult }
  | { allowed: false; status: 429 | 403; body: { error: { code: string; message: string } }; headers: Record<string, string> };

export interface RequireGrantUsageOptions {
  gate: UsageGate;
  counter: string;
  /** Fixed amount, or computed from the request. Default 1. */
  amount?: number | ((req: GrantUsageRequest) => number);
  /** Which grant to spend. Default: `grant_type` (machine) and `grant_id` claims. */
  grantFrom?: (req: GrantUsageRequest) => { grantType: GrantType; grantId: string } | null | undefined;
  /** Default: the `Idempotency-Key` header, else a fresh random key (no retry protection). */
  idempotencyKey?: (req: GrantUsageRequest) => string | undefined;
  context?: (req: GrantUsageRequest) => Record<string, unknown> | undefined;
  now?: () => number;
}

function header(req: GrantUsageRequest, name: string): string | undefined {
  const h = req.headers as { get?: (n: string) => string | null } & Record<string, string | string[] | undefined>;
  if (typeof h.get === 'function') return h.get(name) ?? undefined;
  const v = h[name] ?? h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Spend one request against a grant counter. Returns `{ allowed: true }` to continue, or the status,
 * body and headers to answer with: 429 (with `Retry-After`) when the counter is used up, 403 when the
 * grant is missing, expired or inactive. A failure to reach Atlas rejects (the caller decides, there is no silent allow).
 */
export function requireGrantUsage(opts: RequireGrantUsageOptions): (req: GrantUsageRequest) => Promise<GrantUsageOutcome> {
  const now = opts.now ?? (() => Date.now());
  const deny = (status: 429 | 403, code: string, message: string, headers: Record<string, string> = {}): GrantUsageOutcome => ({
    allowed: false,
    status,
    body: { error: { code, message } },
    headers,
  });
  return async (req) => {
    const amount = typeof opts.amount === 'function' ? opts.amount(req) : opts.amount;
    const context = opts.context?.(req);
    const local = opts.gate.check(req.claims, { counter: opts.counter, amount: amount ?? 1 });
    if (!local.ok) {
      return local.reason === 'exhausted'
        ? deny(429, 'usage_limit_reached', 'This grant has used up its allowance.')
        : deny(403, `grant_${local.reason}`, 'This token does not carry a usable grant for this action.');
    }
    const g = opts.grantFrom?.(req) ?? (req.claims?.grant_id ? { grantType: req.claims.grant_type ?? 'machine', grantId: req.claims.grant_id } : null);
    if (!g) return deny(403, 'grant_missing', 'No grant could be identified for this request.');
    const result = await opts.gate.consume({
      grantType: g.grantType,
      grantId: g.grantId,
      counter: opts.counter,
      // A counter whose amount comes from the request (amount_field) takes none here: pass it in context.
      ...(amount === undefined ? {} : { amount }),
      idempotencyKey: opts.idempotencyKey?.(req) ?? header(req, 'idempotency-key') ?? globalThis.crypto.randomUUID(),
      context,
    });
    if (result.allowed) return { allowed: true, result };
    if (result.reason === 'limit_reached') {
      const headers: Record<string, string> = {};
      if (result.resetsAt) headers['Retry-After'] = String(Math.max(1, Math.ceil((result.resetsAt - now()) / 1000)));
      return deny(429, 'usage_limit_reached', 'This grant has used up its allowance.', headers);
    }
    return deny(403, result.reason === 'grant_expired' ? 'grant_expired' : 'grant_inactive', 'This grant no longer authorizes this action.');
  };
}
