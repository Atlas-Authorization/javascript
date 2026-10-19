import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { JwksCache, readKid, type Jwks } from './jwks-cache';
import { JwksDiscovery, instanceIdFromPublishableKey } from './discovery';

/**
 * OpenID Connect Back-Channel Logout 1.0 — verifying the `logout_token` Atlas
 * POSTs to your `backchannel_logout_uri` when a user's session ends.
 *
 * The checks are those of §2.6 of the spec: RS256 signature from the issuer's
 * JWKS, `iss`, `aud` containing your client id, `iat` present (and not in the
 * future), `exp` when present, a `jti`, the back-channel-logout event, a `sid`
 * and/or `sub`, NO `nonce`, and a `typ` of `logout+jwt` when the header has one.
 */

/** The event a logout_token carries (and an id_token never does). */
export const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

/** Seconds of clock skew tolerated on `iat` / `exp`. */
export const LOGOUT_TOKEN_CLOCK_SKEW_SECONDS = 5;

/** Default maximum age of a logout_token (`iat`), in seconds. Atlas mints them with a 2-minute life. */
export const LOGOUT_TOKEN_MAX_AGE_SECONDS = 300;

/** What a verified logout_token tells you: whose session(s) to end. */
export interface LogoutTokenClaims {
  /** The user whose sessions end. At least one of `sub` / `sid` is present. */
  sub?: string;
  /** The session that ended — the same `sid` your id_token for it carried. */
  sid?: string;
  /** Unique token id; remember it to refuse a replay. */
  jti: string;
  /** Issued-at, epoch seconds. */
  iat: number;
}

export type LogoutTokenResult =
  | { ok: true; claims: LogoutTokenClaims }
  | {
      ok: false;
      /**
       * `malformed`: not a JWT. `no_keys`: the issuer's keys could not be loaded.
       * `invalid`: a check failed (`detail` says which). `replayed`: the `jti`
       * was already seen by the replay store.
       */
      reason: 'malformed' | 'no_keys' | 'invalid' | 'replayed';
      detail?: string;
      /**
       * True when the failure is on YOUR side and temporary (`no_keys`: the
       * issuer's keys could not be fetched, e.g. a network error or a JWKS
       * outage). Answer `503` with `Retry-After` so Atlas retries the delivery.
       * False for a token that is itself bad: answer `400`, which Atlas never
       * retries.
       */
      retryable: boolean;
    };

/**
 * Remembers logout_token `jti`s so a captured token cannot be replayed. Return
 * `true` the first time a jti is seen, `false` when it was seen before. Back it
 * with a shared store (Redis `SET NX PX`, a DB unique key) when you run more
 * than one server process.
 */
export interface LogoutReplayStore {
  remember(jti: string, expiresAtMs: number): boolean | Promise<boolean>;
}

/** An in-process {@link LogoutReplayStore}; entries expire after the token's max age. */
export function memoryLogoutReplayStore(now: () => number = Date.now): LogoutReplayStore {
  const seen = new Map<string, number>();
  return {
    remember(jti, expiresAtMs) {
      const t = now();
      for (const [k, exp] of seen) if (exp <= t) seen.delete(k);
      if (seen.has(jti)) return false;
      seen.set(jti, expiresAtMs);
      return true;
    },
  };
}

export interface LogoutTokenVerifierOptions {
  /** Expected `iss`: your instance's issuer, or `https://atlasauth.net` for Sign in with Atlas apps. */
  issuer: string;
  /** Your client id (the `aud` the token must contain). One string or several accepted values. */
  clientId: string | readonly string[];
  /** The issuer's JWKS URL. Optional: discovered from the issuer when omitted. */
  jwksUrl?: string;
  /** A static key set, for offline verification (tests). Exclusive with `jwksUrl`. */
  jwks?: Jwks;
  /** For discovery on the shared host: the instance id (`ins_...`). */
  instanceId?: string;
  /** Alternative to `instanceId`: read it from the publishable key. */
  publishableKey?: string;
  /** Reject tokens whose `iat` is older than this many seconds. Default 300. */
  maxAgeSeconds?: number;
  /** Optional replay protection by `jti`. */
  replayStore?: LogoutReplayStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Per-call settings for checking a logout_token against already-loaded keys. */
export interface LogoutTokenCheckOptions {
  issuer: string;
  clientId: string | readonly string[];
  maxAgeSeconds?: number;
  replayStore?: LogoutReplayStore;
  now?: () => number;
}

/**
 * Verifies logout_tokens. Create one and reuse it: it caches the issuer's keys
 * (refetching at most once a minute on an unknown `kid`).
 */
export class LogoutTokenVerifier {
  private readonly cache: JwksCache;

  constructor(private readonly options: LogoutTokenVerifierOptions) {
    if (typeof options.issuer !== 'string' || !options.issuer) {
      throw new Error('LogoutTokenVerifier needs `issuer`.');
    }
    const ids = typeof options.clientId === 'string' ? [options.clientId] : options.clientId;
    if (!ids || ids.length === 0 || ids.some((c) => !c)) {
      throw new Error('LogoutTokenVerifier needs `clientId` (the audience your logout tokens carry).');
    }
    if (options.jwksUrl && options.jwks) {
      throw new Error('LogoutTokenVerifier takes `jwksUrl` OR `jwks`, not both.');
    }
    let discovery: JwksDiscovery | undefined;
    if (!options.jwksUrl && !options.jwks) {
      const instanceId =
        options.instanceId ??
        (options.publishableKey ? instanceIdFromPublishableKey(options.publishableKey) : undefined);
      discovery = new JwksDiscovery({
        issuer: options.issuer,
        instanceId,
        fetchImpl: options.fetchImpl,
        now: options.now,
      });
    }
    this.cache = new JwksCache({
      url: options.jwksUrl,
      staticJwks: options.jwks,
      resolveUrl: discovery ? () => discovery.jwksUri() : undefined,
      fetchImpl: options.fetchImpl,
      now: options.now,
    });
  }

