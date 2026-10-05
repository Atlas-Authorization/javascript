import { createLocalJWKSet, jwtVerify } from 'jose';
import {
  ForbiddenError,
  evaluate,
  hasFromClaims,
  type ProtectCondition,
} from '@atlasauth/authz';
import { JwksCache, readKid, type Jwks } from './jwks-cache';

// Re-export the shared authorization primitive so a backend customer imports
// `has`, `protect`, `ProtectCondition`, etc. from `@atlasauth/backend` directly —
// the same contract `@atlasauth/react` and `@atlasauth/nextjs` evaluate.
export {
  type AuthzClaims,
  type ProtectCondition,
  type ProtectOutcome,
  type ProtectReason,
  evaluate,
  hasFromClaims,
  protectFromClaims,
  ForbiddenError,
  isRoleKey,
  isPermissionKey,
} from '@atlasauth/authz';

/**
 * §7.3 verification by customer backends.
 *
 * "verifies signature, exp/nbf with 5 s clock-skew tolerance, iss, and
 * optionally azp against an allowlist."
 *
 * The design constraint that matters is what this does NOT do: it never calls
 * Atlas on the hot path. A customer's API handling ten thousand requests a
 * second cannot make ten thousand outbound calls to verify them, and a verifier
 * that did would make Atlas's availability the customer's availability. So the
 * default path is local, against cached JWKS, and the revocation window is
 * bounded instead by the 60-second token lifetime.
 *
 * `verifyOnline` exists for the cases where 60 seconds is too long, and is
 * documented as the slow path so nobody reaches for it by default.
 */

/** §7.3: five seconds either side, matching the server's minting tolerance. */
export const CLOCK_SKEW_SECONDS = 5;

export interface SessionClaims {
  iss: string;
  sub: string;
  sid: string;
  exp: number;
  nbf?: number;
  iat?: number;
  /**
   * §S4 audience — the instance this token is FOR (the stable instance id by
   * default, or the value pinned via `authConfig.session.audience`). Verified
   * only when `AtlasBackend` is configured with an expected `audience`.
   */
  aud?: string | string[];
  azp?: string;
  sv?: number;
  mfa?: boolean;
  org_id?: string;
  org_slug?: string;
  org_role?: string;
  org_permissions?: string[];
  /** §billing entitlement — active plan slug; gate with `has({ plan })`. */
  pla?: string;
  /** §billing entitlement — granted feature keys; gate with `has({ feature })`. */
  fea?: string[];
  /**
   * §impersonation — RFC 8693 actor claim. Present ONLY on an impersonation
   * session (the dashboard "impersonate" action, or a redeemed actor token); its
   * `sub` is the operator acting AS this user. Absent on an ordinary session.
   * Informational, never an authorization input — the operator's privilege was
   * proven when the token was minted — so read it to render the mandatory
   * "viewing as X" banner and to tag audit entries as impersonated, not to
   * grant access.
   */
  act?: { sub: string };
  /**
   * §migration R3 — the subject's primary verified email. Present ONLY when the
   * instance opted in (`session.includeEmailClaim`); absent otherwise. Lets an
   * integrator provision a first-login user from the token alone, with no
   * `GET /v1/users/:sub` round-trip. It is a snapshot at mint time, not a live
   * lookup — treat it as identity, not as an always-current address.
   */
  email?: string;
  /**
   * §migration R3 — the subject's `external_id`, when set (e.g. a SCIM
   * `externalId` or an id carried over from a migration). Present only alongside
   * `email` under the same opt-in, and only when the user carries one.
   */
  external_id?: string;
  [claim: string]: unknown;
}

/**
 * A verified session, carrying the ergonomic authorization helpers bound to its
 * claims — the server-side equivalent of Clerk's `auth()`. `has()` answers a
 * condition; `protect()` asserts one, throwing `ForbiddenError` (which the app
 * maps to 401/403). Both delegate to the shared `@atlasauth/authz` primitive, so a
 * check reads identically here, in the React `<Protect>`, and in Next.js.
 */
export interface AuthorizedSession {
  ok: true;
  claims: SessionClaims;
  /**
   * The impersonator when this is an impersonation session — the RFC 8693 `act`
   * claim (`{ sub }`), else null. The server-side parallel of Clerk's
   * `auth().actor`: branch on it to render the mandatory "viewing as X" banner
   * and to tag audit entries, without reaching into `claims` untyped.
   */
  actor: { sub: string } | null;
  /** True when the claims satisfy the condition (empty condition = "signed in"). */
  has(condition?: ProtectCondition): boolean;
  /** Assert the condition; returns the claims on success, throws ForbiddenError otherwise. */
  protect(condition?: ProtectCondition): SessionClaims;
}

