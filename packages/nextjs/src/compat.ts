/**
 * `@atlasauth/nextjs/compat` — server-side drop-in helpers for Next.js apps moving
 * to Atlas from Auth.js (NextAuth), Auth0 (nextjs-auth0), Supabase Auth, Better
 * Auth, Kinde and Descope. `atlas migrate code --from <vendor>` rewrites imports onto these so the
 * migrated code keeps the shapes it was written against and runs on day one; move
 * call sites to `auth()` / `currentUser()` from `@atlasauth/nextjs/server` later.
 *
 * Everything here reads the verified Atlas session (cookies / Authorization
 * header) exactly as `auth()` does. Profile fields beyond the id (email, name)
 * come from the session claims, so they are present when the instance includes
 * the profile claims in its session token.
 */
import { atlasMiddleware, hasSignedInHint, type AtlasMiddlewareOptions, type CurrentUser, type EdgeRequest } from './middleware';
import { DEFAULT_SIGN_IN_URL } from './matcher';
import { atlasClient, auth, configFromEnv, currentUser, type ServerAuth } from './server';

export * from './compat-kinde';
export * from './compat-descope';

/** Routes the migrated middleware leaves public by default: the Atlas pages. */
export const COMPAT_PUBLIC_ROUTES: readonly string[] = ['/sign-in(.*)', '/sign-up(.*)'];

type NextLikeRequest = EdgeRequest & { url?: string };

/**
 * A ready-made Next.js `middleware` (14/15) built from the environment
 * (`ATLAS_JWKS_URL`, `ATLAS_ISSUER`, `ATLAS_PUBLISHABLE_KEY`). Every route the
 * middleware's `config.matcher` selects requires a session, except the Atlas
 * sign-in and sign-up pages (and any `publicRoutes` you pass). The environment is
 * read on the first request, not at import time.
 */
export function createAtlasMiddleware(
  options: Partial<AtlasMiddlewareOptions> = {},
): (request: NextLikeRequest) => Promise<unknown> {
  let middleware: ReturnType<typeof atlasMiddleware> | undefined;
  return async (request) => {
    if (!middleware) {
      const publicRoutes = [...COMPAT_PUBLIC_ROUTES, ...(options.publicRoutes ?? [])];
      middleware = atlasMiddleware({ ...configFromEnv(), ...options, publicRoutes });
    }
    const { NextResponse } = await import('next/server');
    return middleware(request, NextResponse as never);
  };
}

function withRedirect(url: string, redirectUrl?: string): string {
  if (!redirectUrl) return url;
  return `${url}${url.includes('?') ? '&' : '?'}redirect_url=${encodeURIComponent(redirectUrl)}`;
}

async function nextRedirect(url: string): Promise<never> {
  const { redirect } = await import('next/navigation');
  return redirect(url);
}

function expiresIso(state: Pick<ServerAuth, 'claims'>): string {
  const exp = typeof state.claims?.exp === 'number' ? state.claims.exp * 1000 : Date.now() + 60_000;
  return new Date(exp).toISOString();
}

function fullName(user: CurrentUser): string | null {
  return user.name ?? ([user.firstName, user.lastName].filter(Boolean).join(' ') || null);
}

/** Revoke the active session server-side (needs `ATLAS_SECRET_KEY`). */
async function revokeActiveSession(): Promise<void> {
  const state = await auth();
  if (state.sessionId) await atlasClient().sessions.revoke(state.sessionId);
}

