import {
  AtlasBackend,
  ForbiddenError,
  createPkcePair,
  evaluate,
  hasFromClaims,
  redeemHandshake,
  type ProtectCondition,
  type SessionClaims,
} from '@atlasauth/backend';
import { decideRoute, safeRedirect, type MiddlewareConfig } from './matcher';

/**
 * §10.1: "Middleware: reads cookies, verifies JWT at the edge, exposes auth()
 * in server components/route handlers, route protection matcher config."
 *
 * Verifying at the EDGE is the point. A middleware that called Atlas on every
 * request would add a round trip to every page load in the customer's app and
 * make Atlas's latency theirs — which is precisely what §7.3's local
 * verification exists to avoid. The JWKS is cached in-process by
 * `@atlasauth/backend`, so a warm edge instance verifies with no network at all.
 */

export interface AtlasMiddlewareOptions extends MiddlewareConfig {
  publishableKey?: string;
  jwksUrl: string;
  issuer: string;
  authorizedParties?: readonly string[];
  fetchImpl?: typeof fetch;
  /**
   * Cross-property SSO handshake. When a protected route has no valid local
   * session, bounce the browser ONCE through the Atlas handshake endpoint
   * (`GET {fapiOrigin}/v1/client/handshake`) before falling back to the sign-in
   * redirect. The endpoint reads the authoritative session and returns a fresh
   * first-party one, so a user already signed in on another of the customer's
   * properties is admitted here with no login screen. Requires `publishableKey`.
   * The loop is guarded by the `__atlas_hs` marker the endpoint appends: once it
   * comes back (ok → session cookie now present; signed_out → nobody's signed
   * in), we don't handshake again and let normal routing proceed.
   */
  handshake?: boolean;
  /** Origin of the Atlas Frontend API (where `/v1/client/handshake` lives).
   *  Defaults to the origin of `jwksUrl`. */
  fapiOrigin?: string;
}

/** Minimal shapes, so this package does not depend on Next.js at build time. */
export interface EdgeRequest {
  nextUrl: { pathname: string; search?: string };
  headers: { get(name: string): string | null };
  url?: string;
}

/** The subset of a NextResponse cookie jar the handshake redeem needs. */
export interface EdgeCookies {
  set(name: string, value: string, options?: Record<string, unknown>): void;
}
/** A redirect response we can also set first-party cookies on (NextResponse). */
export interface EdgeRedirect {
  cookies?: EdgeCookies;
}

export interface EdgeResponse {
  next(): unknown;
  redirect(url: string | URL): EdgeRedirect;
  json(body: unknown, init?: { status?: number }): unknown;
}

export interface AuthState {
  userId: string | null;
  sessionId: string | null;
  orgId: string | null;
  orgRole: string | null;
  claims: SessionClaims | null;
}

export const SIGNED_OUT: AuthState = {
  userId: null,
  sessionId: null,
  orgId: null,
  orgRole: null,
  claims: null,
};

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

/**
 * Resolve the auth state for a request.
 *
 * A token that fails verification produces SIGNED_OUT, never a thrown error. A
 * middleware that throws takes the whole page down; treating an unverifiable
 * token as "not signed in" degrades to the sign-in screen, which is what the
 * user needs anyway.
 */
export async function resolveAuth(backend: AtlasBackend, request: EdgeRequest): Promise<AuthState> {
  const header = request.headers.get('authorization');
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  const cookie = readCookie(request.headers.get('cookie'), '__session');

  const token = bearer ?? cookie;
  if (!token) return SIGNED_OUT;

  const result = await backend.verify(token);
  if (!result.ok) return SIGNED_OUT;

  return {
    userId: result.claims.sub,
    sessionId: result.claims.sid,
    orgId: result.claims.org_id ?? null,
    orgRole: result.claims.org_role ?? null,
    claims: result.claims,
  };
}