export type VerifyResult =
  | AuthorizedSession
  | { ok: false; reason: 'malformed' | 'invalid' | 'no_keys' | 'unauthorized_party' };

/** Build the success result with `has`/`protect` bound to the verified claims. */
function authorized(claims: SessionClaims): AuthorizedSession {
  return {
    ok: true,
    claims,
    // Normalize to a typed `{ sub }` or null — never leak a malformed `act`
    // (e.g. `act` present but `sub` missing) through as a truthy actor.
    actor:
      claims.act && typeof claims.act.sub === 'string' && claims.act.sub
        ? { sub: claims.act.sub }
        : null,
    has: (condition = {}) => hasFromClaims(claims, condition),
    protect: (condition = {}) => {
      const outcome = evaluate(claims, condition);
      if (!outcome.allowed) throw new ForbiddenError(outcome.reason, condition);
      return claims;
    },
  };
}

export interface AtlasBackendOptions {
  /**
   * The instance's JWKS URL. Provide exactly one of `jwksUrl` or `jwks`: with a
   * URL, keys are fetched and cached (the production default); with a static
   * `jwks`, verification is fully offline.
   */
  jwksUrl?: string;
  /**
   * A static JSON Web Key Set to verify against, INSTEAD of fetching from a URL.
   * When set, verification makes NO network call — the hermetic path a
   * customer's CI uses to validate Atlas-minted test session JWTs (§1.3c). The
   * `@atlasauth/backend/testing` `createTestIssuer()` helper produces a matching
   * `{ jwks }`. Signature, issuer, `token_use` and `azp` checks are unchanged;
   * only where the keys come from differs. Mutually exclusive with `jwksUrl`.
   */
  jwks?: Jwks;
  /** Expected `iss`. Required — an unchecked issuer accepts any Atlas instance. */
  issuer: string;
  /**
   * §7.3 optional azp allowlist. When set, a token minted for a different
   * origin is refused, which is what stops a token issued to one of the
   * customer's apps being replayed against another.
   */
  authorizedParties?: readonly string[];
  /**
   * §S4 optional expected audience. When set, a verified token's `aud` MUST
   * contain this value (or one of these values), which is what stops a verifier
   * with a mis-set `issuer` — or a JWKS shared across instances — from accepting
   * a token minted for a DIFFERENT instance. Pass your instance id (the stable
   * `ins_…` embedded in your publishable key) here, which is what Atlas stamps
   * as `aud` by default; or the specific value your instance pins via
   * `authConfig.session.audience`. When UNSET, `aud` is not checked at all —
   * tokens that carry one still verify — so adopting this is strictly opt-in and
   * backwards compatible.
   */
  audience?: string | readonly string[];
  secretKey?: string;
  bapiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class AtlasBackend {
  private readonly jwks: JwksCache;

  constructor(private readonly options: AtlasBackendOptions) {
    // Exactly one key source. Two would be ambiguous (which wins?), and zero
    // leaves nothing to verify against — either is a configuration error worth
    // failing loudly on rather than silently accepting or rejecting every token.
    const hasUrl = typeof options.jwksUrl === 'string' && options.jwksUrl.length > 0;
    const hasStatic = options.jwks !== undefined;
    if (hasUrl === hasStatic) {
      throw new Error(
        'AtlasBackend needs exactly one key source: pass `jwksUrl` (fetch from the instance) OR `jwks` (a static key set for offline verification), not both and not neither.',
      );
    }

    this.jwks = new JwksCache({
      url: options.jwksUrl,
      staticJwks: options.jwks,
      fetchImpl: options.fetchImpl,
      now: options.now,
    });
  }

  /**
   * Verify locally. No network call unless the `kid` is unknown, and at most
   * one of those a minute.
   */
  async verify(token: string): Promise<VerifyResult> {
    if (!token || token.split('.').length !== 3) return { ok: false, reason: 'malformed' };

    const keys: Jwks | null = await this.jwks.get(readKid(token));
    if (!keys || keys.keys.length === 0) return { ok: false, reason: 'no_keys' };

    let claims: SessionClaims;
    try {
      const { payload } = await jwtVerify(token, createLocalJWKSet(keys as never), {
        // Pinned. Without this, a token whose header says `alg: none` — or any
        // algorithm the key material can be coerced into — verifies.
        algorithms: ['RS256'],
        issuer: this.options.issuer,
        // §S4 enforce `aud` ONLY when the caller configured an expected audience.
        // Unset leaves `aud` unchecked, so a token carrying its default
        // instance-id audience still verifies (backwards compatible).
        ...(this.options.audience !== undefined
          ? { audience: this.options.audience as string | string[] }
          : {}),
        clockTolerance: CLOCK_SKEW_SECONDS,
        currentDate: this.options.now ? new Date(this.options.now()) : undefined,
      });
      claims = payload as unknown as SessionClaims;
    } catch {
      /**
       * One reason for every failure. Telling a caller whether the signature,
       * the issuer or the expiry was wrong helps someone refining a forged
       * token far more than it helps a developer debug a real one.
       */
      return { ok: false, reason: 'invalid' };
    }

    /**
     * §13.1 token-confusion guard. An OP access token (`token_use:'access_token'`)
     * and an id_token (carries `aud`) are signed with the SAME per-instance RS256
     * key, issuer and `typ:'JWT'` header as a first-party session JWT. Reject any
     * token carrying an OP marker so a "Sign in with Atlas" RP cannot replay one
     * as a customer session. An ABSENT `token_use`/`aud` is a valid session
     * (backward-compat for tokens minted before the `token_use:'session'` marker),
     * so this never mass-invalidates a live fleet.
     */
    const tokenUse = (claims as { token_use?: unknown }).token_use;
    const isSessionMarked = tokenUse === 'session';
    // §S4: a first-party session token now carries `aud` (its instance id), so
    // `aud`-present no longer distinguishes an id_token. The positive
    // `token_use:'session'` marker is the discriminator: reject an OP access
    // token (token_use present, not 'session') and an id_token (carries `aud`
    // but NOT the marker); a legacy session token (neither) and a new session
    // token (aud + marker) both pass.
    if (tokenUse !== undefined && !isSessionMarked) {
      return { ok: false, reason: 'invalid' };
    }
    if (claims.aud !== undefined && !isSessionMarked) {
      return { ok: false, reason: 'invalid' };
    }

    if (this.options.authorizedParties?.length) {
      if (!claims.azp || !this.options.authorizedParties.includes(claims.azp)) {
        return { ok: false, reason: 'unauthorized_party' };
      }
    }

    // The single success-construction point — verifyOnline and
    // authenticateRequest both return this result, so the bound has()/protect()
    // ride along every verification path.
    return authorized(claims);
  }

  /**
   * §7.3 the documented slow path: ask Atlas whether the session is still live.
   *
   * Costs a round trip on every call, so it is for the handful of operations
   * where a 60-second revocation window is genuinely unacceptable — deleting an
   * account, moving money. Using it everywhere makes Atlas's availability the
   * customer's availability, which is the thing local verification exists to
   * avoid.
   */
  async verifyOnline(token: string): Promise<VerifyResult> {
    const local = await this.verify(token);
    if (!local.ok) return local;

    if (!this.options.secretKey || !this.options.bapiBaseUrl) {
      throw new Error(
        'verifyOnline needs secretKey and bapiBaseUrl. Without them it would silently fall back to local verification, which is the opposite of what the caller asked for.',
      );
    }

    try {
      const response = await (this.options.fetchImpl ?? fetch)(
        `${this.options.bapiBaseUrl}/v1/tokens/verify`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.options.secretKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ token }),
        },
      );

