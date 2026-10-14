/**
 * §7.3: "JWKS cached in-process with kid-miss refetch (max 1/min) so key
 * rotation needs no deploys."
 *
 * The rate limit on the refetch is the security property, not a politeness.
 * Without it, an attacker sends tokens carrying random `kid` values and every
 * one forces an outbound request to the customer's JWKS endpoint — turning any
 * unauthenticated caller into a traffic amplifier aimed at Atlas, from inside
 * the customer's own infrastructure. The cache's job is as much to refuse to
 * fetch as it is to fetch.
 *
 * The other half of the requirement is that rotation needs no deploy. A key
 * that rotated an hour ago must be picked up automatically, which is exactly
 * what the kid-miss path does — but only for a kid the cache has genuinely not
 * seen, and only once a minute.
 */

/** §7.3: at most one refetch per minute, however many misses arrive. */
export const REFETCH_INTERVAL_MS = 60_000;

/** §7.3 serves `Cache-Control: max-age=3600`; honoured rather than ignored. */
export const DEFAULT_TTL_MS = 3_600_000;

export interface Jwks {
  keys: Array<{ kid?: string; [claim: string]: unknown }>;
}

export interface JwksCacheDeps {
  /** The instance's JWKS URL. Optional only when `staticJwks` is supplied. */
  url?: string;
  /**
   * A fixed, in-memory key set. When present the cache serves it directly and
   * NEVER calls `fetch` — the offline path a customer's CI uses to verify
   * Atlas-minted test tokens (§1.3c). Mutually exclusive with `url` in practice;
   * when both are given the static set wins and no network call is ever made.
   */
  staticJwks?: Jwks;
  /**
   * Resolve the JWKS URL lazily (OIDC discovery) when no fixed `url` is given.
   * Called on each fetch attempt; it does its own caching. A rejection is
   * recorded as {@link JwksCache.lastError} and treated like a failed fetch.
   */
  resolveUrl?: () => Promise<string>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  refetchIntervalMs?: number;
}

export type FetchOutcome = 'fresh' | 'cached' | 'refetched' | 'throttled' | 'failed';

export class JwksCache {
  private cached: Jwks | null = null;
  private fetchedAt = 0;
  private lastAttemptAt = 0;
  /** Exposed so a caller can assert the rate limit actually bit. */
  lastOutcome: FetchOutcome = 'fresh';
  /** Why the last attempt produced no keys (e.g. a discovery failure), for diagnostics. */
  lastError: string | null = null;

  constructor(private readonly deps: JwksCacheDeps) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private has(kid: string | undefined): boolean {
    if (!this.cached) return false;
    if (!kid) return this.cached.keys.length > 0;
    return this.cached.keys.some((key) => key.kid === kid);
  }

  /**
   * The JWKS to verify against, refetching if this `kid` is unknown.
   *
   * Returns whatever is cached when a refetch is throttled or fails. That is
   * deliberate: a stale JWKS still verifies every token signed by a key it
   * contains, so degrading to "the keys I already had" keeps the overwhelming
   * majority of requests working through a JWKS outage. Only tokens signed by a
   * brand-new key fail, and those are a minute old at most.
   */
  async get(kid?: string): Promise<Jwks | null> {
    /**
     * The static path. When a fixed key set was supplied there is nothing to
     * fetch, refetch or throttle: the keys never rotate for the life of the
     * process, so every `get` — hit or `kid` miss — is answered from the set
     * with no outbound request. This is what makes verification hermetic.
     */
    if (this.deps.staticJwks) {
      this.lastOutcome = 'cached';
      return this.deps.staticJwks;
    }

    if (this.deps.url === undefined && this.deps.resolveUrl === undefined) {
      // Neither a URL nor a static set: nothing to verify against. Report
      // "no keys" rather than attempting `fetch(undefined)`.
      this.lastOutcome = 'failed';
      return null;
    }

    const now = this.now;
    const ttl = this.deps.ttlMs ?? DEFAULT_TTL_MS;
    const interval = this.deps.refetchIntervalMs ?? REFETCH_INTERVAL_MS;

    const expired = !this.cached || now - this.fetchedAt >= ttl;
    const kidMiss = Boolean(this.cached) && !this.has(kid);

    if (!expired && !kidMiss) {
      this.lastOutcome = 'cached';
      return this.cached;
    }

    /**
     * The throttle. An attacker sending random kids must not be able to make
     * this process hammer the JWKS endpoint — so a miss inside the window is
     * answered from cache, and the token simply fails to verify.
     */
    if (kidMiss && !expired && now - this.lastAttemptAt < interval) {
      this.lastOutcome = 'throttled';
      return this.cached;
    }

    this.lastAttemptAt = now;

    let url: string;
    if (this.deps.url !== undefined) {
      url = this.deps.url;
    } else {
      try {
        url = await this.deps.resolveUrl!();
      } catch (error) {
        this.lastOutcome = 'failed';
        this.lastError = error instanceof Error ? error.message : String(error);
        return this.cached;
      }
    }

    try {
      const response = await (this.deps.fetchImpl ?? fetch)(url, {
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`JWKS fetch failed (${response.status})`);

      const body = (await response.json()) as Jwks;
      if (!body || !Array.isArray(body.keys)) throw new Error('JWKS is malformed');

      this.cached = body;
      this.fetchedAt = now;
      this.lastError = null;
      this.lastOutcome = kidMiss ? 'refetched' : 'fresh';
      return this.cached;
    } catch (error) {
      // Keep serving what we have. A JWKS outage should degrade to "new keys
      // do not work yet", not "nobody can authenticate".
      this.lastOutcome = 'failed';
      this.lastError = `JWKS fetch from ${url} failed: ${error instanceof Error ? error.message : String(error)}`;
      return this.cached;
    }
  }

  /** Test and diagnostic surface — never used for a security decision. */
  snapshot() {
    return { keys: this.cached?.keys.length ?? 0, fetchedAt: this.fetchedAt };
  }
}

/** Read the `kid` from a JWT header without verifying anything. */
export function readKid(jwt: string): string | undefined {
  const [header] = jwt.split('.');
  if (!header) return undefined;
  try {
    const decoded = JSON.parse(
      Buffer.from(header.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    ) as { kid?: string };
    return typeof decoded.kid === 'string' ? decoded.kid : undefined;
  } catch {
    return undefined;
  }
}
