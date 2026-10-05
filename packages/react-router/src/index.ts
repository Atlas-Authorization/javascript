import {
  AtlasBackend,
  ForbiddenError,
  evaluate,
  hasFromClaims,
  type ProtectCondition,
  type SessionClaims,
} from '@atlasauth/backend';

/**
 * `@atlasauth/react-router` — the React Router v7 / Remix adapter for Atlas auth,
 * mirroring `@clerk/react-router`. It gives a loader/action a `getAuth(request)`
 * accessor and a `rootAuthLoader()` wrapper that attaches auth state for
 * hydration, and it re-exports `@atlasauth/react` so the same package supplies the
 * browser components and hooks (`<SignIn>`, `<AtlasProvider>`, `useAuth`, …).
 *
 * The design constraint that matters is §7.3: verification is LOCAL. A React
 * Router loader runs on the server for every navigation; if it phoned Atlas to
 * verify the session it would add a round trip to every route load and make
 * Atlas's latency and availability the customer's — the exact thing local
 * verification exists to avoid. The session JWT is instead verified against the
 * instance's JWKS, cached in-process by `@atlasauth/backend`, so a warm server
 * verifies every request with NO network call at all. There are no Atlas
 * endpoints called here; this is pure local JWT verification.
 */

// Re-export the shared authorization primitives and the backend verifier, so a
// loader/action imports everything it needs for server-side auth from
// `@atlasauth/react-router` alone — the same `has`/`protect` contract the React
// `<Protect>` component and the Next.js `auth()` evaluate. These explicit named
// re-exports intentionally win over the `export *` below on any name they share
// (e.g. `SessionClaims`), pinning the server-canonical definition.
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

// Re-export the React SDK so a consumer gets `<SignIn>`, `<SignUp>`,
// `<AtlasProvider>`, `<Protect>`, `useAuth`, `useUser`, … from this single
// framework package — the Clerk `@clerk/react-router` idiom of re-exporting
// `@clerk/react`. TypeScript resolves a name that both this module and the star
// export provide to the explicit re-export above, so `SessionClaims` stays the
// backend's server-side definition.
export * from '@atlasauth/react';

/**
 * The verified auth state a loader/action reads via {@link getAuth}. Mirrors
 * Clerk's `getAuth(args)` return: identity fields plus the ergonomic
 * `has`/`protect` helpers bound to the verified claims. On a signed-out request
 * every id is `null`, `has()` returns `false`, and `protect()` throws.
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
   * `ForbiddenError` otherwise (the loader maps that to a 401/403 Response).
   * Throws on a signed-out request.
   */
  protect(condition?: ProtectCondition): SessionClaims;
}

/**
 * Options for {@link getAuth} and {@link rootAuthLoader}.
 *
 * `jwksUrl` + `issuer` are the whole verification contract — an unchecked issuer
 * would accept a token from any Atlas instance. `authorizedParties` optionally
 * pins `azp` so a token minted for one of the customer's apps cannot be replayed
 * against another. `publishableKey` is accepted for Clerk parity and future
 * client wiring; it plays no part in local verification. Omit the whole options
 * object to resolve the config from the environment (see {@link configFromEnv}).
 */
export interface GetAuthOptions {
  jwksUrl: string;
  issuer: string;
  authorizedParties?: readonly string[];
  publishableKey?: string;
  /** Injectable fetch, for tests and custom transports. */
  fetchImpl?: typeof fetch;
}

/**
 * The minimal Web `Request` shape this adapter reads. Kept structural so the
 * package builds with no `react-router` installed, exactly as `@atlasauth/nextjs`
 * avoids a hard Next.js dependency. A real DOM/undici `Request` satisfies it —
 * React Router loaders and actions receive one as `args.request`.
 */
export interface WebRequestLike {
  headers: { get(name: string): string | null };
}

/**
 * The minimal React Router loader/action args shape. A real `LoaderFunctionArgs`
 * / `ActionFunctionArgs` (which carries `request`, `params`, `context`)
 * satisfies it. {@link getAuth} accepts either the bare `Request` or the whole
 * args object, so `getAuth(request)` and `getAuth(args)` both work.
 */
export interface LoaderFunctionArgsLike {
  request: WebRequestLike;
  [key: string]: unknown;
}