      if (!response.ok) return { ok: false, reason: 'invalid' };
      const body = (await response.json()) as { verified?: boolean };
      return body.verified ? local : { ok: false, reason: 'invalid' };
    } catch {
      /**
       * Fails CLOSED. The caller reached for verifyOnline precisely because a
       * stale answer was unacceptable, so returning the local result on an
       * outage would give them the thing they explicitly refused.
       */
      return { ok: false, reason: 'invalid' };
    }
  }

  /**
   * Verify whatever a request carries.
   *
   * §7.5: `__session` is readable by script for Authorization-header mode, so
   * both carriers are legitimate. The header wins, because a caller that set it
   * deliberately should not be overridden by a stale cookie.
   */
  async authenticateRequest(request: {
    headers: { get(name: string): string | null } | Record<string, string | undefined>;
  }): Promise<VerifyResult> {
    const header = readHeader(request.headers, 'authorization');
    const cookie = readHeader(request.headers, 'cookie');

    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const fromCookie = cookie ? readCookie(cookie, '__session') : undefined;

    const token = bearer ?? fromCookie;
    if (!token) return { ok: false, reason: 'malformed' };

    return this.verify(token);
  }

  /**
   * §migration — redirect forwarding.
   *
   * Build the URL your provider callback should 302 to when you KEPT your own,
   * already-registered provider callback (a connection's `custom_redirect_uri`)
   * instead of registering Atlas's `<fapi>/v1/oauth/callback/<provider>`. The
   * provider redirects to your callback with `?code&state`; you forward those to
   * Atlas, which holds the `client_secret`, completes the exchange and issues the
   * session. Your handler is then a one-liner:
   *
   *   res.redirect(302, atlas.oauthCallbackForwardUrl('github', req.url));
   *
   * The target is derived from the configured `issuer` (your instance's FAPI
   * host), so it's correct on the shared host and on a custom domain alike. Only
   * the OAuth callback params are carried across — there is no open-ended
   * passthrough of caller-controlled query into Atlas's callback — and `state`
   * (which Atlas minted and validates) rides along so the forward can't strip it.
   */
  oauthCallbackForwardUrl(
    provider: string,
    incoming: string | URLSearchParams | Record<string, string | string[] | undefined>,
  ): string {
    if (!/^[a-z0-9_]+$/i.test(provider)) {
      throw new Error(`Invalid provider key: ${JSON.stringify(provider)}`);
    }
    const src = toForwardParams(incoming);
    const out = new URLSearchParams();
    for (const key of ['code', 'state', 'error', 'error_description', 'error_uri', 'iss']) {
      const v = src.get(key);
      if (v != null && v !== '') out.set(key, v);
    }
    const base = this.options.issuer.replace(/\/+$/, '');
    const qs = out.toString();
    return `${base}/v1/oauth/callback/${provider}${qs ? `?${qs}` : ''}`;
  }
}

