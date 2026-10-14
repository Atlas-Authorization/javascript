import { evaluate, type ProtectCondition } from '@atlasauth/js';
import type { SessionClaims } from './types';

/**
 * Qwik City route-protection helper (optional `@builder.io/qwik-city` peer).
 *
 * Use it in a `routeLoader$`, `routeAction$` or an `onRequest` / `onGet` to keep
 * unauthenticated visitors off a route:
 *
 * ```ts
 * export const onRequest: RequestHandler = (event) => {
 *   protectRoute(event, { signInUrl: '/sign-in' });
 * };
 * ```
 *
 * IMPORTANT — this is a routing convenience, NOT a security boundary. It reads
 * the `__session` cookie and decodes the JWT **without verifying its
 * signature**, so it can decide "send this request to the sign-in page" cheaply
 * at the edge. It must never be the only thing between a user and protected
 * data: verify the token's signature on the server with `@atlasauth/backend`
 * before trusting any claim. A forged cookie sails past this check and is caught
 * only there.
 */

/** The slice of a Qwik City request event this helper needs — duck-typed so the
 * package does not hard-depend on `@builder.io/qwik-city`. */
export interface GuardRequestEvent {
  cookie: { get(name: string): { value: string } | null };
  /** Qwik City's `redirect()` — returns a value the caller throws. */
  redirect(status: number, url: string): unknown;
  url: URL;
}

const SESSION_COOKIE = '__session';

/** Decode a JWT payload WITHOUT verifying it. See the module caveat. */
function decodeClaims(jwt: string): SessionClaims | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(atob(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as SessionClaims;
  } catch {
    return null;
  }
}

export interface ServerAuthState {
  isSignedIn: boolean;
  /** The UNVERIFIED session claims, or null when there is no session cookie. */
  claims: SessionClaims | null;
  /** Evaluate a role/permission condition against the unverified claims. */
  has(condition: ProtectCondition): boolean;
}

/**
 * Read the (unverified) auth state from the request's `__session` cookie. A
 * token past its `exp` is treated as signed-out so a stale cookie does not keep
 * a visitor on a protected page.
 */
export function getAuthState(event: GuardRequestEvent): ServerAuthState {
  const raw = event.cookie.get(SESSION_COOKIE)?.value;
  const claims = raw ? decodeClaims(raw) : null;
  const fresh = claims && (typeof claims.exp !== 'number' || claims.exp * 1000 > Date.now());
  const effective = fresh ? claims : null;

  return {
    isSignedIn: Boolean(effective),
    claims: effective,
    has: (condition: ProtectCondition) => evaluate(effective, condition).allowed,
  };
}

export interface ProtectRouteOptions {
  /** Where to send an unauthenticated (or unauthorized) request. Default `/sign-in`. */
  signInUrl?: string;
  /** HTTP status for the redirect. Default `302`. */
  status?: number;
  /**
   * An optional role/permission condition. When set, a signed-in user who does
   * not satisfy it is redirected too (to {@link ProtectRouteOptions.forbiddenUrl}
   * if given, else `signInUrl`).
   */
  condition?: ProtectCondition;
  forbiddenUrl?: string;
}

/**
 * Throw a redirect unless the request carries an (unverified) Atlas session that
 * satisfies the optional condition. Returns the auth state when it passes, so a
 * loader can reuse the claims. Remember the module caveat: pair this with a
 * real signature check on the server.
 */
export function protectRoute(
  event: GuardRequestEvent,
  options: ProtectRouteOptions = {},
): ServerAuthState {
  const { signInUrl = '/sign-in', status = 302, condition, forbiddenUrl } = options;
  const state = getAuthState(event);

  if (!state.isSignedIn) {
    throw event.redirect(status, signInUrl);
  }
  if (condition && !state.has(condition)) {
    throw event.redirect(status, forbiddenUrl ?? signInUrl);
  }
  return state;
}
