'use client';

/**
 * Drop-in helpers for apps moving to Atlas from Kinde (`@kinde-oss/kinde-auth-react`
 * and the browser side of `@kinde-oss/kinde-auth-nextjs`).
 *
 * `atlas migrate code --from kinde` rewrites `useKindeAuth()` to
 * {@link useKindeAuthCompat} and `useKindeBrowserClient()` to
 * {@link useKindeBrowserClientCompat}, so call sites keep the Kinde shapes
 * (`user.given_name`, `getPermission(key).isGranted`, `organization.orgCode`, …)
 * and run on day one. Both are thin projections over the `<AtlasProvider>` state;
 * move call sites to `useUser()` / `useAuth()` / `useOrganization()` at your own pace.
 *
 * What maps, and how:
 *  - the user → Kinde's `{ id, email, given_name, family_name, picture, username, phone_number }`;
 *  - permissions → the session's organization permissions plus its app-level
 *    permissions (`org_permissions` / `app_permissions` claims);
 *  - the organization → the active Atlas organization (`orgCode` is its id);
 *  - `accessToken` / `getAccessToken()` → the decoded Atlas session claims, and the
 *    raw token is the Atlas session JWT;
 *  - feature flags have no Atlas counterpart: the flag getters always return the
 *    default value you pass (the codemod marks every call site).
 *
 * Every getter works with or without `await`, so code written for either the
 * synchronous (v4) or the asynchronous (v5) Kinde React API keeps working.
 */
import { useEffect, useState } from 'react';
import { useAtlas } from './AtlasProvider';
import { navigateTo, withRedirect } from './components-shared';
import type { AuthStatus } from './active-atlas';
import type { AtlasOrganizationMembership, AtlasUser, SessionClaims } from './types';

/** The user object Kinde's `getUser()` / `user` expose. */
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

/** `getPermissions()` / `permissions`. */
export interface KindeCompatPermissions {
  permissions: string[];
  orgCode: string | null;
}

/** `getOrganization()` / `organization`. `orgCode` is the Atlas organization id. */
export interface KindeCompatOrganization {
  orgCode: string | null;
  orgName: string | null;
}

/** `getUserOrganizations()` / `userOrganizations`. */
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

/** The provider state the projections read. */
export interface KindeCompatState {
  status: AuthStatus;
  user: AtlasUser | null;
  claims: SessionClaims | null;
  memberships?: AtlasOrganizationMembership[];
}

/** Project an Atlas user onto Kinde's user shape. */
export function kindeUserFrom(user: AtlasUser | null): KindeCompatUser | null {
  if (!user) return null;
  const emails = user.email_addresses ?? [];
  const email = emails.find((e) => e.primary) ?? emails.find((e) => e.verified) ?? emails[0];
  const phones = user.phone_numbers ?? [];
  const phone = phones.find((p) => p.primary) ?? phones[0];
  return {
    id: user.id,
    email: email?.email_address ?? null,
    given_name: user.first_name,
    family_name: user.last_name,
    picture: user.image_url,
    username: user.username,
    phone_number: phone?.phone_number ?? null,
  };
}

/** Organization permissions plus app-level permissions, deduplicated. */
function heldPermissions(claims: SessionClaims | null): string[] {
  const out = new Set<string>();
  for (const list of [claims?.org_permissions, claims?.app_permissions]) {
    if (!Array.isArray(list)) continue;
    for (const p of list) if (typeof p === 'string') out.add(p);
  }
  return [...out];
}

function flagType(value: unknown): KindeCompatFlag<unknown>['type'] {
  return typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'integer' : 'string';
}

/** The flag getters: Atlas has no feature flags, so each returns the default it is given. */
function flagGetters() {
  return {
    getFlag<T>(code: string, defaultValue: T, _type?: string): KindeCompatFlag<T> {
      return { code, type: flagType(defaultValue), value: defaultValue, is_default: true, defaultValue };
    },
    getBooleanFlag(_code: string, defaultValue?: boolean): boolean | undefined {
      return defaultValue;
    },
    getStringFlag(_code: string, defaultValue?: string): string | undefined {
      return defaultValue;
    },
    getIntegerFlag(_code: string, defaultValue?: number): number | undefined {
      return defaultValue;
    },
  };
}

/**
 * Pure projection of the provider state onto the members `useKindeAuth()` and
 * `useKindeBrowserClient()` share. Exported for tests and custom wiring.
 */
