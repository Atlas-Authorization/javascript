/**
 * Server-side drop-in helpers for Next.js apps moving to Atlas from Kinde
 * (`@kinde-oss/kinde-auth-nextjs`). Exported from `@atlasauth/nextjs/compat`.
 *
 * `atlas migrate code --from kinde` rewrites `getKindeServerSession()` to
 * {@link getKindeServerSessionCompat}, `withAuth` (and v1's `authMiddleware`) to
 * {@link kindeWithAuthCompat} and `handleAuth()` to {@link handleKindeAuthCompat},
 * so the migrated code keeps Kinde's shapes and runs on day one. Move call sites to
 * `auth()` / `currentUser()` from `@atlasauth/nextjs/server` at your own pace.
 *
 * Everything reads the verified Atlas session exactly as `auth()` does. Notes:
 *  - `getUser()` fills `email`, `given_name`, `family_name` (and `picture`,
 *    `username`, `phone_number` when present) from the session claims, so they are
 *    there when the instance includes the profile claims in its session token;
 *  - permissions are the session's organization permissions plus its app-level
 *    permissions; `orgCode` is the active Atlas organization id;
 *  - `getAccessToken()` / `getIdToken()` resolve the decoded Atlas session claims and
 *    the `…Raw()` variants the Atlas session JWT (Atlas has one session token);
 *  - `getUserOrganizations()` calls the Atlas Backend API, so it needs `ATLAS_SECRET_KEY`;
 *  - feature flags have no Atlas counterpart: the flag getters always return the
 *    default value you pass (the codemod marks every call site);
 *  - `refreshTokens()` does nothing: Atlas refreshes sessions on its own.
 */
import { createAtlasDecider, UNAUTHENTICATED_BODY, type EdgeRequest, type EdgeResponse } from './middleware';
import { DEFAULT_SIGN_IN_URL } from './matcher';
import { atlasClient, auth, configFromEnv, currentUser, type ServerAuth } from './server';

/** The user object Kinde's `getUser()` resolves to. */
export interface KindeCompatUser {
  id: string;
  email: string | null;
  given_name: string | null;
  family_name: string | null;
  picture: string | null;
  username: string | null;
  phone_number: string | null;
}

/** `getPermission(key)`. */
export interface KindeCompatPermission {
  isGranted: boolean;
  orgCode: string | null;
}

/** `getPermissions()`. */
export interface KindeCompatPermissions {
  permissions: string[];
  orgCode: string | null;
}

/** `getOrganization()`. `orgCode` is the Atlas organization id. */
export interface KindeCompatOrganization {
  orgCode: string | null;
  orgName: string | null;
}

/** `getUserOrganizations()`. */
export interface KindeCompatUserOrganizations {
  orgCodes: string[];
  orgs: Array<{ code: string; name: string | null }>;
}

/** `getClaim(name)`. */
export interface KindeCompatClaim {
  name: string;
  value: unknown;
}

/** `getFlag(code, defaultValue)`: always the default (Atlas has no feature flags). */
export interface KindeCompatFlag<T> {
  code: string;
  type: 'boolean' | 'string' | 'integer';
  value: T;
  is_default: true;
  defaultValue: T;
}

type Claims = Record<string, unknown>;