function notFoundHandler(vendor: string) {
  return async () =>
    new Response(
      JSON.stringify({
        errors: [
          {
            code: 'MIGRATED_TO_ATLAS',
            message: `This ${vendor} auth route is no longer used: sign-in, sign-out and callbacks are handled by Atlas. Delete this route.`,
          },
        ],
      }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    );
}

// ---- Auth.js / NextAuth ----------------------------------------------------------

/** The session `getServerSession()` / v5 `auth()` resolve to. */
export interface NextAuthServerSession {
  user: { id: string; name: string | null; email: string | null; image: string | null };
  expires: string;
}

/** Pure projection, exported for tests and custom wiring. */
export function nextAuthServerSessionFrom(
  user: CurrentUser | null,
  state: Pick<ServerAuth, 'claims'>,
): NextAuthServerSession | null {
  if (!user) return null;
  return { user: { id: user.id, name: fullName(user), email: user.email, image: null }, expires: expiresIso(state) };
}

/**
 * `getServerSession(authOptions)` (v4) and `auth()` (v5) on Atlas. Arguments are
 * accepted and ignored, so existing call sites keep compiling.
 */
export async function getServerSessionCompat(..._ignored: unknown[]): Promise<NextAuthServerSession | null> {
  const [user, state] = await Promise.all([currentUser(), auth()]);
  return nextAuthServerSessionFrom(user, state);
}

/** Server-side `signIn()` (a v5 server action): redirects to the Atlas sign-in page. */
export async function nextAuthServerSignIn(
  _provider?: string,
  options: { redirectTo?: string; callbackUrl?: string; signInUrl?: string } = {},
): Promise<never> {
  return nextRedirect(withRedirect(options.signInUrl ?? DEFAULT_SIGN_IN_URL, options.redirectTo ?? options.callbackUrl));
}

/** Server-side `signOut()` (a v5 server action): revokes the session, then redirects. */
export async function nextAuthServerSignOut(
  options: { redirectTo?: string; redirect?: boolean } = {},
): Promise<void> {
  await revokeActiveSession();
  if (options.redirect !== false) await nextRedirect(options.redirectTo ?? '/');
}

/** `handlers` from v5 `NextAuth()`: the old `/api/auth/*` route now answers 404. */
export const nextAuthHandlersCompat = {
  GET: notFoundHandler('Auth.js'),
  POST: notFoundHandler('Auth.js'),
};

/**
 * `NextAuth(config)` on Atlas, for both shapes it is used in:
 *
 *  - v5 `auth.ts`: `export const { handlers, auth, signIn, signOut } = NextAuth(config)`
 *    — the destructured members are the compat helpers above, so every
 *    `import { auth } from '@/auth'` keeps working;
 *  - v4 route: `const handler = NextAuth(authOptions); export { handler as GET, handler as POST }`
 *    — the returned function answers the old `/api/auth/*` route with 404.
 *
 * The config is accepted and ignored: configure providers in the Atlas dashboard
 * and port `callbacks` to Atlas Actions, then delete it.
 */
export function nextAuthCompat(..._ignored: unknown[]) {
  const handler = notFoundHandler('Auth.js');
  return Object.assign(handler, {
    handlers: nextAuthHandlersCompat,
    auth: getServerSessionCompat,
    signIn: nextAuthServerSignIn,
    signOut: nextAuthServerSignOut,
    /** v5 `unstable_update`: Atlas sessions pick up profile changes on their own refresh. */
    unstable_update: async (..._args: unknown[]) => getServerSessionCompat(),
  });
}

// ---- Auth0 (nextjs-auth0) ---------------------------------------------------------------

/** The OIDC profile nextjs-auth0 puts on `session.user`. */
export interface Auth0ServerUser {
  sub: string;
  email?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  org_id?: string;
  [claim: string]: unknown;
}

export interface Auth0ServerSession {
  user: Auth0ServerUser;
  /** Unix seconds the Atlas session token expires at. */
  expiresAt?: number;
}

export function auth0SessionFrom(user: CurrentUser | null, state: Pick<ServerAuth, 'claims'>): Auth0ServerSession | null {
  if (!user) return null;
  const out: Auth0ServerUser = { sub: user.id };
  const name = fullName(user);
  if (user.email) out.email = user.email;
  if (name) out.name = name;
  if (user.firstName) out.given_name = user.firstName;
  if (user.lastName) out.family_name = user.lastName;
  if (user.orgId) out.org_id = user.orgId;
  return { user: out, ...(typeof state.claims?.exp === 'number' ? { expiresAt: state.claims.exp } : {}) };
}

/** `getSession()` from nextjs-auth0 (v3, App Router) on Atlas. */
export async function getAuth0SessionCompat(..._ignored: unknown[]): Promise<Auth0ServerSession | null> {
  const [user, state] = await Promise.all([currentUser(), auth()]);
  return auth0SessionFrom(user, state);
}

const UNAUTHORIZED = { error: 'not_authenticated', description: 'The user does not have an active session or is not authenticated' };

/**
 * `withApiAuthRequired(handler)`: an App Router route handler (or a Pages API
 * route, detected by its `res`) answers 401 unless a user is signed in.
 */
export function withApiAuthRequiredCompat<A extends unknown[], R>(handler: (...args: A) => R | Promise<R>) {
  return async (...args: A): Promise<R | Response | undefined> => {
    const state = await auth();
    if (state.userId) return handler(...args);
    const res = args[1] as { status?: (code: number) => { json: (body: unknown) => void } } | undefined;
    if (res && typeof res.status === 'function') {
      res.status(401).json(UNAUTHORIZED);
      return undefined;
    }
    return new Response(JSON.stringify(UNAUTHORIZED), { status: 401, headers: { 'content-type': 'application/json' } });
  };
}

/**
 * `withPageAuthRequired(Page, { returnTo })` for an App Router server component:
 * renders the page for a signed-in user, else redirects to the sign-in page.
 */
export function withPageAuthRequiredCompat<P extends object, R>(
  page: (props: P) => R | Promise<R>,
  options: { returnTo?: string | ((props: P) => string | Promise<string>); signInUrl?: string } = {},
) {
  return async (props: P): Promise<R> => {
    const state = await auth();
    if (state.userId) return page(props);
    const returnTo = typeof options.returnTo === 'function' ? await options.returnTo(props) : options.returnTo;
    return nextRedirect(withRedirect(options.signInUrl ?? DEFAULT_SIGN_IN_URL, returnTo));
  };
}

/** `handleAuth()` from nextjs-auth0 v3: the old `/api/auth/[auth0]` route now answers 404. */
export function handleAuthCompat(..._ignored: unknown[]) {
  return notFoundHandler('Auth0');
}

/** `withMiddlewareAuthRequired()` from `@auth0/nextjs-auth0/edge`. */
export function withMiddlewareAuthRequiredCompat(..._ignored: unknown[]) {
  return createAtlasMiddleware();
}

/**
 * `new Auth0Client()` from `@auth0/nextjs-auth0/server` (v4) on Atlas:
 * `getSession()`, `middleware(request)` and `getAccessToken()`.
 */
export class Auth0ClientCompat {
  private readonly mw = createAtlasMiddleware();

  constructor(_options: Record<string, unknown> = {}) {}

  getSession(..._ignored: unknown[]): Promise<Auth0ServerSession | null> {
    return getAuth0SessionCompat();
  }

  middleware(request: NextLikeRequest): Promise<unknown> {
    return this.mw(request);
  }

  /**
   * Atlas session tokens are verified by your own backend with the instance JWKS
   * (`AtlasBackend` from `@atlasauth/backend`); there is no separate access token
   * to fetch server-side. Read the session token from the request instead.
   */
  async getAccessToken(): Promise<never> {
    throw new Error(
      'Auth0ClientCompat.getAccessToken(): Atlas has no server-side access-token exchange. Send the session token (getToken() in the browser) to your API and verify it with @atlasauth/backend.',
    );
  }
}

// ---- Supabase Auth (server side) ----------------------------------------------------------

/** The `User` object `supabase.auth.getUser()` resolves to (the fields apps read). */
export interface SupabaseServerUser {
  id: string;
  aud: 'authenticated';
  role: 'authenticated';
  email?: string;
  user_metadata: Record<string, unknown>;
  app_metadata: Record<string, unknown>;
}

export function supabaseServerUserFrom(user: CurrentUser | null): SupabaseServerUser | null {
  if (!user) return null;
  const name = fullName(user);
  return {
    id: user.id,
    aud: 'authenticated',
    role: 'authenticated',
    ...(user.email ? { email: user.email } : {}),
    user_metadata: name ? { full_name: name, name } : {},
    app_metadata: user.orgId ? { org_id: user.orgId, org_role: user.orgRole } : {},
  };
}

/** `supabase.auth.getUser()` in a server component, route handler or server action. */
export async function getSupabaseUserCompat(): Promise<{ data: { user: SupabaseServerUser | null }; error: null }> {
  return { data: { user: supabaseServerUserFrom(await currentUser()) }, error: null };
}

/** `supabase.auth.getSession()` server-side. There is no raw token here; use getUser(). */
export async function getSupabaseSessionCompat(): Promise<{
  data: { session: { user: SupabaseServerUser; expires_at?: number } | null };
  error: null;
}> {
  const [user, state] = await Promise.all([currentUser(), auth()]);
  const mapped = supabaseServerUserFrom(user);
  return {
    data: {
      session: mapped
        ? { user: mapped, ...(typeof state.claims?.exp === 'number' ? { expires_at: state.claims.exp } : {}) }
        : null,
    },
    error: null,
  };
}

/** `supabase.auth.signOut()` server-side: revokes the active session. */
export async function supabaseSignOutCompat(): Promise<{ error: null }> {
  await revokeActiveSession();
  return { error: null };
}

// ---- Better Auth (server side) -------------------------------------------------------------

export interface BetterAuthServerSession {
  user: { id: string; email: string | null; name: string | null; image: string | null; emailVerified: boolean };
  session: { id: string; userId: string; expiresAt: Date; activeOrganizationId: string | null };
}

export function betterAuthServerSessionFrom(
  user: CurrentUser | null,
  state: Pick<ServerAuth, 'claims' | 'sessionId'>,
): BetterAuthServerSession | null {
  if (!user) return null;
  return {
    user: {
      id: user.id,
      email: user.email,
      name: fullName(user),
      image: null,
      // Present when the instance includes `email_verified` in its session claims.
      emailVerified: (state.claims as { email_verified?: unknown } | null)?.email_verified === true,
    },
    session: {
      id: state.sessionId ?? '',
      userId: user.id,
      expiresAt: new Date(expiresIso(state)),
      activeOrganizationId: user.orgId,
    },
  };
}

/**
 * `betterAuth({...})` on Atlas: the returned object keeps `auth.api.getSession()`,
 * `auth.api.signOut()` and `auth.handler`, so `lib/auth.ts` importers keep working.
 * The options are accepted and ignored: configure sign-in methods, providers and
 * plugins in the Atlas dashboard instead.
 */
export function createBetterAuthServerCompat(_options: Record<string, unknown> = {}) {
  return {
    /** Type-only, like Better Auth's `typeof auth.$Infer.Session`. */
    $Infer: {} as { Session: BetterAuthServerSession },
    api: {
      async getSession(_input?: { headers?: unknown }): Promise<BetterAuthServerSession | null> {
        const [user, state] = await Promise.all([currentUser(), auth()]);
        return betterAuthServerSessionFrom(user, state);
      },
      async signOut(_input?: { headers?: unknown }): Promise<{ success: boolean }> {
        await revokeActiveSession();
        return { success: true };
      },
    },
    handler: notFoundHandler('Better Auth'),
  };
}

/** `toNextJsHandler(auth)` from `better-auth/next-js`: the old route now answers 404. */
export function toNextJsHandlerCompat(..._ignored: unknown[]) {
  const handler = notFoundHandler('Better Auth');
  return { GET: handler, POST: handler, PATCH: handler, PUT: handler, DELETE: handler };
}

/**
 * `getSessionCookie(request)` from `better-auth/cookies`: a cheap, unverified
 * "probably signed in" check for middleware. Returns a non-empty marker when the
 * browser carries an Atlas session hint, else null. Never proof of identity; a
 * page that needs the user calls `auth()`.
 */
export function getSessionCookieCompat(request: EdgeRequest, ..._ignored: unknown[]): string | null {
  return hasSignedInHint(request) ? 'atlas' : null;
}
