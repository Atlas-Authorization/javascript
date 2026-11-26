/**
 * `@atlasauth/nextjs/server` — the pre-bound, zero-argument App-Router helpers.
 *
 * §Q7 gap: the base entry ships FACTORIES (`createAuthHelper`,
 * `createCurrentUserHelper`) that the integrator wires once and then feeds an
 * `EdgeRequest` on every call. Clerk instead ships `auth()` / `currentUser()`
 * that read the ambient request from `next/headers` with no argument and read
 * their config from the environment. This subpath adds exactly that ergonomic
 * ON TOP of the existing core — it reuses `resolveAuth` + `AtlasBackend` through
 * the very same factories, so JWT verification is defined in exactly one place.
 *
 * It lives in its own entry precisely because it imports `next/headers`: keeping
 * it out of `index.ts` means `@atlasauth/nextjs` (middleware + matcher) still
 * builds and runs with no `next` installed. `next` is only an OPTIONAL peer.
 */
import {
  AtlasBackend,
  createAtlasClient,
  parseIssuerList,
  type AtlasClient,
  type AtlasClientConfig,
  type SessionClaims,
} from '@atlasauth/backend';
import {
  createAuthHelper,
  createCurrentUserHelper,
  resolveAuth,
  type AtlasMiddlewareOptions,
  type CurrentUser,
  type EdgeRequest,
} from './middleware';

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
 * Resolve the edge-verification config from the environment, mirroring how Clerk
 * reads `CLERK_*` / `NEXT_PUBLIC_CLERK_*`. Server-only names win over their
 * `NEXT_PUBLIC_` fallbacks. Throws with an actionable message when a required
 * value is absent, because a silently-misconfigured verifier fails every request
 * anyway — better a clear error at the first call than a mystery sign-out loop.
 */
export function configFromEnv(env: Env = readEnv()): AtlasMiddlewareOptions {
  const jwksUrl = pick(env, 'ATLAS_JWKS_URL', 'NEXT_PUBLIC_ATLAS_JWKS_URL');
  const issuer = pick(env, 'ATLAS_ISSUER', 'NEXT_PUBLIC_ATLAS_ISSUER');
  if (!jwksUrl) {
    throw new Error(
      '@atlasauth/nextjs/server: missing ATLAS_JWKS_URL (or NEXT_PUBLIC_ATLAS_JWKS_URL).',
    );
  }
  if (!issuer) {
    throw new Error(
      '@atlasauth/nextjs/server: missing ATLAS_ISSUER (or NEXT_PUBLIC_ATLAS_ISSUER).',
    );
  }

  const authorizedPartiesRaw = pick(
    env,
    'ATLAS_AUTHORIZED_PARTIES',
    'NEXT_PUBLIC_ATLAS_AUTHORIZED_PARTIES',
  );
  const authorizedParties = authorizedPartiesRaw
    ? authorizedPartiesRaw
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
    : undefined;

  const previousIssuers = parseIssuerList(pick(env, 'ATLAS_PREVIOUS_ISSUERS', 'NEXT_PUBLIC_ATLAS_PREVIOUS_ISSUERS'));

  const publishableKey = pick(env, 'ATLAS_PUBLISHABLE_KEY', 'NEXT_PUBLIC_ATLAS_PUBLISHABLE_KEY');

  // ATLAS_REVOCATION=true also rejects tokens of sessions Atlas has revoked (needs ATLAS_SECRET_KEY with sessions:read).
  const revocation = ['true', '1', 'sid_list'].includes((pick(env, 'ATLAS_REVOCATION') ?? '').toLowerCase());

  return {
    jwksUrl,
    issuer,
    previousIssuers: previousIssuers?.length ? previousIssuers : undefined,
    authorizedParties,
    publishableKey,
    ...(revocation ? { revocation: true, secretKey: pick(env, 'ATLAS_SECRET_KEY'), bapiBaseUrl: pick(env, 'ATLAS_API_BASE', 'ATLAS_API_URL', 'NEXT_PUBLIC_ATLAS_API_URL') } : {}),
  };
}

