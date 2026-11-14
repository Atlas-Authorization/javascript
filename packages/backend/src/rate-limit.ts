/**
 * Rate limiter for your own API, enforced locally. Atlas defines the policies
 * (per API key, user, organization, machine or IP); this module counts requests
 * in your process or your Redis and answers allowed or denied without a round
 * trip to Atlas.
 *
 * The algorithm is a FIXED WINDOW: a counter per subject and policy that resets
 * when its window ends. A caller can therefore spend up to twice the limit across
 * a window boundary (the end of one window and the start of the next). Use `burst`
 * and a shorter window if that matters.
 *
 * Import from `@atlasauth/backend/rate-limit`.
 */

export type RateLimitSubjectKind = 'key' | 'user' | 'org' | 'machine' | 'ip';

/** Who is calling. Provide every identity you know; each policy matches its own kind. */
export interface RateLimitSubject {
  keyId?: string;
  userId?: string;
  orgId?: string;
  machineId?: string;
  ip?: string;
}

export interface RateLimitPolicy {
  name: string;
  subject: RateLimitSubjectKind;
  /** Requests allowed per window. */
  limit: number;
  windowSeconds: number;
  /** Extra requests allowed on top of `limit` within a window. */
  burst?: number;
  /** false skips a static policy. Default true. */
  enabled?: boolean;
  /** Policy version from Atlas; a newer version replaces a cached one at once. */
  version?: number | string;
}

export interface RateLimitResult {
  allowed: boolean;
  /** The limit of the policy that decided (the tightest remaining one when several apply). */
  limit: number;
  remaining: number;
  /** Milliseconds until the deciding window resets. */
  resetMs: number;
  /** Name of the deciding policy; null when no policy applied (then `allowed` is true). */
  policy: string | null;
  /** Window of the deciding policy in seconds (0 when no policy applied). */
  windowSeconds: number;
}

export interface RateLimitStore {
  /**
   * Add `cost` to the counter at `key`, creating it with a TTL of `windowMs` when
   * it does not exist. Atomic. Returns the count after adding and the ms left in the window.
   */
  incr(key: string, cost: number, windowMs: number): Promise<{ count: number; ttlMs: number }>;
}

