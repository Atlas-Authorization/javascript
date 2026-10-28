'use client';

/**
 * Drop-in compatibility helpers for apps moving to Atlas from Auth.js (NextAuth),
 * Auth0 (auth0-react / nextjs-auth0), Supabase Auth, Better Auth, Okta (okta-react /
 * okta-auth-js), Kinde and Descope — and, in the modules re-exported at the end,
 * Firebase Auth, AWS Amplify (Cognito), MSAL (Azure AD B2C / Entra External ID),
 * Appwrite, PocketBase and Nhost.
 *
 * `atlas migrate code --from <vendor>` rewrites an app's imports onto these, so
 * the migrated code keeps the shapes it was written against (`{ data, status }`
 * from `useSession`, `{ isAuthenticated, user }` from `useAuth0`, …) and compiles
 * and runs on day one. Each helper is a thin projection over the native hooks
 * (`useUser`, `useAuth`); once migrated, move call sites to those at your own pace.
 *
 * The imperative helpers (`nextAuthSignOut()`, `getSupabaseUserCompat()`, …) work
 * outside React components too: they act on the `<AtlasProvider>` mounted on the
 * page. Calling one with no provider mounted throws a clear error.
 */
import { Fragment, createElement, useEffect, type ComponentType, type ReactNode } from 'react';
import { useAtlas } from './AtlasProvider';
import { navigateTo, withRedirect } from './components-shared';
import type { AtlasUser, SessionClaims } from './types';
import { getActiveAtlas, onActiveAtlasChange, requireActive, type ActiveAtlas, type AuthStatus, type GetTokenOptions } from './active-atlas';

export { getActiveAtlas, type ActiveAtlas } from './active-atlas';
export * from './compat-okta';
export * from './compat-kinde';
export * from './compat-descope';

// ---- shared user projection --------------------------------------------------

/** The primary email address, else the first verified one, else any. */
export function primaryEmail(user: AtlasUser | null): { address: string; verified: boolean } | null {
  const list = user?.email_addresses ?? [];
  const pick = list.find((e) => e.primary) ?? list.find((e) => e.verified) ?? list[0];
  return pick ? { address: pick.email_address, verified: pick.verified } : null;
}

/** A display name: first + last, else the username, else null. */
export function displayName(user: AtlasUser | null): string | null {
  if (!user) return null;
  const full = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return full || user.username || null;
}

function expiresIso(claims: SessionClaims | null): string {
  const exp = typeof claims?.exp === 'number' ? claims.exp * 1000 : Date.now() + 60_000;
  return new Date(exp).toISOString();
}

function signInUrlWith(options: { signInUrl?: string; redirectUrl?: string } = {}): string {
  return withRedirect(options.signInUrl ?? '/sign-in', options.redirectUrl);
}

/** Send the browser to your sign-in page, returning to `redirectUrl` afterwards. */
export function signInRedirect(options: { signInUrl?: string; redirectUrl?: string } = {}): void {
  navigateTo(signInUrlWith(options));
}

async function signOutThenGo(helper: string, returnTo: string | undefined | false): Promise<void> {
  await requireActive(helper).signOut();
  if (returnTo !== false) navigateTo(returnTo ?? '/');
}

// ---- Auth.js / NextAuth --------------------------------------------------------

/** The `session` object `next-auth`'s `useSession()` / `getSession()` resolve to. */
export interface NextAuthCompatSession {
  user: { id: string; name: string | null; email: string | null; image: string | null };
  expires: string;
}

export type NextAuthCompatStatus = 'loading' | 'authenticated' | 'unauthenticated';

/** Pure projection of the provider state onto next-auth's session shape. */
export function nextAuthSessionFrom(state: Pick<ActiveAtlas, 'status' | 'user' | 'claims'>): {
  data: NextAuthCompatSession | null;
  status: NextAuthCompatStatus;
} {
  if (state.status === 'loading') return { data: null, status: 'loading' };
  if (state.status !== 'signed_in' || !state.user) return { data: null, status: 'unauthenticated' };
  const email = primaryEmail(state.user);
  return {
    data: {
      user: {
        id: state.user.id,
        name: displayName(state.user),
        email: email?.address ?? null,
        image: state.user.image_url,
      },
      expires: expiresIso(state.claims),
    },
    status: 'authenticated',
  };
}