/**
 * Resolve the Backend-API (secret-key) config from the environment, for
 * {@link atlasClient}. The secret key is server-only by definition — there is no
 * `NEXT_PUBLIC_` fallback for it, and there must never be one.
 */
export function backendConfigFromEnv(env: Env = readEnv()): AtlasClientConfig {
  const secretKey = pick(env, 'ATLAS_SECRET_KEY');
  if (!secretKey) {
    throw new Error('@atlasauth/nextjs/server: missing ATLAS_SECRET_KEY.');
  }
  const apiUrl = pick(env, 'ATLAS_API_BASE', 'ATLAS_API_URL', 'NEXT_PUBLIC_ATLAS_API_URL');
  return { secretKey, apiUrl };
}

/**
 * `clerkClient()`-equivalent: a configured `@atlasauth/backend` management client
 * built from `ATLAS_SECRET_KEY` (+ optional `ATLAS_API_URL`). Overrides win over
 * the environment, for tests and multi-instance setups.
 */
export function atlasClient(overrides: Partial<AtlasClientConfig> = {}): AtlasClient {
  const env = readEnv();
  // Resolve from the environment leniently so an explicit override can supply
  // the secret key on its own; `createAtlasClient` still throws if none is found
  // from either source.
  return createAtlasClient({
    secretKey: overrides.secretKey ?? pick(env, 'ATLAS_SECRET_KEY') ?? '',
    apiUrl: overrides.apiUrl ?? pick(env, 'ATLAS_API_BASE', 'ATLAS_API_URL', 'NEXT_PUBLIC_ATLAS_API_URL'),
    fetch: overrides.fetch,
  });
}

/** The subset of Next's cookie store {@link buildEdgeRequest} reads. */
export interface CookieStoreLike {
  getAll(): ReadonlyArray<{ name: string; value: string }>;
  get?(name: string): { value: string } | undefined;
}

/** The subset of Next's header store {@link buildEdgeRequest} reads. */
export interface HeaderStoreLike {
  get(name: string): string | null | undefined;
}

/**
 * Build an `EdgeRequest`-shaped object from a cookie store + a header store, the
 * bridge between `next/headers` and the existing `resolveAuth` core. Pure and
 * injectable: the ambient `auth()` feeds it the real Next stores, and tests feed
 * it fakes — no request context required. `resolveAuth` reads only the
 * `authorization` and `cookie` headers, so those are what we synthesize; the
 * cookie header is reconstructed from the cookie store (which reflects any
 * in-request mutations), falling back to the raw `cookie` header.
 */
export function buildEdgeRequest(
  cookieStore: CookieStoreLike,
  headerStore: HeaderStoreLike,
): EdgeRequest {
  const reconstructed = cookieStore
    .getAll()
    .map(({ name, value }) => `${name}=${value}`)
    .join('; ');
  const cookieHeader = reconstructed.length > 0 ? reconstructed : (headerStore.get('cookie') ?? null);
  const authorization = headerStore.get('authorization') ?? null;

  return {
    nextUrl: { pathname: '' },
    headers: {
      get(name: string): string | null {
        const key = name.toLowerCase();
        if (key === 'cookie') return cookieHeader;
        if (key === 'authorization') return authorization;
        return headerStore.get(name) ?? null;
      },
    },
  };
}

/**
 * Read the ambient request from `next/headers` and shape it for the core.
 * Imported dynamically so merely importing this module never touches
 * `next/headers` (which throws outside a request scope) — the module loads only
 * when `auth()`/`currentUser()` actually run inside a server component, route
 * handler, or Server Action.
 */
async function edgeRequestFromContext(): Promise<EdgeRequest> {
  const { cookies, headers } = await import('next/headers');
  const cookieStore = await cookies();
  const headerStore = await headers();
  return buildEdgeRequest(cookieStore, headerStore);
}

/**
 * Memoize the factory-built helpers by their resolved config so the in-process
 * JWKS cache inside `AtlasBackend` stays warm across calls — rebuilding a fresh
 * backend per `auth()` would throw that cache away and re-fetch the JWKS on
 * every render, defeating the whole point of edge-local verification.
 */