/** The part of an ioredis-style client the Redis store needs: `eval(script, numKeys, ...keysAndArgs)`. */
export interface RedisEvalClient {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

// One round trip: INCRBY, set the expiry only when the key was just created
// (or lost its TTL), and return the count with the remaining TTL.
export const RATE_LIMIT_LUA = `
local c = redis.call('INCRBY', KEYS[1], ARGV[1])
local t = redis.call('PTTL', KEYS[1])
if t < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  t = tonumber(ARGV[2])
end
return {c, t}
`;

export function createRedisRateLimitStore(client: RedisEvalClient): RateLimitStore {
  return {
    async incr(key, cost, windowMs) {
      const raw = (await client.eval(RATE_LIMIT_LUA, 1, key, cost, windowMs)) as unknown;
      if (!Array.isArray(raw) || raw.length < 2) throw new Error('rate-limit: unexpected redis reply');
      return { count: Number(raw[0]), ttlMs: Number(raw[1]) };
    },
  };
}

/** Single-process store. Counts are lost on restart and not shared between processes. */
export function createMemoryRateLimitStore(now: () => number = Date.now): RateLimitStore {
  const map = new Map<string, { count: number; expiresAt: number }>();
  let lastSweep = now();
  return {
    async incr(key, cost, windowMs) {
      const t = now();
      if (t - lastSweep > 60_000) {
        lastSweep = t;
        for (const [k, v] of map) if (v.expiresAt <= t) map.delete(k);
      }
      let e = map.get(key);
      if (!e || e.expiresAt <= t) {
        e = { count: 0, expiresAt: t + windowMs };
        map.set(key, e);
      }
      e.count += cost;
      return { count: e.count, ttlMs: e.expiresAt - t };
    },
  };
}

/** What `GET /v1/rate_limit_policies/resolve` and an API key verify answer carry; both spellings are read. */
export interface ResolvedPolicyPayload {
  name?: string;
  policy?: string | { name?: string };
  limit?: number;
  max?: number;
  window_seconds?: number;
  burst?: number | null;
  version?: number | string;
  rate_limit?: { max?: number; limit?: number; window_seconds?: number; burst?: number | null; name?: string; policy_name?: string | null; version?: number | string } | null;
}

/** Structural client: anything with the resolve call (the Atlas client's rate-limit resource). */
export interface RateLimitPolicyClient {
  rateLimitPolicies: {
    resolve(query: { key_id?: string; user_id?: string; org_id?: string; machine_id?: string }): Promise<ResolvedPolicyPayload>;
  };
}

export type StoreErrorMode = 'open' | 'closed';

export interface CreateRateLimiterOptions {
  /** Fetches the policy that applies to a key, user, org or machine. Optional when `policies` is enough. */
  client?: RateLimitPolicyClient;
  /** Static policies, used for IPs and as the fallback when the client has nothing for a subject. */
  policies?: RateLimitPolicy[];
  /** 'memory' (default), 'redis' with `redis`, or your own store. */
  store?: 'memory' | 'redis' | RateLimitStore;
  redis?: RedisEvalClient;
  /**
   * What to do when the store throws. 'open' (default) allows the request, 'closed' denies it.
   * A function is called with the error and may return either; returning nothing keeps 'open'.
   */
  onStoreError?: StoreErrorMode | ((err: unknown, subject: RateLimitSubject) => StoreErrorMode | void);
  /** How long a fetched policy is trusted before it is fetched again. Default 60000. */
  policyTtlMs?: number;
  /** Redis key prefix. Default `atlas:rl:`. */
  keyPrefix?: string;
  now?: () => number;
}

export interface RateLimiter {
  check(input: { subject: RateLimitSubject; cost?: number }): Promise<RateLimitResult>;
}

const KIND_ORDER: Array<[RateLimitSubjectKind, keyof RateLimitSubject]> = [
  ['key', 'keyId'],
  ['machine', 'machineId'],
  ['user', 'userId'],
  ['org', 'orgId'],
  ['ip', 'ip'],
];

const QUERY_FIELD: Record<Exclude<RateLimitSubjectKind, 'ip'>, 'key_id' | 'machine_id' | 'user_id' | 'org_id'> = {
  key: 'key_id',
  machine: 'machine_id',
  user: 'user_id',
  org: 'org_id',
};

function toPolicy(kind: RateLimitSubjectKind, p: ResolvedPolicyPayload): RateLimitPolicy | null {
  const rl = p.rate_limit ?? p;
  const limit = rl.limit ?? rl.max ?? p.limit ?? p.max;
  const windowSeconds = rl.window_seconds ?? p.window_seconds;
  if (!(typeof limit === 'number' && limit >= 0) || !(typeof windowSeconds === 'number' && windowSeconds > 0)) return null;
  const rawName = p.name ?? (typeof p.policy === 'string' ? p.policy : p.policy?.name) ?? (rl as { name?: string }).name ?? p.rate_limit?.policy_name ?? undefined;
  return {
    name: rawName ?? `atlas-${kind}`,
    subject: kind,
    limit,
    windowSeconds,
    burst: rl.burst ?? p.burst ?? undefined,
    version: rl.version ?? p.version,
  };
}

export function createRateLimiter(options: CreateRateLimiterOptions = {}): RateLimiter {
  const now = options.now ?? Date.now;
  let store: RateLimitStore;
  if (options.store && typeof options.store === 'object') store = options.store;
  else if (options.store === 'redis') {
    if (!options.redis) throw new Error("rate-limit: store 'redis' needs a `redis` client with eval()");
    store = createRedisRateLimitStore(options.redis);
  } else store = createMemoryRateLimitStore(now);
  const prefix = options.keyPrefix ?? 'atlas:rl:';
  const ttl = options.policyTtlMs ?? 60_000;
  const statics = options.policies ?? [];
  const cache = new Map<string, { policy: RateLimitPolicy | null; fetchedAt: number }>();
  const inflight = new Map<string, Promise<RateLimitPolicy | null>>();

  async function policyFor(kind: RateLimitSubjectKind, id: string): Promise<RateLimitPolicy | null> {
    const fallback = statics.find((p) => p.subject === kind && p.enabled !== false) ?? null;
    if (!options.client || kind === 'ip') return fallback;
    const ck = `${kind}:${id}`;
    const hit = cache.get(ck);
    if (hit && now() - hit.fetchedAt < ttl) return hit.policy ?? fallback;
    let p = inflight.get(ck);
    if (!p) {
      p = options.client.rateLimitPolicies
        .resolve({ [QUERY_FIELD[kind]]: id })
        .then((r) => toPolicy(kind, r))
        .finally(() => inflight.delete(ck));
      inflight.set(ck, p);
    }
    try {
      const fresh = await p;
      cache.set(ck, { policy: fresh, fetchedAt: now() });
      if (cache.size > 10_000) cache.delete(cache.keys().next().value as string);
      return fresh ?? fallback;
    } catch {
      // Atlas unreachable: keep enforcing the last policy we saw rather than none.
      return hit?.policy ?? fallback;
    }
  }

  function storeErrorMode(err: unknown, subject: RateLimitSubject): StoreErrorMode {
    const h = options.onStoreError;
    if (typeof h === 'function') return h(err, subject) ?? 'open';
    return h ?? 'open';
  }

  return {
    async check({ subject, cost = 1 }) {
      if (!(Number.isFinite(cost) && cost > 0)) throw new RangeError('rate-limit: cost must be a positive number');
      let tightest: RateLimitResult | null = null;
      for (const [kind, field] of KIND_ORDER) {
        const id = subject[field];
        if (!id) continue;
        const policy = await policyFor(kind, id);
        if (!policy || policy.limit < 0 || !(policy.windowSeconds > 0)) continue;
        const max = policy.limit + (policy.burst ?? 0);
        const windowMs = Math.round(policy.windowSeconds * 1000);
        // Version in the key: a changed policy starts a fresh counter instead of inheriting a stale one.
        const key = `${prefix}${policy.name}:${policy.version ?? 0}:${kind}:${id}`;
        let count: number;
        let ttlMs: number;
        try {
          ({ count, ttlMs } = await store.incr(key, cost, windowMs));
        } catch (err) {
          if (storeErrorMode(err, subject) === 'closed') {
            return { allowed: false, limit: policy.limit, remaining: 0, resetMs: windowMs, policy: policy.name, windowSeconds: policy.windowSeconds };
          }
          continue;
        }
        const remaining = Math.max(0, max - count);
        const result: RateLimitResult = {
          allowed: count <= max,
          limit: policy.limit,
          remaining,
          resetMs: Math.max(0, ttlMs),
          policy: policy.name,
          windowSeconds: policy.windowSeconds,
        };
        // A denial wins immediately (later policies are not charged); otherwise keep the tightest.
        if (!result.allowed) return result;
        if (!tightest || result.remaining < tightest.remaining) tightest = result;
      }
      return tightest ?? { allowed: true, limit: 0, remaining: 0, resetMs: 0, policy: null, windowSeconds: 0 };
    },
  };
}

export type RateLimitDecision =
  | { allowed: true; headers: Record<string, string> }
  | { allowed: false; status: 429; headers: Record<string, string>; body: { error: { code: 'rate_limited'; message: string; retry_after_ms: number } } };

/**
 * Framework-neutral wrapper. `subjectFrom` reads the identities off your request
 * (verified claims, API key verification, client IP). Sends the IETF RateLimit
 * headers on every counted request and Retry-After on a 429. When no policy
 * applied, `headers` is empty.
 */
export function rateLimitRequest<Req>(
  limiter: RateLimiter,
  subjectFrom: (req: Req) => RateLimitSubject | { subject: RateLimitSubject; cost?: number } | Promise<RateLimitSubject | { subject: RateLimitSubject; cost?: number }>,
): (req: Req) => Promise<RateLimitDecision> {
  return async (req) => {
    const s = await subjectFrom(req);
    const input = 'subject' in s && typeof (s as { subject: unknown }).subject === 'object' ? (s as { subject: RateLimitSubject; cost?: number }) : { subject: s as RateLimitSubject };
    const r = await limiter.check(input);
    const resetSec = String(Math.ceil(r.resetMs / 1000));
    const headers: Record<string, string> = r.policy
      ? {
          'RateLimit-Limit': String(r.limit),
          'RateLimit-Remaining': String(r.remaining),
          'RateLimit-Reset': resetSec,
          'RateLimit-Policy': `${r.limit};w=${r.windowSeconds}`,
        }
      : {};
    if (r.allowed) return { allowed: true, headers };
    headers['Retry-After'] = String(Math.max(1, Math.ceil(r.resetMs / 1000)));
    return {
      allowed: false,
      status: 429,
      headers,
      body: { error: { code: 'rate_limited', message: 'Rate limit exceeded', retry_after_ms: r.resetMs } },
    };
  };
}