export function kindeSessionFrom(state: KindeCompatState) {
  const signedIn = state.status === 'signed_in';
  const claims = signedIn ? state.claims : null;
  const orgCode = claims?.org_id ?? null;
  const memberships = signedIn ? (state.memberships ?? []) : [];
  const active = memberships.find((m) => m.organization.id === orgCode) ?? null;
  const user = signedIn ? kindeUserFrom(state.user) : null;
  const permissions: KindeCompatPermissions = { permissions: heldPermissions(claims), orgCode };
  const organization: KindeCompatOrganization | null = orgCode
    ? { orgCode, orgName: active?.organization.name ?? null }
    : null;
  const userOrganizations: KindeCompatUserOrganizations | null = signedIn
    ? {
        orgCodes: memberships.map((m) => m.organization.id),
        orgs: memberships.map((m) => ({ code: m.organization.id, name: m.organization.name })),
      }
    : null;
  return {
    isLoading: state.status === 'loading',
    isAuthenticated: signedIn,
    user,
    permissions,
    organization,
    userOrganizations,
    /** The decoded Atlas session claims (Kinde's decoded access token). */
    accessToken: claims,
    getUser: (): KindeCompatUser | null => user,
    getPermission: (key: string): KindeCompatPermission => ({
      isGranted: permissions.permissions.includes(key),
      orgCode,
    }),
    getPermissions: (): KindeCompatPermissions => permissions,
    getOrganization: (): KindeCompatOrganization | null => organization,
    getUserOrganizations: (): KindeCompatUserOrganizations | null => userOrganizations,
    getAccessToken: (): SessionClaims | null => claims,
    /** A claim of the Atlas session token, as `{ name, value }`; null when signed out. */
    getClaim: (name: string, _tokenType?: string): KindeCompatClaim | null =>
      claims ? { name, value: claims[name] ?? null } : null,
    ...flagGetters(),
  };
}

/** Options `login()` / `register()` understand (others are accepted and ignored). */
export interface KindeCompatLoginOptions {
  app_state?: { redirectTo?: string; [key: string]: unknown };
  redirectURL?: string;
  post_login_redirect_url?: string;
  /** Where your Atlas sign-in page lives (default `/sign-in`). */
  signInUrl?: string;
  /** Where your Atlas sign-up page lives (default `/sign-up`). */
  signUpUrl?: string;
  [option: string]: unknown;
}

function returnPath(options: KindeCompatLoginOptions): string | undefined {
  return options.app_state?.redirectTo ?? options.redirectURL ?? options.post_login_redirect_url;
}

/**
 * `useKindeAuth()` from `@kinde-oss/kinde-auth-react`, on Atlas. `login()` and
 * `register()` open your Atlas sign-in / sign-up pages; `logout(url?)` signs out
 * and goes to `url` (default `/`); `getToken()` resolves the Atlas session JWT.
 */
export function useKindeAuthCompat() {
  const atlas = useAtlas();
  return {
    ...kindeSessionFrom(atlas),
    error: undefined,
    login: async (options: KindeCompatLoginOptions = {}): Promise<void> =>
      navigateTo(withRedirect(options.signInUrl ?? '/sign-in', returnPath(options))),
    register: async (options: KindeCompatLoginOptions = {}): Promise<void> =>
      navigateTo(withRedirect(options.signUpUrl ?? '/sign-up', returnPath(options))),
    logout: async (options?: string | { redirectUrl?: string; returnTo?: string }): Promise<void> => {
      await atlas.signOut();
      const to = typeof options === 'string' ? options : (options?.redirectUrl ?? options?.returnTo);
      navigateTo(to ?? '/');
    },
    getToken: async (): Promise<string | undefined> => (await atlas.getToken()) ?? undefined,
  };
}

/**
 * `useKindeBrowserClient()` from `@kinde-oss/kinde-auth-nextjs`, on Atlas.
 * `accessTokenRaw` / `getToken()` hold the latest Atlas session JWT (null until the
 * first one is fetched); for a request, prefer `await useAuth().getToken()`, which
 * is always fresh. `refreshData()` reloads the user and session.
 */
export function useKindeBrowserClientCompat() {
  const atlas = useAtlas();
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    if (atlas.status !== 'signed_in') {
      setToken(null);
      return;
    }
    let live = true;
    void atlas.getToken().then(
      (t) => live && setToken(t),
      () => live && setToken(null),
    );
    return () => {
      live = false;
    };
  }, [atlas.status, atlas.claims]);
  return {
    ...kindeSessionFrom(atlas),
    error: null,
    accessTokenRaw: token,
    accessTokenEncoded: token,
    getAccessTokenRaw: (): string | null => token,
    getToken: (): string | null => token,
    refreshData: async (): Promise<void> => {
      await atlas.reload();
    },
  };
}
