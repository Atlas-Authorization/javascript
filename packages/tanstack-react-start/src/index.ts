import {
  AtlasBackend,
  ForbiddenError,
  evaluate,
  hasFromClaims,
  type ProtectCondition,
  type SessionClaims,
} from '@atlasauth/backend';

/**
 * `@atlasauth/tanstack-react-start` — the TanStack Start adapter for Atlas auth,
 * mirroring `@clerk/tanstack-react-start`. It gives a TanStack Start app one
 * server-side accessor to the verified session (`getAuth`), a server-function-
 * friendly fetcher (`fetchAtlasAuth`), and a request-middleware factory
 * (`createAtlasHandler`) that decorates the Start request context with auth —
 * plus a full re-export of `@atlasauth/react` for the client components/hooks,
 * so an integrator imports everything from this one package.
 *
 * The design constraint that matters is §7.3: verification is LOCAL. The session
 * JWT is verified against the instance's JWKS, cached in-process by
 * `@atlasauth/backend`, so a warm server verifies every request with no network
 * call at all. Nothing here calls an Atlas endpoint; it is pure local JWT
 * verification, exactly as in `@atlasauth/express` and `@atlasauth/nextjs`.
 */

// ---------------------------------------------------------------------------
// Client surface: re-export the React SDK (components + hooks). An integrator
// wires <AtlasProvider>, <SignedIn>, <Protect>, useAuth(), etc. from the same
// package as the server helpers, mirroring how `@clerk/tanstack-react-start`
// re-exports `@clerk/react`.
// ---------------------------------------------------------------------------
export * from '@atlasauth/react';

// ---------------------------------------------------------------------------
// Server surface: re-export the shared authorization primitives and the backend
// verifier, so the server side of the app has `has`/`protect`/`AtlasBackend`
// from this package alone — the same contract the React `<Protect>` evaluates.
// These explicit named re-exports take precedence over the `export *` above, so
// there is never an ambiguity if a name also appears in `@atlasauth/react`.
// ---------------------------------------------------------------------------
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
 * The verified auth state a server handler / server function reads. Mirrors
 * Clerk's `getAuth(...)` return and the `AtlasAuth` shape of `@atlasauth/express`:
 * identity fields plus the ergonomic `has`/`protect` helpers bound to the
 * verified claims. On a signed-out request every id is `null`, `has()` returns
 * `false`, and `protect()` throws — so a route that forgets to check `userId`
 * still fails closed.
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
   * `ForbiddenError` otherwise (the app maps that to 401/403). Throws on a
   * signed-out request.
   */
  protect(condition?: ProtectCondition): SessionClaims;
}

/**
 * Options for {@link getAuth}, {@link fetchAtlasAuth} and {@link createAtlasHandler}.
 *
 * `jwksUrl` + `issuer` are the whole verification contract — an unchecked issuer
 * would accept a token from any Atlas instance. `authorizedParties` optionally
 * pins `azp` so a token minted for one of the customer's apps cannot be replayed
 * against another. When omitted, the config is read from the environment via
 * {@link configFromEnv} (`ATLAS_JWKS_URL` / `ATLAS_ISSUER` /
 * `ATLAS_AUTHORIZED_PARTIES`). `publishableKey` is accepted for Clerk parity and
 * future client wiring; it plays no part in local verification.
 */
export interface AtlasAuthOptions {
  jwksUrl?: string;
  issuer?: string;
  authorizedParties?: readonly string[];
  publishableKey?: string;
  /** Injectable fetch, for tests and custom transports. */
  fetchImpl?: typeof fetch;
}

/** The fully-resolved verification config (after env fallback). */
interface ResolvedConfig {
  jwksUrl: string;
  issuer: string;
  authorizedParties?: readonly string[];
  fetchImpl?: typeof fetch;
}

/**
 * The minimal Web `Request` shape this adapter reads. Kept structural so the
 * package compiles and ships without TanStack Start (or `lib.dom`'s exact
 * `Request`) installed — a real `Request` satisfies it, exactly as
 * `@atlasauth/nextjs` avoids a hard Next.js dependency. TanStack Start hands you
 * a Web `Request` (e.g. via `getWebRequest()`), which is all this needs.
 */