function claimString(claims: Claims | null, ...names: readonly string[]): string | null {
  for (const name of names) {
    const value = claims?.[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

/** Organization permissions plus app-level permissions, deduplicated. */
function heldPermissions(claims: Claims | null): string[] {
  const out = new Set<string>();
  for (const list of [claims?.org_permissions, claims?.app_permissions]) {
    if (!Array.isArray(list)) continue;
    for (const p of list) if (typeof p === 'string') out.add(p);
  }
  return [...out];
}

/** Pure projection of the Atlas session onto Kinde's user, exported for tests. */
export function kindeServerUserFrom(
  user: { id: string; email: string | null; firstName: string | null; lastName: string | null } | null,
  state: Pick<ServerAuth, 'claims'>,
): KindeCompatUser | null {
  if (!user) return null;
  const claims = state.claims as Claims | null;
  return {
    id: user.id,
    email: user.email,
    given_name: user.firstName,
    family_name: user.lastName,
    picture: claimString(claims, 'picture', 'image_url'),
    username: claimString(claims, 'preferred_username', 'username'),
    phone_number: claimString(claims, 'phone_number'),
  };
}

/** The raw session token of the current request (Bearer header, else the `__session` cookie). */
async function requestSessionToken(): Promise<string | null> {
  const { cookies, headers } = await import('next/headers');
  const header = (await headers()).get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return (await cookies()).get('__session')?.value ?? null;
}

function flagType(value: unknown): KindeCompatFlag<unknown>['type'] {
  return typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'integer' : 'string';
}

/**
 * `getKindeServerSession()` on Atlas, for server components, route handlers and
 * server actions. Arguments are accepted and ignored, so existing call sites keep
 * compiling. Every member is async, like Kinde's.
 */
export function getKindeServerSessionCompat(..._ignored: unknown[]) {
  const claimsOf = async (): Promise<Claims | null> => {
    const state = await auth();
    return state.userId ? (state.claims as Claims | null) : null;
  };
  const rawToken = async (): Promise<string | null> => ((await auth()).userId ? requestSessionToken() : null);
  return {
    isAuthenticated: async (): Promise<boolean> => Boolean((await auth()).userId),
    getUser: async (): Promise<KindeCompatUser | null> => {
      const [user, state] = await Promise.all([currentUser(), auth()]);
      return kindeServerUserFrom(user, state);
    },
    getOrganization: async (): Promise<KindeCompatOrganization | null> => {
      const state = await auth();
      if (!state.userId || !state.orgId) return null;
      return { orgCode: state.orgId, orgName: claimString(state.claims as Claims | null, 'org_name') };
    },
    /** Needs `ATLAS_SECRET_KEY` (reads the memberships from the Atlas Backend API). */
    getUserOrganizations: async (): Promise<KindeCompatUserOrganizations | null> => {
      const state = await auth();
      if (!state.userId) return null;
      const page = await atlasClient().users.listOrganizationMemberships(state.userId, { limit: 100 });
      const codes = page.data.map((m) => m.organization_id);
      return { orgCodes: codes, orgs: codes.map((code) => ({ code, name: null })) };
    },
    getPermission: async (key: string): Promise<KindeCompatPermission> => {
      const state = await auth();
      const held = state.userId ? heldPermissions(state.claims as Claims | null) : [];
      return { isGranted: held.includes(key), orgCode: state.userId ? state.orgId : null };
    },
    getPermissions: async (): Promise<KindeCompatPermissions> => {
      const state = await auth();
      return state.userId
        ? { permissions: heldPermissions(state.claims as Claims | null), orgCode: state.orgId }
        : { permissions: [], orgCode: null };
    },
    /** The active organization role, in Kinde's `{ id, key, name }` shape. */
    getRoles: async (): Promise<Array<{ id: string; key: string; name: string }> | null> => {
      const state = await auth();
      if (!state.userId) return null;
      return state.orgRole ? [{ id: state.orgRole, key: state.orgRole, name: state.orgRole }] : [];
    },
    getClaim: async (name: string, _tokenType?: string): Promise<KindeCompatClaim | null> => {
      const claims = await claimsOf();
      return claims ? { name, value: claims[name] ?? null } : null;
    },
    getAccessToken: claimsOf,
    getIdToken: claimsOf,
    getAccessTokenRaw: rawToken,
    getIdTokenRaw: rawToken,
    getFlag: async <T>(code: string, defaultValue: T, _type?: string): Promise<KindeCompatFlag<T>> => ({
      code,
      type: flagType(defaultValue),
      value: defaultValue,
      is_default: true,
      defaultValue,
    }),
    getBooleanFlag: async (_code: string, defaultValue?: boolean): Promise<boolean | undefined> => defaultValue,
    getStringFlag: async (_code: string, defaultValue?: string): Promise<string | undefined> => defaultValue,
    getIntegerFlag: async (_code: string, defaultValue?: number): Promise<number | undefined> => defaultValue,
    refreshTokens: async (): Promise<void> => undefined,
  };
}

// ---- middleware --------------------------------------------------------------------

/** Routes the migrated middleware leaves public by default: the Atlas pages. */
const ATLAS_PAGES: readonly string[] = ['/sign-in(.*)', '/sign-up(.*)'];

/** The `withAuth` options this helper understands (others are accepted and ignored). */
export interface KindeWithAuthOptions {
  /** Path prefixes reachable without a session (Kinde matches them as prefixes). */
  publicPaths?: readonly string[];
  /** Your own sign-in page (default `/sign-in`). */
  loginPage?: string;
  /**
   * Extra check for signed-in users. `token` is the Atlas session claims, with
   * Kinde's `permissions` (organization + app-level permissions) and `org_code`
   * filled in. Returning false (or throwing) sends the user to the sign-in page.
   */
  isAuthorized?: (input: { req: unknown; token: Claims }) => boolean | Promise<boolean>;
  [option: string]: unknown;
}

type NextLikeRequest = EdgeRequest & { url?: string };
type KindeMiddleware = (request: NextLikeRequest, event?: unknown) => Promise<unknown>;

function looksLikeRequest(value: unknown): value is NextLikeRequest {
  const v = value as { nextUrl?: unknown; headers?: { get?: unknown } } | null;
  return typeof v === 'object' && v !== null && typeof v.nextUrl === 'object' && typeof v.headers?.get === 'function';
}

function buildMiddleware(
  options: KindeWithAuthOptions,
  handler?: (request: NextLikeRequest, event?: unknown) => unknown,
): KindeMiddleware {
  let decide: ReturnType<typeof createAtlasDecider> | undefined;
  const signInUrl = options.loginPage ?? DEFAULT_SIGN_IN_URL;
  return async (request, event) => {
    if (!decide) {
      // Kinde matches publicPaths as prefixes. A bare '/' would open every route,
      // so it is kept as the home page only (fails closed).
      const publicRoutes = [...ATLAS_PAGES, ...(options.publicPaths ?? []).map((p) => (p === '/' ? '/' : `${p}(.*)`))];
      decide = createAtlasDecider({ ...configFromEnv(), publicRoutes, signInUrl });
    }
    const { NextResponse } = await import('next/server');
    const response = NextResponse as unknown as EdgeResponse;
    const decision = await decide(request);
    if (decision.kind === 'unauthorized') return response.json(UNAUTHENTICATED_BODY, { status: 401 });
    if (decision.kind === 'redirect') {
      const res = response.redirect(decision.location);
      for (const cookie of decision.cookies) res.cookies?.set(cookie.name, cookie.value, cookie.options);
      return res;
    }
    const { userId, orgId } = decision.auth;
    // A public route, or a visitor let through on the signed-in hint: nothing more to check.
    if (!userId) return response.next();
    const claims = (decision.auth.claims ?? {}) as Claims;
    const token: Claims = { ...claims, permissions: heldPermissions(claims), org_code: orgId };
    if (options.isAuthorized) {
      let allowed = false;
      try {
        allowed = await options.isAuthorized({ req: request, token });
      } catch {
        allowed = false;
      }
      if (!allowed) {
        const base = request.url ? new URL(request.url).origin : '';
        const back = `${request.nextUrl.pathname}${request.nextUrl.search ?? ''}`;
        return response.redirect(`${base}${signInUrl}?redirect_url=${encodeURIComponent(back)}`);
      }
    }
    if (handler) {
      (request as NextLikeRequest & { kindeAuth?: unknown }).kindeAuth = { user: { id: userId }, token };
      const out = await handler(request, event);
      if (out !== undefined && out !== null) return out;
    }
    return response.next();
  };
}

/**
 * `withAuth` from `@kinde-oss/kinde-auth-nextjs/middleware` (and v1's
 * `authMiddleware`) on Atlas, in every shape Kinde documents:
 *
 *  - `return withAuth(req)` inside your own middleware;
 *  - `export default withAuth` / `export default withAuth()`;
 *  - `export default withAuth(async function middleware(req) {…}, { publicPaths, loginPage, isAuthorized })`:
 *    your function runs for signed-in users, with `req.kindeAuth = { user, token }`.
 *
 * Every route your `config.matcher` selects needs a signed-in user, except the
 * Atlas sign-in / sign-up pages and your `publicPaths`. Config comes from the
 * environment (`ATLAS_JWKS_URL`, `ATLAS_ISSUER`), read on the first request.
 */
export function kindeWithAuthCompat(request: NextLikeRequest, event?: unknown): Promise<unknown>;
export function kindeWithAuthCompat(
  handler?: (request: NextLikeRequest & { kindeAuth?: unknown }, event?: unknown) => unknown,
  options?: KindeWithAuthOptions,
): KindeMiddleware;
export function kindeWithAuthCompat(options: KindeWithAuthOptions): KindeMiddleware;
export function kindeWithAuthCompat(...args: unknown[]): Promise<unknown> | KindeMiddleware {
  const [first, second] = args;
  if (looksLikeRequest(first)) return defaultMiddleware()(first, second);
  if (typeof first === 'function') {
    return buildMiddleware((second ?? {}) as KindeWithAuthOptions, first as (request: NextLikeRequest) => unknown);
  }
  return buildMiddleware((first ?? {}) as KindeWithAuthOptions);
}

let shared: KindeMiddleware | undefined;
function defaultMiddleware(): KindeMiddleware {
  shared ??= buildMiddleware({});
  return shared;
}

/** `handleAuth()` from Kinde: the old `/api/auth/[kindeAuth]` route now answers 404. */
export function handleKindeAuthCompat(..._ignored: unknown[]) {
  return async (..._args: unknown[]) =>
    new Response(
      JSON.stringify({
        errors: [
          {
            code: 'MIGRATED_TO_ATLAS',
            message:
              'This Kinde auth route is no longer used: sign-in, sign-out and callbacks are handled by Atlas. Delete this route.',
          },
        ],
      }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    );
}
