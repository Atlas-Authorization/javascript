import { ForbiddenError, evaluate, hasFromClaims, type ProtectCondition } from '@atlasauth/authz';
import type { AtlasBackend, SessionClaims } from './verify';
import { deriveAuthStatus, type AuthStatus } from './auth-status';
import { readSessionCookie } from './cookie-names';

/**
 * Framework-neutral request authentication, shared by the Koa, Hapi and GraphQL
 * adapters: read the `__session` cookie or `Authorization: Bearer` header
 * (the header wins), verify locally against the JWKS and return the auth state.
 * It never throws: a missing or bad token is the signed-out state, whose
 * `has()` is `false` and `protect()` throws.
 */
export interface RequestAuth {
  userId: string | null;
  sessionId: string | null;
  orgId: string | null;
  orgRole: string | null;
  claims: SessionClaims | null;
  isSignedIn: boolean;
  /** Why the request is or is not signed in. `session_expired` means renew, do not sign out. */
  status: AuthStatus;
  /** The underlying verify reason (`no_token`, `expired`, `malformed`, `invalid`, `revoked`, ...); absent when signed in. */
  reason?: string;
  /** The impersonator (RFC 8693 `act`) or null. */
  actor: { sub: string } | null;
  has(condition?: ProtectCondition): boolean;
  /** Assert a condition; returns the claims or throws `ForbiddenError`. */
  protect(condition?: ProtectCondition): SessionClaims;
}

export function signedOutAuth(status: Exclude<AuthStatus, 'signed_in'> = 'signed_out', reason?: string): RequestAuth {
  return {
    status,
    ...(reason ? { reason } : {}),
    userId: null,
    sessionId: null,
    orgId: null,
    orgRole: null,
    claims: null,
    isSignedIn: false,
    actor: null,
    has: () => false,
    protect: (condition = {}) => {
      throw new ForbiddenError('signed_out', condition);
    },
  };
}

export function signedInAuth(claims: SessionClaims): RequestAuth {
  return {
    userId: claims.sub,
    sessionId: claims.sid,
    orgId: claims.org_id ?? null,
    orgRole: claims.org_role ?? null,
    claims,
    isSignedIn: true,
    status: 'signed_in',
    actor: claims.act && typeof claims.act.sub === 'string' && claims.act.sub ? { sub: claims.act.sub } : null,
    has: (condition = {}) => hasFromClaims(claims, condition),
    protect: (condition = {}) => {
      const outcome = evaluate(claims, condition);
      if (!outcome.allowed) throw new ForbiddenError(outcome.reason, condition);
      return claims;
    },
  };
}

type HeaderValue = string | string[] | undefined;

function first(v: HeaderValue): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** The raw session token a request carries (bearer header first, then the `__session` cookie), or null. */
export function sessionTokenFromHeaders(headers: Record<string, HeaderValue>, cookieSuffix = ''): string | null {
  const authz = first(headers.authorization ?? headers.Authorization);
  if (authz?.startsWith('Bearer ')) return authz.slice(7) || null;
  const cookie = first(headers.cookie ?? headers.Cookie);
  return (cookie && readSessionCookie(cookie, cookieSuffix)) || null;
}

/** Verify a request's headers into a {@link RequestAuth}. Never throws. */
export async function authenticateHeaders(backend: AtlasBackend, headers: Record<string, HeaderValue>): Promise<RequestAuth> {
  try {
    const token = sessionTokenFromHeaders(headers, backend.cookieSuffix);
    const cookie = first(headers.cookie ?? headers.Cookie);
    if (!token) {
      const { status, reason } = deriveAuthStatus(null, cookie, backend.cookieSuffix);
      return signedOutAuth(status as Exclude<AuthStatus, 'signed_in'>, reason);
    }
    const result = await backend.verifyWithExpiry(token);
    if (result.ok) return signedInAuth(result.claims);
    const { status, reason } = deriveAuthStatus(result, cookie, backend.cookieSuffix);
    return signedOutAuth(status as Exclude<AuthStatus, 'signed_in'>, reason);
  } catch {
    return signedOutAuth('token_invalid', 'error');
  }
}
