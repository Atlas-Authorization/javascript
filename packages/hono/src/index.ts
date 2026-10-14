import {
  AtlasBackend,
  ForbiddenError,
  evaluate,
  hasFromClaims,
  type ProtectCondition,
  type SessionClaims,
} from '@atlasauth/backend';

/**
 * `@atlasauth/hono` — the Hono adapter, the edge/Workers twin of
 * `@atlasauth/nextjs`. Hono runs on Cloudflare Workers, Deno, Bun and Node, so
 * the whole point is the SAME §7.3 verification `@atlasauth/nextjs` does at the
 * Next.js edge: read the token a request carries, verify it LOCALLY against
 * cached JWKS (no call to Atlas on the hot path), and hand the route a resolved
 * auth object. A Worker handling a burst of requests cannot make one outbound
 * verification call per request, and one that did would make Atlas's latency and
 * availability its own — which is exactly what local verification exists to
 * avoid.
 *
 * Mirrors Clerk's `@clerk/hono` idiom: `atlasMiddleware()` sets the auth on the
 * Hono context, `getAuth(c)` reads it back.
 *
 * @example
 * ```ts
 * import { Hono } from 'hono';
 * import { atlasMiddleware, getAuth } from '@atlasauth/hono';
 *
 * const app = new Hono();
 * app.use('*', atlasMiddleware({ jwksUrl, issuer }));
 *
 * app.get('/me', (c) => {
 *   const { userId } = getAuth(c);
 *   if (!userId) return c.json({ error: 'signed out' }, 401);
 *   return c.json({ userId });
 * });
 * ```
 */

// Re-export the backend surface so an integrator imports `AtlasBackend` and the
// shared authorization primitives from `@atlasauth/hono` directly, the same way
// `@atlasauth/nextjs` lets them.
export { AtlasBackend, ForbiddenError, evaluate, hasFromClaims } from '@atlasauth/backend';
export type {
  SessionClaims,
  ProtectCondition,
  ProtectOutcome,
  ProtectReason,
  AuthzClaims,
  VerifyResult,
  AuthorizedSession,
  AtlasBackendOptions,
} from '@atlasauth/backend';

/**
 * The Hono context variable key the auth object is stored under. `getAuth(c)`
 * reads it back; parallel to Clerk's `'clerkAuth'`.
 */
export const ATLAS_CONTEXT_KEY = 'atlas' as const;

/**
 * §7.5 the session cookie name. Same across every Atlas SDK — `__session` is the
 * script-readable cookie the frontend refreshes; the backend reads whichever of
 * the header or this cookie a request carries.
 */
export const SESSION_COOKIE = '__session' as const;

export interface AtlasMiddlewareOptions {
  /** The instance's JWKS URL — where the signing keys are fetched and cached. */
  jwksUrl: string;
  /** Expected `iss`. Required: an unchecked issuer accepts any Atlas instance. */
  issuer: string;
  /**
   * §7.3 optional `azp` allowlist. When set, a token minted for a different
   * origin is refused, so a token issued to one of the customer's apps cannot be
   * replayed against another.
   */
  authorizedParties?: readonly string[];
  /**
   * The instance publishable key. Accepted for Clerk parity and so a future
   * client-facing feature can derive the FAPI origin from it; verification is
   * purely local and never uses it, so it is optional.
   */
  publishableKey?: string;
  /** Override `fetch` (JWKS retrieval). For tests and non-standard runtimes. */
  fetchImpl?: typeof fetch;
}

/** The plain, serializable auth state resolved from a request. */
export interface AtlasAuthState {
  userId: string | null;
  sessionId: string | null;
  orgId: string | null;
  orgRole: string | null;
  claims: SessionClaims | null;
}

/**
 * The auth object stored on the Hono context and returned by `getAuth`. Carries
 * the same ergonomic `has`/`protect` helpers as the Next.js `auth()` and the
 * React `<Protect>`, bound to this request's claims and delegating to the shared
 * `@atlasauth/authz` primitive — so a check reads identically everywhere.
 */
export interface AtlasAuth extends AtlasAuthState {
  /**
   * Convenience flag: `true` exactly when `userId` is non-null. Present so the
   * Hono `getAuth()` matches `@atlasauth/express` and `@atlasauth/fastify` — a
   * route reads `getAuth(c).isSignedIn` instead of re-deriving `userId !== null`.
   */
  isSignedIn: boolean;
  /**
   * True when the claims satisfy the condition (an empty condition means
   * "signed in"). Full condition set: permission / role / anyPermission /
   * allPermissions / plan / feature.
   */
  has(condition?: ProtectCondition): boolean;
  /**
   * Assert access, throwing `ForbiddenError` when unmet. With no argument it
   * asserts signed-in (anonymous access is a bug); with a condition it also
   * asserts the permission/role, like Clerk's `auth().protect({ permission })`.
   */
  protect(condition?: ProtectCondition): asserts this is AtlasAuth & { userId: string };
}

