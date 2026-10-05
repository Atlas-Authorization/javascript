import {
  AtlasBackend,
  ForbiddenError,
  evaluate,
  hasFromClaims,
  type ProtectCondition,
  type SessionClaims,
} from '@atlasauth/backend';

/**
 * `@atlasauth/astro` (server) — the Astro adapter for Atlas auth, the SSR twin of
 * `@atlasauth/express` and `@atlasauth/nextjs`. It mirrors `@clerk/astro`: one
 * middleware that verifies the session and decorates `context.locals.atlas`, plus
 * a `getAuth(context)` accessor.
 *
 * The design constraint that matters is §7.3: verification is LOCAL. The session
 * JWT is verified against the instance's JWKS, cached in-process by
 * `@atlasauth/backend`, so a warm server verifies every request with no network
 * call at all. A middleware that phoned Atlas on each request would add a round
 * trip to every page render and make Atlas's latency and availability the
 * customer's — the exact thing local verification exists to avoid. There are NO
 * Atlas endpoints called here; this is pure local JWT verification.
 */

// Re-export the shared authorization primitives and the backend verifier, so an
// integrator imports everything they need for server-side auth from
// `@atlasauth/astro` alone — the same `has`/`protect` contract the Next.js
// `auth()` and the Express `req.atlas` evaluate.
export {
  AtlasBackend,
  ForbiddenError,
  evaluate,
  hasFromClaims,
  type ProtectCondition,
  type ProtectOutcome,
  type ProtectReason,
  type SessionClaims,
  type AuthorizedSession,
  type VerifyResult,
  type AtlasBackendOptions,
} from '@atlasauth/backend';

/**
 * The verified auth state attached to `context.locals.atlas`. Mirrors Clerk's
 * Astro `locals.auth()`: identity fields plus the ergonomic `has`/`protect`
 * helpers bound to the verified claims. On a signed-out request every id is
 * `null`, `has()` returns `false`, and `protect()` throws.
 */
export interface AtlasAuth {
  /** The subject (`sub`) — the signed-in user's id, or `null` when signed out. */
  userId: string | null;
  /** The session id (`sid`), or `null` when signed out. */
  sessionId: string | null;
  /** The active organization id (`org_id`), or `null`. */
  orgId: string | null;
  /** The user's role in the active organization (`org_role`), or `null`. */
  orgRole: string | null;
  /** The full verified claims, or `null` when signed out. */
  claims: SessionClaims | null;
  /** Convenience flag: `true` exactly when `userId` is non-null. */
  isSignedIn: boolean;
  /**
   * The impersonator when this is an impersonation session (RFC 8693 `act`),
   * else `null`. Read it to render the mandatory "viewing as X" banner and to
   * tag audit entries — never as an authorization input.
   */
  actor: { sub: string } | null;
  /**
   * Answer an authorization condition against the verified claims (permission /
   * role / anyPermission / allPermissions). An empty condition means "signed
   * in". Always `false` when signed out.
   */
  has(condition?: ProtectCondition): boolean;
  /**
   * Assert a condition, returning the claims on success and throwing
   * `ForbiddenError` otherwise (the page maps that to a redirect or 401/403).
   * Throws on a signed-out request.
   */
  protect(condition?: ProtectCondition): SessionClaims;
}

/**
 * Options for {@link atlasMiddleware}.
 *
 * `jwksUrl` + `issuer` are the whole verification contract — an unchecked issuer
 * would accept a token from any Atlas instance. When omitted they fall back to
 * `ATLAS_JWKS_URL` / `ATLAS_ISSUER` in the environment. `authorizedParties`
 * optionally pins `azp` so a token minted for one of the customer's apps cannot
 * be replayed against another. `publishableKey` is accepted for Clerk parity and
 * future client wiring; it plays no part in local verification.
 */
export interface AtlasMiddlewareOptions {
  jwksUrl?: string;
  issuer?: string;
  authorizedParties?: readonly string[];
  publishableKey?: string;
  /** Injectable fetch, for tests and custom transports. */
  fetchImpl?: typeof fetch;
}

/** The resolved, non-optional verification config. */
interface ResolvedConfig {
  jwksUrl: string;
  issuer: string;
  authorizedParties?: readonly string[];
  fetchImpl?: typeof fetch;
}

/**
 * The minimal Astro `APIContext` shape this adapter reads and decorates. Kept
 * structural so the package needs no `astro` installed at build time, exactly as
 * `@atlasauth/express` avoids a hard Express dependency and `@atlasauth/nextjs`
 * avoids a hard Next.js one. A real Astro `APIContext` satisfies it.
 */
export interface AtlasAPIContext {
  /** The incoming Fetch API `Request` — Astro passes a standard `Request`. */
  request: { headers: { get(name: string): string | null } };
  /** Astro's per-request `locals` bag; the middleware writes `atlas` here. */
  locals: AtlasLocals;
  [key: string]: unknown;
}

/** The `locals` bag as this adapter sees it. `atlas` is what we decorate. */
export interface AtlasLocals {
  atlas?: AtlasAuth;
  [key: string]: unknown;
}

/** Astro's middleware `next()` continuation. */
export type AtlasMiddlewareNext = () => Promise<Response> | Response;

/**
 * An Astro `MiddlewareHandler`. Structural mirror of Astro's own type so the
 * package builds without `astro` installed; a real `MiddlewareHandler` is
 * assignable to it.
 */