/** `useSession()` from `next-auth/react`, on Atlas: `{ data, status, update }`. */
export function useNextAuthSession(): {
  data: NextAuthCompatSession | null;
  status: NextAuthCompatStatus;
  update: () => Promise<NextAuthCompatSession | null>;
} {
  const atlas = useAtlas();
  const projected = nextAuthSessionFrom(atlas);
  return {
    ...projected,
    update: async () => {
      await atlas.reload();
      const now = getActiveAtlas() ?? atlas;
      return nextAuthSessionFrom(now).data;
    },
  };
}

/** `getSession()` from `next-auth/react` (client side): the current session or null. */
export async function getNextAuthSession(): Promise<NextAuthCompatSession | null> {
  return nextAuthSessionFrom(requireActive('getNextAuthSession')).data;
}

/**
 * `signIn()` from `next-auth/react`: opens your Atlas sign-in page. The provider
 * argument is accepted for compatibility; the sign-in page lists every enabled
 * method (render `<SocialSignInButton provider="github" />` to go straight to one).
 */
export async function nextAuthSignIn(
  _provider?: string,
  options: { callbackUrl?: string; redirectTo?: string; signInUrl?: string } = {},
): Promise<void> {
  signInRedirect({ signInUrl: options.signInUrl, redirectUrl: options.redirectTo ?? options.callbackUrl });
}

/** `signOut()` from `next-auth/react`: signs out, then goes to `callbackUrl` (default `/`). */
export async function nextAuthSignOut(
  options: { callbackUrl?: string; redirectTo?: string; redirect?: boolean } = {},
): Promise<void> {
  await signOutThenGo(
    'nextAuthSignOut',
    options.redirect === false ? false : (options.redirectTo ?? options.callbackUrl),
  );
}

// ---- Auth0 (auth0-react, nextjs-auth0 client) --------------------------------------

/** The OIDC-profile user `useAuth0()` / nextjs-auth0's `useUser()` expose. */
export interface Auth0CompatUser {
  sub: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  nickname?: string;
  picture?: string;
  email?: string;
  email_verified?: boolean;
  org_id?: string;
  [claim: string]: unknown;
}

/** Project an Atlas user onto the OIDC profile shape Auth0 SDKs return. */
export function auth0UserFrom(user: AtlasUser | null, claims: SessionClaims | null = null): Auth0CompatUser | undefined {
  if (!user) return undefined;
  const email = primaryEmail(user);
  const out: Auth0CompatUser = { sub: user.id };
  const name = displayName(user);
  if (name) out.name = name;
  if (user.first_name) out.given_name = user.first_name;
  if (user.last_name) out.family_name = user.last_name;
  if (user.username) out.nickname = user.username;
  if (user.image_url) out.picture = user.image_url;
  if (email) {
    out.email = email.address;
    out.email_verified = email.verified;
  }
  if (claims?.org_id) out.org_id = claims.org_id;
  return out;
}

/** `loginWithRedirect()` options this helper understands (others are ignored). */
export interface Auth0CompatLoginOptions {
  appState?: { returnTo?: string; [key: string]: unknown };
  /** Where your Atlas sign-in page lives (default `/sign-in`). */
  signInUrl?: string;
}

export interface Auth0CompatLogoutOptions {
  logoutParams?: { returnTo?: string; [key: string]: unknown };
  /** `false` skips the redirect, like auth0-react's `openUrl: false`. */
  openUrl?: false;
}

/** Thrown by `getAccessTokenSilently()` when nobody is signed in (Auth0's `login_required`). */
export class LoginRequiredError extends Error {
  readonly error = 'login_required';
  constructor() {
    super('Login required');
    this.name = 'LoginRequiredError';
  }
}