function cacheKey(options: AtlasMiddlewareOptions): string {
  return [options.jwksUrl, options.issuer, (options.previousIssuers ?? []).join(','), (options.authorizedParties ?? []).join(','), options.revocation ? 'revocation' : ''].join('\n');
}

let authHelperCache: { key: string; fn: ReturnType<typeof createAuthHelper> } | undefined;
function getAuthHelper(): ReturnType<typeof createAuthHelper> {
  const options = configFromEnv();
  const key = cacheKey(options);
  if (!authHelperCache || authHelperCache.key !== key) {
    authHelperCache = { key, fn: createAuthHelper(options) };
  }
  return authHelperCache.fn;
}

let currentUserHelperCache:
  | { key: string; fn: ReturnType<typeof createCurrentUserHelper> }
  | undefined;
function getCurrentUserHelper(): ReturnType<typeof createCurrentUserHelper> {
  const options = configFromEnv();
  const key = cacheKey(options);
  if (!currentUserHelperCache || currentUserHelperCache.key !== key) {
    currentUserHelperCache = { key, fn: createCurrentUserHelper(options) };
  }
  return currentUserHelperCache.fn;
}

/** What the pre-bound `auth()` resolves to — the same state + `has`/`protect` the
 *  factory helper returns. */
export type ServerAuth = Awaited<ReturnType<ReturnType<typeof createAuthHelper>>>;

/**
 * Clerk-parity `auth()` — no arguments. Reads cookies/headers from the ambient
 * `next/headers` request, verifies the session at the edge via the shared core,
 * and returns the same `AuthState & { has, protect }`. Config comes from the
 * environment (see {@link configFromEnv}). Signed-out is a plain state, not a
 * throw — call `.protect()` where anonymous access is a bug.
 */
export async function auth(): Promise<ServerAuth> {
  const helper = getAuthHelper();
  return helper(await edgeRequestFromContext());
}

/**
 * Clerk-parity `currentUser()` — no arguments. The signed-in user's profile from
 * the verified session claims (no round-trip), or `null` when signed out.
 */
export async function currentUser(): Promise<CurrentUser | null> {
  const helper = getCurrentUserHelper();
  return helper(await edgeRequestFromContext());
}

export interface CreateAtlasAuthOptions<L = undefined> {
  /** `'sid_list'` also refuses a session Atlas has revoked (sign-out elsewhere, a ban). Needs `ATLAS_SECRET_KEY` with `sessions:read`. Default: off. */
  revocation?: 'sid_list';
  /** A guest (anonymous) session: `'reject'` (default) answers null, `'allow'` passes it with `guest: true`. */
  guests?: 'reject' | 'allow';
  /**
   * Bind the verified claims to your own user row, e.g. `(claims) => link.resolve(claims)` with
   * `sqlUserLink` from `@atlasauth/backend/link`. The result is returned as `local`. An error it throws propagates:
   * a failed database call is not "signed out".
   */
  resolve?: (claims: SessionClaims) => L | Promise<L>;
}

/** A verified, signed-in request. */
export interface AtlasAuthResult<L = undefined> {
  userId: string;
  sessionId: string;
  orgId: string | null;
  orgRole: string | null;
  claims: SessionClaims;
  /** True for a guest session (only with `guests: 'allow'`). */
  guest: boolean;
  /** What `resolve` returned. */
  local: L;
}

export interface AtlasAuth<L = undefined> {
  /** The signed-in user of the ambient `next/headers` request, or null. Never throws for missing configuration. */
  auth(): Promise<AtlasAuthResult<L> | null>;
  /** The same for an explicit request (a route handler, a Request with a Bearer token or `__session` cookie). */
  verifyRequest(request: { headers: { get(name: string): string | null } }): Promise<AtlasAuthResult<L> | null>;
  /** The Backend API client from `ATLAS_SECRET_KEY`. Throws when that variable is missing. */
  readonly atlasApi: AtlasClient;
  /** True when `ATLAS_ISSUER` and `ATLAS_JWKS_URL` (and `ATLAS_SECRET_KEY` for `revocation`) are set. */
  configured(): boolean;
}

const backendCache = new Map<string, AtlasBackend>();

