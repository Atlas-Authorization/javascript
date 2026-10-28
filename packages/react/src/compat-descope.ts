'use client';

/**
 * Drop-in helpers for apps moving to Atlas from Descope (`@descope/react-sdk`,
 * and the client half of `@descope/nextjs-sdk`).
 *
 * `atlas migrate code --from descope` rewrites `useSession()`, `useUser()`,
 * `useDescope()` and awaited `getSessionToken()` calls onto these, so the
 * migrated components keep reading the Descope shapes they were written against
 * (`{ isAuthenticated, isSessionLoading, sessionToken }`, `user.userId`,
 * `user.userTenants`, …). Each one is a projection over the `<AtlasProvider>`
 * state; move call sites to `useAuth()` / `useUser()` at your own pace.
 *
 * Where Atlas and Descope differ:
 *  - Descope's project-wide roles and permissions are Atlas app roles: they
 *    come from the session's `app_roles` / `app_permissions` claims. Tenant
 *    roles are organization roles: `userTenants` lists every membership (one
 *    role each); the claims' `tenants` holds the active organization.
 *  - `customAttributes` is the user's `publicMetadata`.
 *  - `useDescopeCompat()` only has `logout()` and `refresh()`; the codemod
 *    leaves every other `useDescope()` member for you to port.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAtlas } from './AtlasProvider';
import { getActiveAtlas } from './active-atlas';
import type { AtlasOrganizationMembership, AtlasUser, SessionClaims } from './types';

/** The user object Descope's `useUser()` returns (the fields apps read). */
export interface DescopeCompatUser {
  userId: string;
  loginIds: string[];
  email?: string;
  verifiedEmail: boolean;
  phone?: string;
  verifiedPhone: boolean;
  name?: string;
  givenName?: string;
  familyName?: string;
  picture?: string;
  roleNames: string[];
  userTenants: Array<{ tenantId: string; tenantName: string; roleNames: string[] }>;
  customAttributes: Record<string, unknown>;
}