/**
 * Normalise whatever a framework hands a callback handler — Node's `req.url`
 * (path+query), a full URL, a bare query string, Express's `req.query` object, or
 * a `URLSearchParams` — into query params, so `oauthCallbackForwardUrl` accepts
 * them all.
 */
function toForwardParams(
  incoming: string | URLSearchParams | Record<string, string | string[] | undefined>,
): URLSearchParams {
  if (incoming instanceof URLSearchParams) return incoming;
  if (typeof incoming === 'object' && incoming !== null) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(incoming)) {
      if (Array.isArray(v)) {
        if (v[0] != null) p.set(k, String(v[0]));
      } else if (v != null) {
        p.set(k, String(v));
      }
    }
    return p;
  }
  const s = String(incoming);
  const qIdx = s.indexOf('?');
  if (qIdx >= 0) return new URLSearchParams(s.slice(qIdx + 1));
  // No '?': a bare query string ("code=…&state=…") vs a bare path ("/cb").
  return s.includes('=') ? new URLSearchParams(s) : new URLSearchParams();
}

function readHeader(
  headers: { get(name: string): string | null } | Record<string, string | undefined>,
  name: string,
): string | undefined {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get(name: string): string | null }).get(name) ?? undefined;
  }
  const record = headers as Record<string, string | undefined>;
  return record[name] ?? record[name.toLowerCase()];
}

function readCookie(header: string, name: string): string | undefined {
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

/**
 * §8.2 permission check, for gating a customer's own routes.
 *
 * Reads `org_permissions` off the token rather than calling Atlas, which is the
 * whole point of putting them in the claims — and it means a permission change
 * takes effect within one token lifetime, the same bound as revocation.
 */
export function hasPermission(claims: SessionClaims, permission: string): boolean {
  return hasFromClaims(claims, { permission });
}

export function hasRole(claims: SessionClaims, role: string): boolean {
  return hasFromClaims(claims, { role });
}

/**
 * The full-condition check for a bare claims object — the standalone twin of the
 * bound `result.has()`, for code that already holds claims (e.g. from a JWT it
 * decoded itself). Supports permission / role / anyPermission / allPermissions.
 */
export function has(claims: SessionClaims, condition: ProtectCondition = {}): boolean {
  return hasFromClaims(claims, condition);
}

/**
 * Assert a condition against a bare claims object, throwing `ForbiddenError`
 * when unmet. The standalone twin of the bound `result.protect()`.
 */
export function protect(claims: SessionClaims, condition: ProtectCondition = {}): SessionClaims {
  const outcome = evaluate(claims, condition);
  if (!outcome.allowed) throw new ForbiddenError(outcome.reason, condition);
  return claims;
}