/**
 * One place that reads `ATLAS_ISSUER`, `ATLAS_JWKS_URL`, `ATLAS_PREVIOUS_ISSUERS` and `ATLAS_SECRET_KEY`
 * and gives a route or server component the signed-in user. With the variables missing (a preview build,
 * a fresh checkout) `auth()` answers null instead of throwing, so the page renders signed out.
 *
 * ```ts
 * export const { auth, verifyRequest, atlasApi } = createAtlasAuth({
 *   guests: 'reject',
 *   resolve: (claims) => link.resolve(claims),
 * });
 * ```
 */
export function createAtlasAuth<L = undefined>(options: CreateAtlasAuthOptions<L> = {}): AtlasAuth<L> {
  const settings = () => {
    const env = readEnv();
    const jwksUrl = pick(env, 'ATLAS_JWKS_URL', 'NEXT_PUBLIC_ATLAS_JWKS_URL');
    const issuer = pick(env, 'ATLAS_ISSUER', 'NEXT_PUBLIC_ATLAS_ISSUER');
    const secretKey = pick(env, 'ATLAS_SECRET_KEY');
    const previous = parseIssuerList(pick(env, 'ATLAS_PREVIOUS_ISSUERS', 'NEXT_PUBLIC_ATLAS_PREVIOUS_ISSUERS')) ?? [];
    const bapiBaseUrl = pick(env, 'ATLAS_API_BASE', 'ATLAS_API_URL', 'NEXT_PUBLIC_ATLAS_API_URL');
    return { jwksUrl, issuer, secretKey, previous, bapiBaseUrl };
  };
  const configured = () => {
    const c = settings();
    return Boolean(c.jwksUrl && c.issuer && (!options.revocation || c.secretKey));
  };

  async function verifyRequest(request: { headers: { get(name: string): string | null } }): Promise<AtlasAuthResult<L> | null> {
    if (!configured()) return null;
    const c = settings();
    const key = [c.jwksUrl, c.issuer, c.previous.join(','), options.revocation ? c.secretKey : ''].join('\n');
    let backend = backendCache.get(key);
    if (!backend) {
      backend = new AtlasBackend({
        jwksUrl: c.jwksUrl!,
        issuer: c.issuer!,
        previousIssuers: c.previous.length ? c.previous : undefined,
        ...(options.revocation ? { secretKey: c.secretKey, bapiBaseUrl: c.bapiBaseUrl } : {}),
      });
      backendCache.set(key, backend);
    }
    let state;
    try {
      state = await resolveAuth(backend, request as EdgeRequest, options.revocation ? {} : undefined);
    } catch {
      return null;
    }
    const claims = state.claims;
    if (!claims || !state.userId || !state.sessionId) return null;
    const guest = (claims as { anon?: unknown }).anon === true;
    if (guest && (options.guests ?? 'reject') === 'reject') return null;
    const local = (options.resolve ? await options.resolve(claims) : undefined) as L;
    return { userId: state.userId, sessionId: state.sessionId, orgId: state.orgId, orgRole: state.orgRole, claims, guest, local };
  }

  return {
    configured,
    verifyRequest,
    async auth() {
      if (!configured()) return null;
      let req: EdgeRequest;
      try {
        req = await edgeRequestFromContext();
      } catch {
        return null; // outside a request scope
      }
      return verifyRequest(req);
    },
    get atlasApi() {
      return atlasClient();
    },
  };
}

/**
 * The public values `<AtlasProvider>` needs, read from the server's environment
 * at render time. Call it in a Server Component and spread it into the client
 * component that renders the provider, so a key that exists only at runtime
 * (`ATLAS_PUBLISHABLE_KEY`, not inlined at build) still reaches the browser:
 *
 *   <AtlasClientProvider {...getAtlasPublicConfig()}>{children}</AtlasClientProvider>
 *
 * The publishable key is public by design. Never throws; a missing key logs one
 * console error naming the variables to set (and the provider then stays inert).
 */