export interface AtlasRequestLike {
  headers: { get(name: string): string | null };
}

type Env = Record<string, string | undefined>;

/** Read `process.env` without requiring `process` to be typed (no @types/node). */
function readEnv(): Env {
  return (globalThis as { process?: { env?: Env } }).process?.env ?? {};
}

/** First non-empty env var among `names`. */
function pick(env: Env, ...names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

/**
 * Resolve the verification config from the environment, mirroring how Clerk reads
 * `CLERK_*` and how `@atlasauth/nextjs` reads `ATLAS_*`. Throws with an actionable
 * message when a required value is absent, because a silently-misconfigured
 * verifier fails every request anyway — better a clear error at the first call
 * than a mystery sign-out loop.
 */
export function configFromEnv(env: Env = readEnv()): ResolvedConfig {
  const jwksUrl = pick(env, 'ATLAS_JWKS_URL');
  const issuer = pick(env, 'ATLAS_ISSUER');
  if (!jwksUrl) {
    throw new Error('@atlasauth/tanstack-react-start: missing ATLAS_JWKS_URL.');
  }
  if (!issuer) {
    throw new Error('@atlasauth/tanstack-react-start: missing ATLAS_ISSUER.');
  }

  const authorizedPartiesRaw = pick(env, 'ATLAS_AUTHORIZED_PARTIES');
  const authorizedParties = authorizedPartiesRaw
    ? authorizedPartiesRaw
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
    : undefined;

  return { jwksUrl, issuer, authorizedParties };
}

/** Merge explicit options with the environment fallback into a full config. */
function resolveConfig(options?: AtlasAuthOptions): ResolvedConfig {
  if (options?.jwksUrl && options.issuer) {
    return {
      jwksUrl: options.jwksUrl,
      issuer: options.issuer,
      authorizedParties: options.authorizedParties,
      fetchImpl: options.fetchImpl,
    };
  }
  // Partial options are completed from the environment; explicit values win.
  const env = configFromEnv();
  return {
    jwksUrl: options?.jwksUrl ?? env.jwksUrl,
    issuer: options?.issuer ?? env.issuer,
    authorizedParties: options?.authorizedParties ?? env.authorizedParties,
    fetchImpl: options?.fetchImpl,
  };
}

/**
 * Backend cache. A fresh `AtlasBackend` per call would drop the in-process JWKS
 * cache and defeat §7.3's networkless-warm promise, so backends built from the
 * same config are reused. A caller-supplied `fetchImpl` (tests, custom transport)
 * always gets a fresh backend and is never cached — otherwise a JWKS served by
 * one test's stub would leak into the next.
 */
const backendCache = new Map<string, AtlasBackend>();

function backendFor(config: ResolvedConfig): AtlasBackend {
  if (config.fetchImpl) {
    return new AtlasBackend({
      jwksUrl: config.jwksUrl,
      issuer: config.issuer,
      authorizedParties: config.authorizedParties,
      fetchImpl: config.fetchImpl,
    });
  }
  const key = `${config.jwksUrl} ${config.issuer} ${(config.authorizedParties ?? []).join(',')}`;
  let backend = backendCache.get(key);
  if (!backend) {
    backend = new AtlasBackend({
      jwksUrl: config.jwksUrl,
      issuer: config.issuer,
      authorizedParties: config.authorizedParties,
    });
    backendCache.set(key, backend);
  }
  return backend;
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

/**
 * The signed-out auth state. `has()` is always `false` and `protect()` always
 * throws, so a route that forgets to check `userId` still fails closed.
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
 * Resolve the auth state for a request against a given backend. A token that
 * fails verification — or a missing one — yields the signed-out state, NEVER a
 * throw: degrading to "signed out" routes the user to sign-in instead of taking
 * the whole request down on a malformed cookie.
 */
export async function resolveAuth(
  backend: AtlasBackend,
  request: AtlasRequestLike,
): Promise<AtlasAuth> {
  try {
    // The `Authorization` header wins over the cookie: a caller that set a Bearer
    // token deliberately should not be overridden by a stale `__session` cookie.
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
    // degrades to signed-out rather than propagating and crashing the request.
    return signedOut();
  }
}

/**
 * `getAuth(request, options?)` — the server-side accessor to the verified
 * session, the TanStack Start twin of Clerk's `getAuth`. Reads the `__session`
 * cookie (the short-lived Atlas session JWT) or an `Authorization: Bearer`
 * header from a Web `Request`, verifies it locally (networkless when warm), and
 * returns an {@link AtlasAuth}. It NEVER throws: a missing or invalid token
 * yields the signed-out state.
 *
 * Call it inside a TanStack Start server route/handler, or from a server
 * function after obtaining the request (see {@link fetchAtlasAuth}).
 *
 * @example
 * // app/routes/api/me.ts
 * export const APIRoute = createAPIFileRoute('/api/me')({
 *   GET: async ({ request }) => {
 *     const { userId } = await getAuth(request);
 *     return json({ userId });
 *   },
 * });
 */
export async function getAuth(
  request: AtlasRequestLike,
  options?: AtlasAuthOptions,
): Promise<AtlasAuth> {
  const backend = backendFor(resolveConfig(options));
  return resolveAuth(backend, request);
}

/**
 * `fetchAtlasAuth(getRequest, options?)` — the server-function-friendly fetcher,
 * the equivalent of reaching for auth inside a `createServerFn().handler(...)`.
 * TanStack Start server functions have no `request` argument; you obtain the
 * ambient Web request with `getWebRequest()` from `@tanstack/react-start/server`.
 * Pass that getter here (this package does not import TanStack Start, so the
 * getter is injected), and it resolves and verifies the session for you.
 *
 * @example
 * import { createServerFn } from '@tanstack/react-start';
 * import { getWebRequest } from '@tanstack/react-start/server';
 * import { fetchAtlasAuth } from '@atlasauth/tanstack-react-start';
 *
 * export const getServerAuth = createServerFn({ method: 'GET' }).handler(() =>
 *   fetchAtlasAuth(getWebRequest),
 * );
 */
export async function fetchAtlasAuth(
  getRequest: () => AtlasRequestLike | null | undefined | Promise<AtlasRequestLike | null | undefined>,
  options?: AtlasAuthOptions,
): Promise<AtlasAuth> {
  const request = await getRequest();
  // No ambient request (called outside a request scope) → signed out, never a
  // throw, consistent with every other entry point here.
  if (!request) return signedOut();
  return getAuth(request, options);
}

/**
 * The context a TanStack Start request middleware receives, and the `next`
 * continuation it calls. Kept structural so the package builds without
 * `@tanstack/react-start` installed. The real `createMiddleware().server(fn)`
 * hands `fn` exactly this: the Web `request` and a `next({ context })` that
 * threads values down to nested middleware, loaders and server functions.
 */
export interface AtlasHandlerArgs {
  request: AtlasRequestLike;
  next: (opts: { context: { atlasAuth: AtlasAuth } }) => Promise<unknown>;
}

/**
 * `createAtlasHandler(options?)` — the TanStack Start request-middleware factory,
 * the equivalent of Clerk's `clerkMiddleware()` / `createClerkHandler`. It
 * verifies the session once per request and injects the resolved
 * {@link AtlasAuth} into the Start request context as `atlasAuth`, so every
 * downstream loader and server function reads the same verified state without
 * re-parsing the request.
 *
 * It never blocks a request and never throws on a bad token: an unverifiable
 * session is threaded through as signed-out, and route protection is the job of
 * `atlasAuth.protect()` (or an explicit `userId` check) in the loader/handler.
 *
 * @example
 * // app/start.ts
 * import { createMiddleware, registerGlobalMiddleware } from '@tanstack/react-start';
 * import { createAtlasHandler } from '@atlasauth/tanstack-react-start';
 *
 * registerGlobalMiddleware({
 *   middleware: [createMiddleware().server(createAtlasHandler())],
 * });
 * // ...then in any server fn: `const { atlasAuth } = context;`
 */
export function createAtlasHandler(
  options?: AtlasAuthOptions,
): (args: AtlasHandlerArgs) => Promise<unknown> {
  // Resolve the config once at wire time so a bad env fails fast, not per request.
  const config = resolveConfig(options);
  const backend = backendFor(config);

  return async function atlasHandler({ request, next }) {
    const atlasAuth = await resolveAuth(backend, request);
    return next({ context: { atlasAuth } });
  };
}