function isArgs(input: WebRequestLike | LoaderFunctionArgsLike): input is LoaderFunctionArgsLike {
  // Loader args carry a nested `request` whose `headers.get` is callable; a bare
  // Web `Request` has no `.request`, so it falls through to the request branch.
  const request = (input as LoaderFunctionArgsLike).request;
  return (
    typeof request === 'object' &&
    request !== null &&
    typeof (request as WebRequestLike).headers?.get === 'function'
  );
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
 * throws, so a loader that forgets to check `userId` still fails closed.
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

/** Build the signed-in auth state, binding `has`/`protect` to the claims — the
 *  same construction `@atlasauth/backend` uses for its `AuthorizedSession`. */
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
 * Resolve the auth state for a Web `Request`. Reads an `Authorization: Bearer`
 * header or the `__session` cookie — the header wins, because a caller that set
 * it deliberately should not be overridden by a stale cookie. A token that fails
 * verification — or a missing one — yields the signed-out state, NEVER a throw:
 * a loader that threw on a malformed cookie would surface a 500 to a merely
 * signed-out visitor, whereas degrading to "signed out" simply routes them to
 * sign-in.
 */
export async function resolveAuth(
  backend: AtlasBackend,
  request: WebRequestLike,
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
    // degrades to signed-out rather than propagating and crashing the loader.
    return signedOut();
  }
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
 * `CLERK_*`. Throws with an actionable message when a required value is absent,
 * because a silently-misconfigured verifier fails every request anyway — better a
 * clear error at the first loader call than a mystery sign-out loop.
 */
export function configFromEnv(env: Env = readEnv()): GetAuthOptions {
  const jwksUrl = pick(env, 'ATLAS_JWKS_URL');
  const issuer = pick(env, 'ATLAS_ISSUER');
  if (!jwksUrl) {
    throw new Error('@atlasauth/react-router: missing ATLAS_JWKS_URL.');
  }
  if (!issuer) {
    throw new Error('@atlasauth/react-router: missing ATLAS_ISSUER.');
  }

  const authorizedPartiesRaw = pick(env, 'ATLAS_AUTHORIZED_PARTIES');
  const authorizedParties = authorizedPartiesRaw
    ? authorizedPartiesRaw
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
    : undefined;

  const publishableKey = pick(env, 'ATLAS_PUBLISHABLE_KEY');

  return { jwksUrl, issuer, authorizedParties, publishableKey };
}

/**
 * Memoize backends by their resolved config so the in-process JWKS cache inside
 * `AtlasBackend` stays warm across loader calls — building a fresh backend per
 * `getAuth()` would throw that cache away and re-fetch the JWKS on every
 * navigation, defeating the whole point of local verification.
 */
const backendCache = new Map<string, AtlasBackend>();

// Give each distinct injected `fetch` a stable id, so a custom transport gets its
// own backend (and its own JWKS cache) and never reuses one warmed by a different
// transport — the normal path (no `fetchImpl`) collapses to a single shared,
// warm entry.
const fetchIds = new WeakMap<object, number>();
let fetchSeq = 0;
function fetchToken(fn?: typeof fetch): string {
  if (!fn) return 'default';
  let id = fetchIds.get(fn as unknown as object);
  if (id === undefined) {
    id = ++fetchSeq;
    fetchIds.set(fn as unknown as object, id);
  }
  return `fetch#${id}`;
}

function cacheKey(options: GetAuthOptions): string {
  return [
    options.jwksUrl,
    options.issuer,
    (options.authorizedParties ?? []).join(','),
    fetchToken(options.fetchImpl),
  ].join('\n');
}

function backendFor(options: GetAuthOptions): AtlasBackend {
  const key = cacheKey(options);
  let backend = backendCache.get(key);
  if (!backend) {
    backend = new AtlasBackend({
      jwksUrl: options.jwksUrl,
      issuer: options.issuer,
      authorizedParties: options.authorizedParties,
      fetchImpl: options.fetchImpl,
    });
    backendCache.set(key, backend);
  }
  return backend;
}

function requestOf(input: WebRequestLike | LoaderFunctionArgsLike): WebRequestLike {
  return isArgs(input) ? input.request : input;
}

/**
 * Read and verify the session for a loader/action, the Atlas twin of Clerk's
 * `getAuth(args)`. Accepts either the Web `Request` a React Router loader gets as
 * `args.request`, or the whole loader args object — so `getAuth(request)` and
 * `getAuth(args)` are both valid. Verification is local (see the module note);
 * a missing or invalid token resolves to the signed-out state rather than
 * throwing.
 *
 * Config comes from `options` when given, otherwise from the environment
 * (`ATLAS_JWKS_URL` / `ATLAS_ISSUER`; see {@link configFromEnv}).
 *
 * @example
 * export async function loader(args: LoaderFunctionArgs) {
 *   const { userId, has } = await getAuth(args);
 *   if (!userId) throw redirect('/sign-in');
 *   if (!has({ permission: 'org:billing:manage' })) throw new Response(null, { status: 403 });
 *   return json({ userId });
 * }
 */
export async function getAuth(
  input: WebRequestLike | LoaderFunctionArgsLike,
  options?: GetAuthOptions,
): Promise<AtlasAuth> {
  const resolved = options ?? configFromEnv();
  return resolveAuth(backendFor(resolved), requestOf(input));
}

/**
 * The serializable auth state `rootAuthLoader` attaches to the loader data for
 * client-side hydration. It intentionally excludes the `has`/`protect` functions
 * (not serializable); the browser SDK reconstructs the reactive auth from the
 * durable session cookie, and a server component/loader that needs authorization
 * calls `getAuth().has/protect` directly.
 */
export interface AtlasAuthState {
  userId: string | null;
  sessionId: string | null;
  orgId: string | null;
  orgRole: string | null;
  claims: SessionClaims | null;
  isSignedIn: boolean;
  actor: { sub: string } | null;
}

/** The key under which {@link rootAuthLoader} merges its state into loader data,
 *  namespaced so it never clobbers a handler's own keys. Mirrors the role of
 *  Clerk's `__clerk_ssr_state`. */
export const ATLAS_AUTH_STATE_KEY = '__atlasAuthState' as const;

function toState(auth: AtlasAuth): AtlasAuthState {
  return {
    userId: auth.userId,
    sessionId: auth.sessionId,
    orgId: auth.orgId,
    orgRole: auth.orgRole,
    claims: auth.claims,
    isSignedIn: auth.isSignedIn,
    actor: auth.actor,
  };
}

/**
 * Loader args augmented with the resolved {@link AtlasAuth}, passed to a
 * `rootAuthLoader` handler so it can fetch route data based on the user.
 */
export type LoaderFunctionArgsWithAuth<Args extends LoaderFunctionArgsLike> = Args & {
  auth: AtlasAuth;
};

/**
 * Wrap a root loader so the app's auth state is resolved once and made available
 * for hydration, the Atlas twin of Clerk's `rootAuthLoader`. Mount it on the root
 * route's loader; the browser SDK reads the injected state so the first paint
 * already knows whether the visitor is signed in (no auth flash).
 *
 * Called with just the args it returns the auth state alone; called with a
 * handler it runs the handler with `args.auth` populated and MERGES the auth
 * state into whatever plain object the handler returns (a handler that returns a
 * `Response` is passed through untouched — the caller owns that Response).
 *
 * @example
 * export const loader = (args: LoaderFunctionArgs) => rootAuthLoader(args);
 * // or, with your own root data:
 * export const loader = (args: LoaderFunctionArgs) =>
 *   rootAuthLoader(args, async ({ auth }) => ({ theme: await getTheme(auth.userId) }));
 */
export async function rootAuthLoader<Args extends LoaderFunctionArgsLike>(
  args: Args,
  options?: GetAuthOptions,
): Promise<AtlasAuthState>;
export async function rootAuthLoader<Args extends LoaderFunctionArgsLike>(
  args: Args,
  handler: (args: LoaderFunctionArgsWithAuth<Args>) => Response | Promise<Response>,
  options?: GetAuthOptions,
): Promise<Response>;
export async function rootAuthLoader<
  Args extends LoaderFunctionArgsLike,
  R extends Record<string, unknown>,
>(
  args: Args,
  handler: (args: LoaderFunctionArgsWithAuth<Args>) => R | null | undefined | Promise<R | null | undefined>,
  options?: GetAuthOptions,
): Promise<R & { [ATLAS_AUTH_STATE_KEY]: AtlasAuthState }>;
export async function rootAuthLoader<Args extends LoaderFunctionArgsLike>(
  args: Args,
  handlerOrOptions?:
    | ((args: LoaderFunctionArgsWithAuth<Args>) => unknown | Promise<unknown>)
    | GetAuthOptions,
  maybeOptions?: GetAuthOptions,
): Promise<unknown> {
  const handler = typeof handlerOrOptions === 'function' ? handlerOrOptions : undefined;
  const options = typeof handlerOrOptions === 'function' ? maybeOptions : handlerOrOptions;

  const auth = await getAuth(args, options);
  const state = toState(auth);

  if (!handler) {
    // No handler: hand back the state directly for the root route to expose.
    return state;
  }

  const result = await handler({ ...args, auth } as LoaderFunctionArgsWithAuth<Args>);

  // A handler that returns a Response (e.g. a redirect) owns it — pass it
  // through untouched rather than trying to merge state into a stream.
  if (typeof Response !== 'undefined' && result instanceof Response) {
    return result;
  }

  // Otherwise merge the auth state into the handler's plain object under the
  // namespaced key, so hydration finds it without the handler's keys colliding.
  return { ...((result as Record<string, unknown> | null | undefined) ?? {}), [ATLAS_AUTH_STATE_KEY]: state };
}