/** Descope's session-token claims: `roles`, `permissions` and per-tenant `tenants`. */
export interface DescopeCompatClaims {
  sub: string;
  exp?: number;
  roles: string[];
  permissions: string[];
  tenants: Record<string, { roles: string[]; permissions: string[] }>;
  [claim: string]: unknown;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Project an Atlas user onto Descope's user shape: organization memberships
 * become `userTenants`, the session's app roles `roleNames`.
 */
export function descopeUserFrom(
  user: AtlasUser | null,
  memberships: readonly AtlasOrganizationMembership[] = [],
  claims: SessionClaims | null = null,
): DescopeCompatUser | undefined {
  if (!user) return undefined;
  const emails = user.email_addresses ?? [];
  const email = emails.find((e) => e.primary) ?? emails.find((e) => e.verified) ?? emails[0];
  const phones = user.phone_numbers ?? [];
  const phone = phones.find((p) => p.primary) ?? phones[0];
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  const out: DescopeCompatUser = {
    userId: user.id,
    loginIds: [email?.email_address, phone?.phone_number, user.username].filter((v): v is string => Boolean(v)),
    verifiedEmail: email?.verified ?? false,
    verifiedPhone: phone?.verified ?? false,
    roleNames: stringList(claims?.app_roles),
    userTenants: memberships.map((m) => ({
      tenantId: m.organization.id,
      tenantName: m.organization.name,
      roleNames: m.role ? [m.role] : [],
    })),
    customAttributes: { ...user.public_metadata },
  };
  if (email) out.email = email.email_address;
  if (phone) out.phone = phone.phone_number;
  if (name) out.name = name;
  if (user.first_name) out.givenName = user.first_name;
  if (user.last_name) out.familyName = user.last_name;
  if (user.image_url) out.picture = user.image_url;
  return out;
}

/**
 * Project Atlas session claims onto Descope's: top-level `roles` / `permissions`
 * are the app roles and their permissions (`app_roles` / `app_permissions`),
 * `tenants` holds the active organization's role and permissions.
 */
export function descopeClaimsFrom(claims: SessionClaims | null): DescopeCompatClaims | undefined {
  if (!claims) return undefined;
  const tenants: DescopeCompatClaims['tenants'] = {};
  if (claims.org_id) {
    tenants[claims.org_id] = {
      roles: claims.org_role ? [claims.org_role] : [],
      permissions: [...(claims.org_permissions ?? [])],
    };
  }
  return { ...claims, roles: stringList(claims.app_roles), permissions: stringList(claims.app_permissions), tenants };
}

/** The `exp` (unix seconds) of a JWT, or undefined when it cannot be read. */
function tokenExp(token: string): number | undefined {
  try {
    const payload = token.split('.')[1];
    if (!payload) return undefined;
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: unknown };
    return typeof json.exp === 'number' ? json.exp : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `useSession()` from Descope, on Atlas: `{ isAuthenticated, isSessionLoading,
 * isSessionFetched, sessionToken, claims }`. `sessionToken` is the Atlas session
 * JWT; Atlas session tokens are short-lived, so it is fetched again shortly
 * before each one expires. `isSessionLoading` stays true until the first token
 * is in hand, so a component that waits for it never sends `Bearer undefined`.
 */
export function useDescopeSessionCompat(): {
  isAuthenticated: boolean;
  isSessionLoading: boolean;
  isSessionFetched: boolean;
  sessionToken: string | undefined;
  claims: DescopeCompatClaims | undefined;
} {
  const atlas = useAtlas();
  const signedIn = atlas.status === 'signed_in';
  const [token, setToken] = useState<string | undefined>(undefined);
  // The latest getToken, without re-running the effect when its identity changes.
  const getToken = useRef(atlas.getToken);
  getToken.current = atlas.getToken;
  const sessionKey = signedIn ? `${atlas.user?.id ?? ''}:${atlas.claims?.sid ?? ''}` : '';

  useEffect(() => {
    if (!sessionKey) {
      setToken(undefined);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const next = await getToken.current().catch(() => null);
      if (cancelled) return;
      setToken(next ?? undefined);
      const exp = next ? tokenExp(next) : undefined;
      const wait = exp ? Math.max(5_000, exp * 1000 - Date.now() - 10_000) : 30_000;
      timer = setTimeout(() => void load(), wait);
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionKey]);

  return {
    isAuthenticated: signedIn,
    isSessionLoading: atlas.status === 'loading' || (signedIn && token === undefined),
    isSessionFetched: atlas.status !== 'loading',
    sessionToken: signedIn ? token : undefined,
    claims: signedIn ? descopeClaimsFrom(atlas.claims) : undefined,
  };
}

/** `useUser()` from Descope, on Atlas: `{ user, isUserLoading, isUserFetched }`. */
export function useDescopeUserCompat(): {
  user: DescopeCompatUser | undefined;
  isUserLoading: boolean;
  isUserFetched: boolean;
} {
  const atlas = useAtlas();
  return {
    user: atlas.status === 'signed_in' ? descopeUserFrom(atlas.user, atlas.memberships, atlas.claims) : undefined,
    isUserLoading: atlas.status === 'loading',
    isUserFetched: atlas.status !== 'loading',
  };
}

/**
 * `useDescope()` from Descope, on Atlas — the session members only: `logout()`
 * signs out (revoking the session) and `refresh()` reloads the session. Both
 * resolve `{ ok: true }` like the Descope SDK's responses. Stable across renders,
 * so it can sit in a `useCallback` dependency list as the Descope SDK did.
 */
export function useDescopeCompat(): {
  logout(): Promise<{ ok: true }>;
  refresh(): Promise<{ ok: true }>;
} {
  const { signOut, reload } = useAtlas();
  return useMemo(
    () => ({
      async logout() {
        await signOut();
        return { ok: true as const };
      },
      async refresh() {
        await reload();
        return { ok: true as const };
      },
    }),
    [signOut, reload],
  );
}

/**
 * `getSessionToken()` from Descope, on Atlas. Descope's is synchronous; Atlas
 * mints tokens asynchronously, so this resolves the token (`await` it). Like
 * Descope it yields an empty string when nobody is signed in, or when no
 * `<AtlasProvider>` is mounted.
 */
export async function getDescopeSessionTokenCompat(): Promise<string> {
  const atlas = getActiveAtlas();
  if (!atlas || atlas.status !== 'signed_in') return '';
  return (await atlas.getToken()) ?? '';
}