export type AtlasMiddlewareHandler = (
  context: AtlasAPIContext,
  next: AtlasMiddlewareNext,
) => Promise<Response> | Response;

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

/** Read `process.env` without requiring `process` to be typed (no @types/node). */
function readEnv(): Record<string, string | undefined> {
  return (
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
  );
}

/**
 * Resolve the verification config from options first, then the environment
 * (`ATLAS_JWKS_URL` / `ATLAS_ISSUER` / `ATLAS_AUTHORIZED_PARTIES`), mirroring how
 * Clerk's Astro middleware falls back to `PUBLIC_CLERK_*`. Throws with an
 * actionable message when a required value is absent from both, because a
 * silently-misconfigured verifier fails every request anyway — better a clear
 * error at setup than a mystery sign-out loop.
 */
function resolveConfig(options: AtlasMiddlewareOptions): ResolvedConfig {
  const env = readEnv();
  const jwksUrl = options.jwksUrl ?? env.ATLAS_JWKS_URL;
  const issuer = options.issuer ?? env.ATLAS_ISSUER;
  if (!jwksUrl) {
    throw new Error('@atlasauth/astro: missing jwksUrl (or ATLAS_JWKS_URL).');
  }
  if (!issuer) {
    throw new Error('@atlasauth/astro: missing issuer (or ATLAS_ISSUER).');
  }

  let authorizedParties = options.authorizedParties;
  if (!authorizedParties && env.ATLAS_AUTHORIZED_PARTIES) {
    const parsed = env.ATLAS_AUTHORIZED_PARTIES.split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    authorizedParties = parsed.length > 0 ? parsed : undefined;
  }

  return { jwksUrl, issuer, authorizedParties, fetchImpl: options.fetchImpl };
}

/**
 * The signed-out auth state. `has()` is always `false` and `protect()` always
 * throws, so a page that forgets to check `userId` still fails closed.
 */
export function signedOut(): AtlasAuth {
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

/** Build the signed-in auth state, binding `has`/`protect` to the claims —
 *  the same construction `@atlasauth/backend` uses for its `AuthorizedSession`. */
function signedIn(claims: SessionClaims): AtlasAuth {
  return {
    userId: claims.sub,
    sessionId: claims.sid,
    orgId: claims.org_id ?? null,
    orgRole: claims.org_role ?? null,
    claims,
    isSignedIn: true,
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

/**
 * Resolve the auth state for a request. A token that fails verification — or a
 * missing one — yields the signed-out state, NEVER a throw. This is the whole
 * reason the middleware is safe to register globally: a throwing auth middleware
 * takes the entire page down on a malformed cookie, whereas degrading to "signed
 * out" simply routes the user to sign-in.
 */
export async function resolveAuth(
  backend: AtlasBackend,
  request: AtlasAPIContext['request'],
): Promise<AtlasAuth> {
  try {
    const header = request.headers.get('authorization');
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const cookie = readCookie(request.headers.get('cookie'), '__session');

    const token = bearer ?? cookie;
    if (!token) return signedOut();

    const result = await backend.verify(token);
    if (!result.ok) return signedOut();

    return signedIn(result.claims);
  } catch {
    // Any unexpected failure (a corrupt header, a JWKS transport error) still
    // degrades to signed-out rather than propagating and crashing the render.
    return signedOut();
  }
}

/**
 * Astro middleware that authenticates the request and attaches the auth state to
 * `context.locals.atlas`. Reads the `__session` cookie (the short-lived Atlas
 * session JWT) or an `Authorization: Bearer` header — the header wins, because a
 * caller that set it deliberately should not be overridden by a stale cookie.
 *
 * It NEVER throws and NEVER blocks the request: verification failure leaves a
 * signed-out `context.locals.atlas` and calls `next()`. Page protection is the
 * job of an explicit `getAuth(context).userId` check, or `locals.atlas.protect()`.
 *
 * @example
 * // src/middleware.ts
 * import { atlasMiddleware } from '@atlasauth/astro/server';
 * export const onRequest = atlasMiddleware({ jwksUrl, issuer });
 *
 * // any .astro page or endpoint
 * const { userId } = Astro.locals.atlas;
 */
export function atlasMiddleware(options: AtlasMiddlewareOptions = {}): AtlasMiddlewareHandler {
  const config = resolveConfig(options);
  const backend = new AtlasBackend({
    jwksUrl: config.jwksUrl,
    issuer: config.issuer,
    authorizedParties: config.authorizedParties,
    fetchImpl: config.fetchImpl,
  });

  return async function middleware(context, next) {
    try {
      context.locals.atlas = await resolveAuth(backend, context.request);
    } catch {
      // resolveAuth already fails closed, but guard the attach step too: a
      // signed-out decoration is always safe, a thrown middleware is not.
      context.locals.atlas = signedOut();
    }
    return next();
  };
}

/**
 * Read the auth state a prior {@link atlasMiddleware} attached. Returns the
 * signed-out default when the middleware has not run (or left nothing), so a
 * caller never has to null-check `locals.atlas` itself — mirrors Clerk's
 * `locals.auth()` accessor.
 */
export function getAuth(context: AtlasAPIContext): AtlasAuth {
  return context.locals.atlas ?? signedOut();
}