export function getAtlasPublicConfig(env: Env = readEnv()): { publishableKey: string; frontendApi: string } {
  const publishableKey = pick(env, 'ATLAS_PUBLISHABLE_KEY', 'NEXT_PUBLIC_ATLAS_PUBLISHABLE_KEY') ?? '';
  const frontendApi = pick(env, 'ATLAS_FRONTEND_API', 'NEXT_PUBLIC_ATLAS_FRONTEND_API') ?? '';
  if (!publishableKey && typeof console !== 'undefined') {
    console.error(
      '[Atlas] getAtlasPublicConfig: no publishable key. Set ATLAS_PUBLISHABLE_KEY (read at runtime on the server) or NEXT_PUBLIC_ATLAS_PUBLISHABLE_KEY (inlined at build).',
    );
  }
  return { publishableKey, frontendApi };
}

/**
 * The instance's public sign-in data for `<AtlasProvider initialState>`: the
 * dashboard design and sign-in settings (`/v1/appearance`) and the sign-in
 * methods and social buttons (`/v1/client/environment`), fetched on the server so
 * the sign-in panel renders fully styled, with its social buttons, in the first
 * HTML. Call it in a Server Component (e.g. the root layout) and pass the result
 * to the client component that renders `<AtlasProvider>`.
 *
 * Both responses are public and the same for every visitor, so they are cached
 * with Next's data cache (`revalidate`, default 60 s). Never throws: a part that
 * can't be fetched within `timeoutMs` is left out and the browser fetches it.
 *
 * Reads `ATLAS_PUBLISHABLE_KEY` / `NEXT_PUBLIC_ATLAS_PUBLISHABLE_KEY` and
 * `ATLAS_FRONTEND_API` / `NEXT_PUBLIC_ATLAS_FRONTEND_API` unless given.
 */
export interface AtlasInitialState {
  appearance?: unknown;
  environment?: unknown;
}

export async function getAtlasInitialState(
  options: {
    publishableKey?: string;
    frontendApi?: string;
    /** Seconds Next may cache the responses. Default 60; `false` disables caching. */
    revalidate?: number | false;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  } = {},
  env: Env = readEnv(),
): Promise<AtlasInitialState> {
  const publishableKey =
    options.publishableKey ?? pick(env, 'ATLAS_PUBLISHABLE_KEY', 'NEXT_PUBLIC_ATLAS_PUBLISHABLE_KEY');
  const frontendApi = options.frontendApi ?? pick(env, 'ATLAS_FRONTEND_API', 'NEXT_PUBLIC_ATLAS_FRONTEND_API');
  const doFetch = options.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  if (!publishableKey || !frontendApi || !doFetch) return {};
  const base = frontendApi.replace(/\/+$/, '');
  const revalidate = options.revalidate ?? 60;
  const timeoutMs = options.timeoutMs ?? 1500;

  const get = async (path: string): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${base}${path}`, {
        headers: { accept: 'application/json', 'x-publishable-key': publishableKey },
        signal: controller.signal,
        ...(revalidate === false ? { cache: 'no-store' as const } : { next: { revalidate } }),
      } as RequestInit);
      return res.ok ? ((await res.json()) as unknown) : undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };

  const [appearance, environment] = await Promise.all([get('/v1/appearance'), get('/v1/client/environment')]);
  const state: AtlasInitialState = {};
  if (appearance && typeof appearance === 'object') state.appearance = appearance;
  if (environment && typeof environment === 'object') state.environment = environment;
  return state;
}

export type { AtlasClient, AtlasClientConfig } from '@atlasauth/backend';
export type { AuthState, CurrentUser, EdgeRequest } from './middleware';
export type { SessionClaims } from '@atlasauth/backend';

// The `beforeFirstSession` hook handler, so a route needs one import path.
export { createLinkHook } from '@atlasauth/backend';
export type { LinkHookOptions, LinkCandidate } from '@atlasauth/backend';

// The Frontend API path mount and its domain-verification file, for route handlers.
export { createMountHandler, createVerifyHandler } from './mount';
export type { AtlasMountHandlers, AtlasMountOptions } from './mount';

// The route handler behind `<SignIn exchange>`: verify the Atlas token, create your own session once per `sid`.
export { createSessionExchange } from './session-exchange';
export type { CreateSessionExchangeOptions, SessionExchangeResult, SessionExchangeStore } from './session-exchange';