/** `useAuth0()` from `@auth0/auth0-react`, on Atlas. */
export function useAuth0Compat<TUser extends Auth0CompatUser = Auth0CompatUser>(): {
  isLoading: boolean;
  isAuthenticated: boolean;
  user: TUser | undefined;
  error: undefined;
  loginWithRedirect(options?: Auth0CompatLoginOptions): Promise<void>;
  logout(options?: Auth0CompatLogoutOptions): Promise<void>;
  getAccessTokenSilently(options?: GetTokenOptions): Promise<string>;
  getIdTokenClaims(): Promise<(SessionClaims & { __raw?: string }) | undefined>;
} {
  const atlas = useAtlas();
  return {
    isLoading: atlas.status === 'loading',
    isAuthenticated: atlas.status === 'signed_in',
    user: atlas.status === 'signed_in' ? (auth0UserFrom(atlas.user, atlas.claims) as TUser | undefined) : undefined,
    error: undefined,
    loginWithRedirect: async (options = {}) =>
      signInRedirect({ signInUrl: options.signInUrl, redirectUrl: options.appState?.returnTo }),
    logout: async (options = {}) => {
      await atlas.signOut();
      if (options.openUrl !== false) navigateTo(options.logoutParams?.returnTo ?? '/');
    },
    getAccessTokenSilently: async (options) => {
      const token = await atlas.getToken(options);
      if (!token) throw new LoginRequiredError();
      return token;
    },
    getIdTokenClaims: async () => atlas.claims ?? undefined,
  };
}

/** `useUser()` from `@auth0/nextjs-auth0/client` (v3) or `@auth0/nextjs-auth0` (v4). */
export function useAuth0UserCompat<TUser extends Auth0CompatUser = Auth0CompatUser>(): {
  user: TUser | undefined;
  error: undefined;
  isLoading: boolean;
  checkSession(): Promise<void>;
  invalidate(): Promise<void>;
} {
  const atlas = useAtlas();
  const refresh = async () => {
    await atlas.reload();
  };
  return {
    user: atlas.status === 'signed_in' ? (auth0UserFrom(atlas.user, atlas.claims) as TUser | undefined) : undefined,
    error: undefined,
    isLoading: atlas.status === 'loading',
    checkSession: refresh,
    invalidate: refresh,
  };
}

/**
 * `withAuthenticationRequired(Component, options)` from `@auth0/auth0-react` (and
 * nextjs-auth0's client `withPageAuthRequired`): renders the component only for a
 * signed-in user and sends everyone else to your sign-in page.
 */
export function withAuthenticationRequiredCompat<P extends object>(
  Component: ComponentType<P>,
  options: {
    onRedirecting?: () => ReactNode;
    returnTo?: string | (() => string);
    signInUrl?: string;
  } = {},
): ComponentType<P> {
  function Guarded(props: P) {
    const { status } = useAtlas();
    useEffect(() => {
      if (status !== 'signed_out') return;
      const returnTo =
        typeof options.returnTo === 'function'
          ? options.returnTo()
          : (options.returnTo ?? (typeof window === 'undefined' ? undefined : window.location.href));
      signInRedirect({ signInUrl: options.signInUrl, redirectUrl: returnTo });
    }, [status]);
    if (status === 'signed_in') return createElement(Component, props);
    return createElement(Fragment, null, options.onRedirecting?.() ?? null);
  }
  Guarded.displayName = `withAuthenticationRequired(${Component.displayName ?? Component.name ?? 'Component'})`;
  return Guarded;
}

// ---- Supabase Auth (client side) -------------------------------------------------

/** The `User` object `supabase.auth.getUser()` resolves to (the fields apps read). */
export interface SupabaseCompatUser {
  id: string;
  aud: 'authenticated';
  role: 'authenticated';
  email?: string;
  email_confirmed_at?: string;
  phone?: string;
  user_metadata: Record<string, unknown>;
  app_metadata: Record<string, unknown>;
}

export function supabaseUserFrom(user: AtlasUser | null): SupabaseCompatUser | null {
  if (!user) return null;
  const email = primaryEmail(user);
  const phone = (user.phone_numbers ?? []).find((p) => p.primary) ?? user.phone_numbers?.[0];
  const name = displayName(user);
  return {
    id: user.id,
    aud: 'authenticated',
    role: 'authenticated',
    ...(email ? { email: email.address } : {}),
    ...(email?.verified ? { email_confirmed_at: new Date(0).toISOString() } : {}),
    ...(phone ? { phone: phone.phone_number } : {}),
    user_metadata: {
      ...user.unsafe_metadata,
      ...(name ? { full_name: name, name } : {}),
      ...(user.image_url ? { avatar_url: user.image_url } : {}),
    },
    app_metadata: { ...user.public_metadata },
  };
}

