import type { EntitlementOverrideSubjectType, Entitlements } from './client/entitlement-overrides';

/**
 * Gate a feature on your own API from a plan the subject holds.
 *
 * Two ways, and they answer different questions:
 *
 * - {@link hasFeature} reads the verified token: `fea` is the feature list as of the moment the session
 *   token was minted. No network, no staleness control: a plan change shows up when the token refreshes.
 * - {@link createEntitlementCache} asks Atlas (`GET /v1/entitlements`) and keeps the answer for a short TTL, so a
 *   hot route pays one call per subject per TTL instead of one per request, and a revoked plan stops
 *   gating within the TTL rather than the token's life. {@link requireFeature} builds a request gate on it.
 *
 * Import from `@atlasauth/backend/entitlements`. A gate never fails open: when Atlas cannot be reached and no
 * usable cached answer exists, the call rejects and the caller decides (the framework adapters answer 5xx).
 */

/** The slice of the management client the cache needs. */
export interface EntitlementsReader {
  entitlements: { get(params: { subject_type: EntitlementOverrideSubjectType; subject_id: string }): Promise<Entitlements> };
}

export interface EntitlementSubject {
  type: EntitlementOverrideSubjectType;
  id: string;
}

/** Verified claims as the gate reads them. Anything missing simply grants nothing. */
export interface FeatureClaims {
  sub?: string;
  org_id?: string;
  /** Feature keys granted when the token was minted. */
  fea?: readonly string[] | null;
  [claim: string]: unknown;
}

/** True when the verified token carries the feature. Token snapshot only: see the module note. */
export function hasFeature(claims: FeatureClaims | null | undefined, feature: string): boolean {
  return Array.isArray(claims?.fea) && (claims!.fea as readonly string[]).includes(feature);
}

export interface EntitlementCacheOptions {
  client: EntitlementsReader;
  /** How long an answer is served without asking again. Default 60, at most 3600. */
  ttlSeconds?: number;
  /** After the TTL, keep serving the last answer for this many seconds when Atlas cannot be reached. Default 0 (reject). */
  staleIfErrorSeconds?: number;
  /** Most subjects held at once; the oldest is dropped first. Default 10000. */
  maxEntries?: number;
  /** Injectable clock (epoch ms). */
  now?: () => number;
}

export interface EntitlementCache {
  /** The subject's entitlements, from the cache or Atlas. */
  get(subject: EntitlementSubject): Promise<Entitlements>;
  /** Whether the subject is entitled to the feature right now (within the TTL). */
  has(subject: EntitlementSubject, feature: string): Promise<boolean>;
  /** The numeric limit for a feature, or null when it has none (or the subject is not entitled). */
  limit(subject: EntitlementSubject, feature: string): Promise<number | null>;
  /** Drop one subject (call it from your `entitlement.*` / `billing_subscription.*` webhook handler) so the next read is fresh. */
  invalidate(subject: EntitlementSubject): void;
  /** Drop everything. */
  clear(): void;
}

interface Entry {
  doc: Entitlements;
  freshUntil: number;
  staleUntil: number;
}

const keyOf = (s: EntitlementSubject) => `${s.type}:${s.id}`;

export function createEntitlementCache(opts: EntitlementCacheOptions): EntitlementCache {
  const ttl = Math.min(3600, Math.max(0, opts.ttlSeconds ?? 60)) * 1000;
  const stale = Math.max(0, opts.staleIfErrorSeconds ?? 0) * 1000;
  const max = Math.max(1, Math.floor(opts.maxEntries ?? 10_000));
  const now = opts.now ?? (() => Date.now());
  const entries = new Map<string, Entry>();
  /** One read per subject at a time: concurrent callers share it. */
  const inflight = new Map<string, Promise<Entitlements>>();

  async function load(subject: EntitlementSubject, key: string): Promise<Entitlements> {
    try {
      const doc = await opts.client.entitlements.get({ subject_type: subject.type, subject_id: subject.id });
      entries.delete(key);
      entries.set(key, { doc, freshUntil: now() + ttl, staleUntil: now() + ttl + stale });
      while (entries.size > max) entries.delete(entries.keys().next().value as string);
      return doc;
    } catch (err) {
      const held = entries.get(key);
      if (held && now() < held.staleUntil) return held.doc;
      throw err;
    }
  }

  const get = (subject: EntitlementSubject): Promise<Entitlements> => {
    const key = keyOf(subject);
    const held = entries.get(key);
    if (held && now() < held.freshUntil) return Promise.resolve(held.doc);
    let p = inflight.get(key);
    if (!p) {
      p = load(subject, key).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return p;
  };

  return {
    get,
    async has(subject, feature) {
      return (await get(subject)).entitlements.some((e) => e.key === feature && e.enabled);
    },
    async limit(subject, feature) {
      const item = (await get(subject)).entitlements.find((e) => e.key === feature && e.enabled);
      return typeof item?.limit === 'number' ? item.limit : null;
    },
    invalidate(subject) {
      entries.delete(keyOf(subject));
    },
    clear() {
      entries.clear();
    },
  };
}

export interface FeatureRequest {
  claims: FeatureClaims | null | undefined;
  headers?: Record<string, string | string[] | undefined> | { get(name: string): string | null };
}

export type FeatureOutcome =
  | { allowed: true }
  | { allowed: false; status: 401 | 403; body: { error: { code: string; message: string; feature: string } }; headers: Record<string, string> };

export interface RequireFeatureOptions {
  cache: EntitlementCache;
  feature: string;
  /**
   * Whose plan gates the route. `auto` (default): the active organization when the token has one, else the user.
   * A function picks it per request; return null when there is no subject (answered 401).
   */
  subject?: 'auto' | 'user' | 'org' | ((req: FeatureRequest) => EntitlementSubject | null | undefined);
}

function subjectOf(req: FeatureRequest, mode: NonNullable<RequireFeatureOptions['subject']>): EntitlementSubject | null {
  if (typeof mode === 'function') return mode(req) ?? null;
  const c = req.claims;
  if (mode !== 'user' && typeof c?.org_id === 'string' && c.org_id) return { type: 'org', id: c.org_id };
  if (mode !== 'org' && typeof c?.sub === 'string' && c.sub) return { type: 'user', id: c.sub };
  return null;
}

/**
 * A request gate: 401 without a subject, 403 `feature_not_entitled` when the subject's plan does not include the
 * feature, else `{ allowed: true }`. Reads through the cache, so it is as fresh as the TTL. Rejects when Atlas
 * cannot be reached and there is nothing usable cached.
 */
export function requireFeature(opts: RequireFeatureOptions): (req: FeatureRequest) => Promise<FeatureOutcome> {
  const mode = opts.subject ?? 'auto';
  return async (req) => {
    const subject = subjectOf(req, mode);
    if (!subject) {
      return { allowed: false, status: 401, headers: {}, body: { error: { code: 'unauthenticated', message: 'Sign in to use this feature.', feature: opts.feature } } };
    }
    if (await opts.cache.has(subject, opts.feature)) return { allowed: true };
    return {
      allowed: false,
      status: 403,
      headers: {},
      body: { error: { code: 'feature_not_entitled', message: 'Your plan does not include this feature.', feature: opts.feature } },
    };
  };
}