  /** Verify a logout_token (the `logout_token` form field of the POST). */
  async verify(token: string): Promise<LogoutTokenResult> {
    return checkLogoutToken(token, this.cache, this.options);
  }
}

/**
 * One-off verification. Prefer a long-lived {@link LogoutTokenVerifier} on a
 * server, so the issuer's keys are cached between requests.
 */
export function verifyLogoutToken(
  token: string,
  options: LogoutTokenVerifierOptions,
): Promise<LogoutTokenResult> {
  return new LogoutTokenVerifier(options).verify(token);
}

/** Shared by {@link LogoutTokenVerifier} and `AtlasBackend.verifyLogoutToken`. */
export async function checkLogoutToken(
  token: string,
  cache: JwksCache,
  options: LogoutTokenCheckOptions,
): Promise<LogoutTokenResult> {
  if (typeof token !== 'string' || token.split('.').length !== 3) {
    return { ok: false, reason: 'malformed', retryable: false };
  }

  let header: { typ?: unknown };
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return { ok: false, reason: 'malformed', retryable: false };
  }
  if (header.typ !== undefined) {
    const typ = String(header.typ).toLowerCase();
    if (typ !== 'logout+jwt' && typ !== 'application/logout+jwt') {
      return { ok: false, reason: 'invalid', detail: 'typ is not logout+jwt', retryable: false };
    }
  }

  const kid = readKid(token);
  const keys = await cache.get(kid);
  // No keys at all, or a key Atlas has just rotated to that could not be fetched
  // because the refetch failed: both are temporary, on the receiver's side.
  const missingAfterFailedFetch =
    kid !== undefined && cache.lastOutcome === 'failed' && !keys?.keys.some((k) => k.kid === kid);
  if (!keys || keys.keys.length === 0 || missingAfterFailedFetch) {
    return cache.lastError
      ? { ok: false, reason: 'no_keys', detail: cache.lastError, retryable: true }
      : { ok: false, reason: 'no_keys', retryable: true };
  }

  const nowMs = options.now ? options.now() : Date.now();
  const audience =
    typeof options.clientId === 'string' ? options.clientId : [...options.clientId];
  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(token, createLocalJWKSet(keys as never), {
      algorithms: ['RS256'],
      issuer: options.issuer,
      audience,
      clockTolerance: LOGOUT_TOKEN_CLOCK_SKEW_SECONDS,
      currentDate: new Date(nowMs),
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (error) {
    const code = (error as { code?: string }).code;
    return {
      ok: false,
      reason: 'invalid',
      retryable: false,
      detail:
        code === 'ERR_JWT_EXPIRED'
          ? 'expired'
          : code === 'ERR_JWT_CLAIM_VALIDATION_FAILED'
            ? `claim check failed: ${(error as { claim?: string }).claim ?? 'unknown'}`
            : 'signature or format check failed',
    };
  }

  const nowSec = Math.floor(nowMs / 1000);
  const iat = payload.iat;
  if (typeof iat !== 'number') return { ok: false, reason: 'invalid', detail: 'iat missing', retryable: false };
  if (iat > nowSec + LOGOUT_TOKEN_CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'invalid', detail: 'iat is in the future', retryable: false };
  }
  const maxAge = options.maxAgeSeconds ?? LOGOUT_TOKEN_MAX_AGE_SECONDS;
  if (nowSec - iat > maxAge + LOGOUT_TOKEN_CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'invalid', detail: 'iat is too old', retryable: false };
  }
  const jti = payload.jti;
  if (typeof jti !== 'string' || !jti) return { ok: false, reason: 'invalid', detail: 'jti missing', retryable: false };

  const events = payload.events;
  const event =
    events && typeof events === 'object' && !Array.isArray(events)
      ? (events as Record<string, unknown>)[BACKCHANNEL_LOGOUT_EVENT]
      : undefined;
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return { ok: false, reason: 'invalid', detail: 'back-channel logout event missing', retryable: false };
  }
  if ('nonce' in payload) {
    return { ok: false, reason: 'invalid', detail: 'nonce must not be present', retryable: false };
  }
  const sub = typeof payload.sub === 'string' && payload.sub ? payload.sub : undefined;
  const sid = typeof payload.sid === 'string' && payload.sid ? payload.sid : undefined;
  if (!sub && !sid) return { ok: false, reason: 'invalid', detail: 'neither sid nor sub present', retryable: false };

  if (options.replayStore) {
    const expiresAtMs = (iat + maxAge + LOGOUT_TOKEN_CLOCK_SKEW_SECONDS) * 1000;
    const fresh = await options.replayStore.remember(jti, expiresAtMs);
    if (!fresh) return { ok: false, reason: 'replayed', retryable: false };
  }

  const claims: LogoutTokenClaims = { jti, iat };
  if (sub) claims.sub = sub;
  if (sid) claims.sid = sid;
  return { ok: true, claims };
}
