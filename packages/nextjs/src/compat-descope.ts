/**
 * Server-side drop-in for Next.js apps moving to Atlas from Descope
 * (`@descope/nextjs-sdk/server`). `atlas migrate code --from descope` rewrites
 * `session()` onto {@link descopeSessionCompat}, so server components and route
 * handlers keep reading `session.token.sub`, `session.token.roles` and
 * `session.jwt`; move them to `auth()` from `@atlasauth/nextjs/server` later.
 *
 * It reads the verified Atlas session exactly as `auth()` does. `token` keeps
 * every Atlas claim and adds Descope's names: `roles` / `permissions` are the
 * app roles and their permissions (`app_roles` / `app_permissions`), `tenants`
 * holds the active organization's role and permissions.
 */
import type { SessionClaims } from '@atlasauth/backend';
import { auth } from './server';

/** Descope's session-token claims as `session()` returns them under `token`. */
export interface DescopeServerClaims {
  sub: string;
  exp?: number;
  roles: string[];
  permissions: string[];
  tenants: Record<string, { roles: string[]; permissions: string[] }>;
  [claim: string]: unknown;
}

/** What Descope's `session()` resolves to: the raw session JWT and its claims. */
export interface DescopeServerSession {
  jwt: string;
  token: DescopeServerClaims;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Pure projection of verified Atlas claims onto Descope's, exported for tests and custom wiring. */
export function descopeServerClaimsFrom(claims: SessionClaims): DescopeServerClaims {
  const tenants: DescopeServerClaims['tenants'] = {};
  if (claims.org_id) {
    tenants[claims.org_id] = {
      roles: claims.org_role ? [claims.org_role] : [],
      permissions: [...(claims.org_permissions ?? [])],
    };
  }
  return { ...claims, roles: stringList(claims.app_roles), permissions: stringList(claims.app_permissions), tenants };
}

/** The session token `auth()` verified: the bearer header first, else the `__session` cookie. */
async function sessionJwt(): Promise<string> {
  const { cookies, headers } = await import('next/headers');
  const header = (await headers()).get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return (await cookies()).get('__session')?.value ?? '';
}

/**
 * `session()` from `@descope/nextjs-sdk/server` on Atlas: `{ jwt, token }` for a
 * signed-in user, `undefined` otherwise. Arguments (Descope's optional config)
 * are accepted and ignored, so existing call sites keep compiling.
 */
export async function descopeSessionCompat(..._ignored: unknown[]): Promise<DescopeServerSession | undefined> {
  const state = await auth();
  if (!state.userId || !state.claims) return undefined;
  return { jwt: await sessionJwt(), token: descopeServerClaimsFrom(state.claims) };
}