/**
 * Minimal, STRUCTURAL Hono typings. The package declares `hono` as a
 * peerDependency but does not import it, so it builds even when Hono is not yet
 * installed and never pins the consumer to a specific Hono version. Any real
 * Hono `Context` / `MiddlewareHandler` satisfies these shapes, so the middleware
 * drops straight into `app.use()`.
 */
export interface HonoRequestLike {
  /** Read a request header (case-insensitive), Hono's `c.req.header(name)`. */
  header(name: string): string | undefined;
}
export interface HonoContextLike {
  req: HonoRequestLike;
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}
export type NextLike = () => Promise<void>;
export type MiddlewareHandler = (c: HonoContextLike, next: NextLike) => Promise<void>;

/** Parse one cookie value out of a raw `Cookie` header. */
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

/** Bind `has`/`protect` to a resolved state — the single construction point. */
function buildAuth(state: AtlasAuthState): AtlasAuth {
  return {
    ...state,
    // Derived from the resolved state so it can never drift from `userId`.
    isSignedIn: state.userId !== null,
    has(condition: ProtectCondition = {}) {
      return hasFromClaims(state.claims, condition);
    },
    protect(condition: ProtectCondition = {}) {
      const outcome = evaluate(state.claims, condition);
      if (!outcome.allowed) throw new ForbiddenError(outcome.reason, condition);
    },
  };
}

/** The signed-out auth object — every field null, `has()` false, `protect()` throws. */
export const SIGNED_OUT: AtlasAuth = buildAuth({
  userId: null,
  sessionId: null,
  orgId: null,
  orgRole: null,
  claims: null,
});

/**
 * Resolve auth from whatever a request carries. The `Authorization: Bearer`
 * header wins over the `__session` cookie — a caller that set the header
 * deliberately should not be overridden by a stale cookie (§7.5).
 *
 * A token that fails verification resolves to SIGNED_OUT, NEVER a thrown error:
 * a middleware that throws takes the whole route down, whereas treating an
 * unverifiable token as "not signed in" degrades to the app's signed-out path,
 * which is what the caller needs anyway.
 */
export async function resolveAuth(
  backend: AtlasBackend,
  c: HonoContextLike,
): Promise<AtlasAuth> {
  const header = c.req.header('authorization') ?? c.req.header('Authorization');
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  const cookie = readCookie(c.req.header('cookie') ?? c.req.header('Cookie'), SESSION_COOKIE);

  const token = bearer ?? cookie;
  if (!token) return SIGNED_OUT;

  const result = await backend.verify(token);
  if (!result.ok) return SIGNED_OUT;

  return buildAuth({
    userId: result.claims.sub,
    sessionId: result.claims.sid,
    orgId: result.claims.org_id ?? null,
    orgRole: result.claims.org_role ?? null,
    claims: result.claims,
  });
}

/**
 * Atlas middleware for Hono. Reads the token a request carries, verifies it
 * locally against cached JWKS, and stores the resolved auth object on the
 * context under `'atlas'`. Read it back with `getAuth(c)`.
 *
 * Networkless on the hot path — the only outbound call is a cold JWKS fetch on
 * an unknown `kid`, at most one a minute, cached in-process by
 * `@atlasauth/backend`.
 */
export function atlasMiddleware(options: AtlasMiddlewareOptions): MiddlewareHandler {
  const backend = new AtlasBackend({
    jwksUrl: options.jwksUrl,
    issuer: options.issuer,
    authorizedParties: options.authorizedParties,
    fetchImpl: options.fetchImpl,
  });

  return async function middleware(c, next) {
    const auth = await resolveAuth(backend, c);
    c.set(ATLAS_CONTEXT_KEY, auth);
    await next();
  };
}

/**
 * Read the auth object `atlasMiddleware` stored on the context. Returns
 * SIGNED_OUT when the middleware has not run (rather than throwing), so a route
 * that renders differently for anonymous callers — the normal case — just works.
 */
export function getAuth(c: HonoContextLike): AtlasAuth {
  const auth = c.get(ATLAS_CONTEXT_KEY);
  return (auth as AtlasAuth | undefined) ?? SIGNED_OUT;
}