export function atlasMiddleware(options: AtlasMiddlewareOptions) {
  const backend = new AtlasBackend({
    jwksUrl: options.jwksUrl,
    issuer: options.issuer,
    authorizedParties: options.authorizedParties,
    fetchImpl: options.fetchImpl,
  });

  return async function middleware(request: EdgeRequest, response: EdgeResponse) {
    /**
     * Cross-domain satellite RETURN: the handshake endpoint bounced the browser
     * back with `?__atlas_hs=ok&__atlas_hu=<userId>&__atlas_hn=<nonce>`. Exchange
     * the single-use nonce (server-to-server) for a fresh session and set it as
     * this property's OWN first-party cookies, then re-enter on a clean URL so
     * the normal verify path picks up the new `__session`. This is the piece
     * that makes a truly separate-domain property seamless (a same-registrable-
     * domain subdomain instead gets a parent-domain cookie straight from the
     * endpoint and never carries a nonce). Runs before anything else — the
     * session cookie isn't set yet, so route/auth decisions must wait for it.
     */
    if (options.handshake && options.publishableKey && request.url) {
      const url = new URL(request.url);
      const hs = url.searchParams.get('__atlas_hs');
      const userId = url.searchParams.get('__atlas_hu');
      const nonce = url.searchParams.get('__atlas_hn');
      if (hs === 'ok' && userId && nonce) {
        // PKCE proof: redeem only with the verifier we stashed HttpOnly on the
        // way out (its challenge was bound to this nonce at mint time). Without
        // it a leaked nonce is inert — so a missing verifier can never redeem.
        const codeVerifier = readCookie(request.headers.get('cookie'), '__atlas_hv');
        const fapiOrigin = options.fapiOrigin ?? new URL(options.jwksUrl).origin;
        const session = codeVerifier
          ? await redeemHandshake({
              fapiOrigin,
              publishableKey: options.publishableKey,
              userId,
              nonce,
              codeVerifier,
              fetchImpl: options.fetchImpl,
            })
          : null;

        const clean = new URL(url.toString());
        for (const k of ['__atlas_hs', '__atlas_hu', '__atlas_hn']) clean.searchParams.delete(k);

        if (session) {
          const res = response.redirect(clean.toString());
          res.cookies?.set('__session', session.jwt, { path: '/', sameSite: 'lax', secure: true });
          res.cookies?.set('__atlas_rt', session.refreshToken, {
            path: '/',
            httpOnly: true,
            sameSite: 'lax',
            secure: true,
          });
          // The verifier is spent — clear it so it can't be reused or leak.
          res.cookies?.set('__atlas_hv', '', { path: '/', maxAge: 0 });
          return res;
        }

        // A bad/expired/replayed nonce, a rejected PKCE proof, or no verifier →
        // no session. Carry a SPENT marker (__atlas_hs=failed) instead of a clean
        // URL: the outbound guard keys off the presence of __atlas_hs, so a clean
        // URL here would bounce straight back to the handshake forever. With the
        // marker, normal routing takes over and sends the user to sign-in.
        clean.searchParams.set('__atlas_hs', 'failed');
        const res = response.redirect(clean.toString());
        res.cookies?.set('__atlas_hv', '', { path: '/', maxAge: 0 });
        return res;
      }
    }

    const auth = await resolveAuth(backend, request);

    const decision = decideRoute({
      pathname: request.nextUrl.pathname,
      signedIn: auth.userId !== null,
      config: options,
      isApiRoute: request.nextUrl.pathname.startsWith('/api/'),
    });

    switch (decision.action) {
      case 'skip':
      case 'allow':
        return response.next();

      case 'unauthorized':
        return response.json({ errors: [{ code: 'UNAUTHENTICATED' }] }, { status: 401 });

      case 'redirect': {
        /**
         * Cross-property handshake: before sending a signed-out user to the
         * sign-in page, try the Atlas handshake ONCE — they may already have a
         * session on a sibling property. The `__atlas_hs` marker the endpoint
         * appends on its way back is our loop guard: if it's absent we bounce to
         * the handshake; if it's present the handshake already ran (and either
         * set a session cookie we'll now verify on re-entry, or reported
         * signed_out), so we fall through to the normal sign-in redirect.
         */
        if (options.handshake && options.publishableKey && request.url) {
          const current = new URL(request.url);
          if (!current.searchParams.has('__atlas_hs')) {
            // Generate a PKCE pair: only the challenge rides the (loggable)
            // handshake URL; the verifier is stashed HttpOnly and proves
            // possession at redeem, so a captured return-URL nonce is inert.
            const { verifier, challenge } = await createPkcePair();
            const fapiOrigin = options.fapiOrigin ?? new URL(options.jwksUrl).origin;
            const hs = new URL('/v1/client/handshake', fapiOrigin);
            hs.searchParams.set('publishable_key', options.publishableKey);
            hs.searchParams.set('redirect_url', current.toString());
            hs.searchParams.set('code_challenge', challenge);
            const res = response.redirect(hs.toString());
            res.cookies?.set('__atlas_hv', verifier, {
              path: '/',
              httpOnly: true,
              sameSite: 'lax',
              secure: true,
              maxAge: 300, // the handshake round trip is seconds; don't linger
            });
            return res;
          }
        }
        /**
         * The redirect target is built from the request's own pathname, not
         * from anything a caller supplied — but it still goes through
         * `safeRedirect`, because a `redirect_url` already present in the query
         * would otherwise be carried forward unchecked (§13.1).
         */
        const base = request.url ? new URL(request.url).origin : '';
        return response.redirect(`${base}${decision.to}`);
      }
    }
  };
}

/**
 * The `auth()` helper for server components and route handlers.
 *
 * Returns a plain state rather than throwing on a signed-out user, because a
 * server component that renders differently for anonymous visitors is the
 * normal case, not an error.
 */
export function createAuthHelper(options: AtlasMiddlewareOptions) {
  const backend = new AtlasBackend({
    jwksUrl: options.jwksUrl,
    issuer: options.issuer,
    authorizedParties: options.authorizedParties,
    fetchImpl: options.fetchImpl,
  });

  return async function auth(request: EdgeRequest): Promise<
    AuthState & {
      /**
       * Mirrors `<Protect>`, for gating inside a server component. Full
       * condition set (permission / role / anyPermission / allPermissions) via
       * the shared `@atlasauth/authz` primitive — the same one React evaluates, so a
       * check written for a component behaves identically here.
       */
      has(condition?: ProtectCondition): boolean;
      /**
       * Assert access, throwing `ForbiddenError` when unmet. With no argument it
       * asserts signed-in (anonymous access is a bug); with a condition it also
       * asserts the permission/role, like Clerk's `auth().protect({ permission })`.
       */
      protect(condition?: ProtectCondition): asserts this is AuthState & { userId: string };
    }
  > {
    const state = await resolveAuth(backend, request);

    return {
      ...state,
      has(condition = {}) {
        return hasFromClaims(state.claims, condition);
      },
      protect(condition: ProtectCondition = {}) {
        const outcome = evaluate(state.claims, condition);
        if (!outcome.allowed) throw new ForbiddenError(outcome.reason, condition);
      },
    };
  };
}

export { safeRedirect };
