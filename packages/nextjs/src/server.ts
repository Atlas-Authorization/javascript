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
  createAtlasClient,
  type AtlasClient,
  type AtlasClientConfig,
} from '@atlasauth/backend';
import {
  createAuthHelper,
  createCurrentUserHelper,
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

  const publishableKey = pick(env, 'ATLAS_PUBLISHABLE_KEY', 'NEXT_PUBLIC_ATLAS_PUBLISHABLE_KEY');

  return { jwksUrl, issuer, authorizedParties, publishableKey };
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
  const apiUrl = pick(env, 'ATLAS_API_URL', 'NEXT_PUBLIC_ATLAS_API_URL');
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
    apiUrl: overrides.apiUrl ?? pick(env, 'ATLAS_API_URL', 'NEXT_PUBLIC_ATLAS_API_URL'),
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
  return [options.jwksUrl, options.issuer, (options.authorizedParties ?? []).join(',')].join('\n');
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