type SupabaseResult<T> = { data: T; error: null };

/** `supabase.auth.getUser()` in the browser. */
export async function getSupabaseUserCompat(): Promise<SupabaseResult<{ user: SupabaseCompatUser | null }>> {
  const atlas = requireActive('getSupabaseUserCompat');
  return { data: { user: atlas.status === 'signed_in' ? supabaseUserFrom(atlas.user) : null }, error: null };
}

/** `supabase.auth.getSession()` in the browser; `access_token` is the Atlas session JWT. */
export async function getSupabaseSessionCompat(): Promise<
  SupabaseResult<{ session: { access_token: string; expires_at: number | undefined; user: SupabaseCompatUser } | null }>
> {
  const atlas = requireActive('getSupabaseSessionCompat');
  const user = atlas.status === 'signed_in' ? supabaseUserFrom(atlas.user) : null;
  const token = user ? await atlas.getToken() : null;
  if (!user || !token) return { data: { session: null }, error: null };
  return { data: { session: { access_token: token, expires_at: atlas.claims?.exp, user } }, error: null };
}

/** `useUser()` from `@supabase/auth-helpers-react`: the user, or null. */
export function useSupabaseUserCompat(): SupabaseCompatUser | null {
  const atlas = useAtlas();
  return atlas.status === 'signed_in' ? supabaseUserFrom(atlas.user) : null;
}

/** `useSession()` from `@supabase/auth-helpers-react`: `{ user, expires_at }`, or null. */
export function useSupabaseSessionCompat(): { user: SupabaseCompatUser; expires_at: number | undefined } | null {
  const atlas = useAtlas();
  const user = atlas.status === 'signed_in' ? supabaseUserFrom(atlas.user) : null;
  return user ? { user, expires_at: atlas.claims?.exp } : null;
}

/** `supabase.auth.signOut()` in the browser. */
export async function supabaseSignOutCompat(): Promise<{ error: null }> {
  await requireActive('supabaseSignOutCompat').signOut();
  return { error: null };
}

/** `supabase.auth.signInWithOAuth({ provider, options: { redirectTo } })`: opens your sign-in page. */
export async function supabaseSignInWithOAuthCompat(credentials: {
  provider?: string;
  options?: { redirectTo?: string; signInUrl?: string };
} = {}): Promise<{ data: { provider?: string; url: string }; error: null }> {
  const url = signInUrlWith({ signInUrl: credentials.options?.signInUrl, redirectUrl: credentials.options?.redirectTo });
  navigateTo(url);
  return { data: { provider: credentials.provider, url }, error: null };
}

/**
 * `supabase.auth.onAuthStateChange(callback)`: the callback fires with
 * `SIGNED_IN` / `SIGNED_OUT` / `USER_UPDATED` as the Atlas session changes.
 */
export function onSupabaseAuthStateChangeCompat(
  callback: (event: 'INITIAL_SESSION' | 'SIGNED_IN' | 'SIGNED_OUT' | 'USER_UPDATED', session: { user: SupabaseCompatUser } | null) => void,
): { data: { subscription: { unsubscribe(): void } } } {
  let last: { status: AuthStatus | null; user: AtlasUser | null } = { status: null, user: null };
  const listener = (atlas: ActiveAtlas | null) => {
    const status = atlas?.status ?? null;
    if (status === 'loading' || status === null) return;
    const current = status === 'signed_in' ? (atlas!.user ?? null) : null;
    let event: 'INITIAL_SESSION' | 'SIGNED_IN' | 'SIGNED_OUT' | 'USER_UPDATED' | null = null;
    if (last.status === null) event = 'INITIAL_SESSION';
    else if (status === 'signed_out') event = last.status === 'signed_in' ? 'SIGNED_OUT' : null;
    else if (last.status !== 'signed_in' || last.user?.id !== current?.id) event = 'SIGNED_IN';
    // Same user, new profile object: the provider reloaded the user.
    else if (current !== last.user) event = 'USER_UPDATED';
    last = { status, user: current };
    const mapped = supabaseUserFrom(current);
    if (event) callback(event, mapped ? { user: mapped } : null);
  };
  const unsubscribe = onActiveAtlasChange(listener);
  const current = getActiveAtlas();
  if (current) listener(current);
  return { data: { subscription: { unsubscribe } } };
}

