import { ForbiddenError, evaluate, hasFromClaims, type ProtectCondition } from '@atlasauth/authz';
import type { AtlasBackend, SessionClaims } from './verify';

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
  /** The impersonator (RFC 8693 `act`) or null. */
  actor: { sub: string } | null;
  has(condition?: ProtectCondition): boolean;
  /** Assert a condition; returns the claims or throws `ForbiddenError`. */
  protect(condition?: ProtectCondition): SessionClaims;
}

export function signedOutAuth(): RequestAuth {
  return {
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
export function sessionTokenFromHeaders(headers: Record<string, HeaderValue>): string | null {
  const authz = first(headers.authorization ?? headers.Authorization);
  if (authz?.startsWith('Bearer ')) return authz.slice(7) || null;
  const cookie = first(headers.cookie ?? headers.Cookie);
  if (cookie) {
    for (const part of cookie.split(';')) {
      const [key, ...rest] = part.trim().split('=');
      if (key === '__session') return rest.join('=') || null;
    }
  }
  return null;
}

/** Verify a request's headers into a {@link RequestAuth}. Never throws. */
export async function authenticateHeaders(backend: AtlasBackend, headers: Record<string, HeaderValue>): Promise<RequestAuth> {
  try {
    const token = sessionTokenFromHeaders(headers);
    if (!token) return signedOutAuth();
    const result = await backend.verify(token);
    return result.ok ? signedInAuth(result.claims) : signedOutAuth();
  } catch {
    return signedOutAuth();
  }
}
