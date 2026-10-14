import { DEFAULT_TTL_MS, REFETCH_INTERVAL_MS } from './jwks-cache';

/**
 * OIDC discovery of an instance's JWKS URL, so `new AtlasBackend({ issuer })`
 * works without a `jwksUrl`.
 *
 * Where the document lives:
 *   - an instance with its own frontend API host (every instance created from
 *     the dashboard): `${issuer}/.well-known/openid-configuration`;
 *   - an instance on the SHARED host: its tokens carry the shared issuer, and the
 *     shared host's root discovery document describes a different instance's key
 *     set. Such an instance must name itself (`instanceId`, or a `publishableKey`
 *     it is derived from) so discovery uses the per-instance document at
 *     `${issuer}/instances/${instanceId}/.well-known/openid-configuration`.
 *
 * Caching mirrors the JWKS cache: the discovered URL is reused for the JWKS TTL
 * (an hour), a failed refresh keeps serving the last good URL, and a failing
 * endpoint is retried at most once a minute — so a broken or hostile discovery
 * endpoint cannot turn verification traffic into outbound request floods.
 */

export class DiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryError';
  }
}

export interface JwksDiscoveryDeps {
  /** The `iss` tokens carry. The discovery document's `issuer` must equal it. */
  issuer: string;
  /** Per-instance discovery for shared-host instances. */
  instanceId?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  refetchIntervalMs?: number;
}

const stripSlash = (value: string) => value.replace(/\/+$/, '');

/** The instance id inside a publishable key (`pk_live_ins_…` / `pk_test_ins_…`), if it has one. */
export function instanceIdFromPublishableKey(publishableKey: string): string | undefined {
  const match = /^pk_(?:live|test)_(ins_[A-Za-z0-9]+)$/.exec(publishableKey.trim());
  return match?.[1];
}

/** The discovery document URL for an issuer (and optional instance id). */
export function discoveryUrlFor(issuer: string, instanceId?: string): string {
  const base = stripSlash(issuer);
  return instanceId
    ? `${base}/instances/${encodeURIComponent(instanceId)}/.well-known/openid-configuration`
    : `${base}/.well-known/openid-configuration`;
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export class JwksDiscovery {
  readonly url: string;
  private cachedUri: string | null = null;
  private fetchedAt = 0;
  private lastAttemptAt = 0;
  private lastError: DiscoveryError | null = null;
  private inflight: Promise<string> | null = null;

  constructor(private readonly deps: JwksDiscoveryDeps) {
    this.url = discoveryUrlFor(deps.issuer, deps.instanceId);
  }

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The JWKS URL, from cache when fresh. Throws {@link DiscoveryError} when none can be had. */
  async jwksUri(): Promise<string> {
    const now = this.now;
    const ttl = this.deps.ttlMs ?? DEFAULT_TTL_MS;
    const interval = this.deps.refetchIntervalMs ?? REFETCH_INTERVAL_MS;

    if (this.cachedUri && now - this.fetchedAt < ttl) return this.cachedUri;
    // Throttle: inside the retry window, answer from what we have (or the last error).
    if (this.lastAttemptAt && now - this.lastAttemptAt < interval) {
      if (this.cachedUri) return this.cachedUri;
      if (this.lastError) throw this.lastError;
    }
    if (this.inflight) return this.inflight;

    this.lastAttemptAt = now;
    this.inflight = this.fetchUri()
      .then((uri) => {
        this.cachedUri = uri;
        this.fetchedAt = now;
        this.lastError = null;
        return uri;
      })
      .catch((error: unknown) => {
        this.lastError =
          error instanceof DiscoveryError
            ? error
            : new DiscoveryError(`OIDC discovery at ${this.url} failed: ${(error as Error)?.message ?? String(error)}`);
        // Keep serving the last good URL through a discovery outage.
        if (this.cachedUri) return this.cachedUri;
        throw this.lastError;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async fetchUri(): Promise<string> {
    const fail = (why: string) =>
      new DiscoveryError(
        `OIDC discovery at ${this.url} failed: ${why}. Pass \`jwksUrl\` explicitly` +
          (this.deps.instanceId
            ? '.'
            : ', or — for an instance without its own frontend API domain — pass `instanceId` (or `publishableKey`).'),
      );

    const response = await (this.deps.fetchImpl ?? fetch)(this.url, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw fail(`HTTP ${response.status}`);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw fail('the response is not JSON');
    }
    const doc = body as { issuer?: unknown; jwks_uri?: unknown } | null;
    if (!doc || typeof doc !== 'object') throw fail('the response is not a discovery document');

    // OIDC Discovery §4.3: the document's issuer MUST match the issuer it was
    // fetched for — otherwise its keys belong to someone else.
    if (typeof doc.issuer !== 'string' || stripSlash(doc.issuer) !== stripSlash(this.deps.issuer)) {
      throw fail(`its issuer (${String(doc.issuer)}) does not match the configured issuer (${this.deps.issuer})`);
    }
    if (typeof doc.jwks_uri !== 'string') throw fail('it has no jwks_uri');
    let jwks: URL;
    try {
      jwks = new URL(doc.jwks_uri);
    } catch {
      throw fail('its jwks_uri is not an absolute URL');
    }
    if (jwks.protocol !== 'https:' && !(jwks.protocol === 'http:' && isLoopback(jwks.hostname))) {
      throw fail('its jwks_uri is not https');
    }
    return jwks.toString();
  }
}
