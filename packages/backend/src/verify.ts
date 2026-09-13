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
  /** The instance's JWKS URL. */
  jwksUrl: string;
  /** Expected `iss`. Required — an unchecked issuer accepts any Atlas instance. */
  issuer: string;
  /**
   * §7.3 optional azp allowlist. When set, a token minted for a different
   * origin is refused, which is what stops a token issued to one of the
   * customer's apps being replayed against another.
   */
  authorizedParties?: readonly string[];
  secretKey?: string;
  bapiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class AtlasBackend {
  private readonly jwks: JwksCache;

  constructor(private readonly options: AtlasBackendOptions) {
    this.jwks = new JwksCache({
      url: options.jwksUrl,
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
    if ((tokenUse !== undefined && tokenUse !== 'session') || claims.aud !== undefined) {
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