// ---- Better Auth (client) -------------------------------------------------------------

/** The `{ user, session }` pair Better Auth's `useSession()` / `getSession()` return. */
export interface BetterAuthCompatSession {
  user: {
    id: string;
    email: string | null;
    emailVerified: boolean;
    name: string | null;
    image: string | null;
  };
  session: { id: string; userId: string; expiresAt: Date; activeOrganizationId: string | null };
}

export function betterAuthSessionFrom(state: Pick<ActiveAtlas, 'status' | 'user' | 'claims'>): BetterAuthCompatSession | null {
  if (state.status !== 'signed_in' || !state.user) return null;
  const email = primaryEmail(state.user);
  return {
    user: {
      id: state.user.id,
      email: email?.address ?? null,
      emailVerified: email?.verified ?? false,
      name: displayName(state.user),
      image: state.user.image_url,
    },
    session: {
      id: state.claims?.sid ?? '',
      userId: state.user.id,
      expiresAt: new Date(expiresIso(state.claims)),
      activeOrganizationId: state.claims?.org_id ?? null,
    },
  };
}

export interface BetterAuthCompatClientOptions {
  /** Where your Atlas sign-in page lives (default `/sign-in`). */
  signInUrl?: string;
  /** Where your Atlas sign-up page lives (default `/sign-up`). */
  signUpUrl?: string;
  /** Accepted (and ignored) so `createAuthClient({ baseURL })` call sites keep compiling. */
  baseURL?: string;
  [option: string]: unknown;
}

/**
 * `createAuthClient()` from `better-auth/react`, on Atlas. The returned object has
 * the same `useSession`, `getSession`, `signIn.social`, `signIn.email`, `signUp.email`
 * and `signOut` members. The sign-in/up members open your Atlas pages (Atlas
 * collects credentials on its own forms, never in app code).
 */
export function createBetterAuthCompatClient(options: BetterAuthCompatClientOptions = {}) {
  const goSignIn = (callbackURL?: string) => navigateTo(withRedirect(options.signInUrl ?? '/sign-in', callbackURL));
  const goSignUp = (callbackURL?: string) => navigateTo(withRedirect(options.signUpUrl ?? '/sign-up', callbackURL));
  const ok = <T,>(data: T) => ({ data, error: null });
  return {
    /** Type-only, like Better Auth's `authClient.$Infer.Session`. */
    $Infer: {} as { Session: BetterAuthCompatSession },
    useSession() {
      const atlas = useAtlas();
      return {
        data: betterAuthSessionFrom(atlas),
        isPending: atlas.status === 'loading',
        error: null,
        refetch: async () => {
          await atlas.reload();
        },
      };
    },
    async getSession() {
      return ok(betterAuthSessionFrom(requireActive('authClient.getSession')));
    },
    signIn: {
      async social(input: { provider?: string; callbackURL?: string } = {}) {
        goSignIn(input.callbackURL);
        return ok({ redirect: true });
      },
      async email(input: { callbackURL?: string } = {}) {
        goSignIn(input.callbackURL);
        return ok({ redirect: true });
      },
      async magicLink(input: { callbackURL?: string } = {}) {
        goSignIn(input.callbackURL);
        return ok({ redirect: true });
      },
      async passkey() {
        goSignIn();
        return ok({ redirect: true });
      },
    },
    signUp: {
      async email(input: { callbackURL?: string } = {}) {
        goSignUp(input.callbackURL);
        return ok({ redirect: true });
      },
    },
    async signOut(input: { fetchOptions?: { onSuccess?: () => void } } = {}) {
      await requireActive('authClient.signOut').signOut();
      input.fetchOptions?.onSuccess?.();
      return ok({ success: true });
    },
  };
}

// ---- Firebase, Amplify, MSAL, Appwrite, PocketBase, Nhost --------------------------
// Re-exported last: those modules read the shared projections defined above.
export * from './compat-firebase';
export * from './compat-amplify';
export * from './compat-msal';
export * from './compat-baas';
