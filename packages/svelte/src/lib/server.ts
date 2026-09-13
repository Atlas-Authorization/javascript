import {
  AtlasBackend,
  ForbiddenError,
  evaluate,
  hasFromClaims,
  type ProtectCondition,
  type SessionClaims,
} from '@atlasauth/backend';

/**
 * §10.1 SvelteKit server helper — the peer of the Next.js middleware `auth()`.
 *
 * Verifies the session JWT LOCALLY at the edge (§7.3): the JWKS is cached
 * in-process by `@atlasauth/backend`, so a warm server verifies with no network at
 * all. A helper that called Atlas on every request would make Atlas's latency
 * the app's.
 *
 * Types for SvelteKit's `Handle` / `RequestEvent` are kept structural so this
 * module does not need `@sveltejs/kit` at build time — `@sveltejs/kit` is an
 * optional peer.
 */

export interface AtlasServerOptions {
  /** The instance's JWKS URL. */
  jwksUrl: string;
  /** Expected `iss`. Required — an unchecked issuer accepts any Atlas instance. */
  issuer: string;
  /** §7.3 optional azp allowlist: refuse a token minted for a different origin. */
  authorizedParties?: readonly string[];
  /** Cookie the session JWT rides in. Defaults to `__session`. */
  cookieName?: string;
  fetchImpl?: typeof fetch;
}

/** The resolved auth state, plus the `has`/`protect` helpers bound to its claims. */
export interface ServerAuth {
  userId: string | null;
  sessionId: string | null;
  orgId: string | null;
  orgRole: string | null;
  claims: SessionClaims | null;
  isSignedIn: boolean;
  /** True when the claims satisfy the condition (empty condition = "signed in"). */
  has(condition?: ProtectCondition): boolean;
  /**
   * Assert access, throwing `ForbiddenError` when unmet — map it to a 401/403 in
   * a `load` or endpoint. With no argument it asserts signed-in.
   */
  protect(condition?: ProtectCondition): asserts this is ServerAuth & { userId: string };
}

const SIGNED_OUT = {
  userId: null,
  sessionId: null,
  orgId: null,
  orgRole: null,
  claims: null,
} as const;

/** Minimal structural shapes for the bits of SvelteKit this helper touches. */
interface KitCookies {
  get(name: string): string | undefined;
}
interface KitRequestEvent {
  request: { headers: { get(name: string): string | null } };
  cookies: KitCookies;
  locals: Record<string, unknown> & { auth?: ServerAuth };
}
type KitResolve = (event: KitRequestEvent) => unknown | Promise<unknown>;
type KitHandle = (input: { event: KitRequestEvent; resolve: KitResolve }) => unknown | Promise<unknown>;

function bind(state: typeof SIGNED_OUT | (Omit<ServerAuth, 'has' | 'protect' | 'isSignedIn'>)): ServerAuth {
  const claims = state.claims;
  return {
    ...state,
    isSignedIn: state.userId !== null,
    has(condition: ProtectCondition = {}) {
      return hasFromClaims(claims, condition);
    },
    protect(condition: ProtectCondition = {}) {
      const outcome = evaluate(claims, condition);
      if (!outcome.allowed) throw new ForbiddenError(outcome.reason, condition);
    },
  };
}

/**
 * Verify the request's session and return the auth state. Never throws on a bad
 * token — an unverifiable token is treated as signed-out (which degrades to the
 * sign-in screen), never a 500 that takes the page down.
 */
export async function resolveServerAuth(
  backend: AtlasBackend,
  event: KitRequestEvent,
  cookieName = '__session',
): Promise<ServerAuth> {
  const header = event.request.headers.get('authorization');
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  const token = bearer ?? event.cookies.get(cookieName);
  if (!token) return bind(SIGNED_OUT);

  const result = await backend.verify(token);
  if (!result.ok) return bind(SIGNED_OUT);

  return bind({
    userId: result.claims.sub,
    sessionId: result.claims.sid,
    orgId: result.claims.org_id ?? null,
    orgRole: result.claims.org_role ?? null,
    claims: result.claims,
  });
}

/**
 * A SvelteKit `handle` that resolves the session once per request and stashes it
 * on `event.locals.auth`, so every `load` and endpoint reads a verified session
 * without re-verifying.
 *
 * ```ts
 * // src/hooks.server.ts
 * import { handleAtlas } from '@atlasauth/svelte/server';
 * export const handle = handleAtlas({
 *   jwksUrl: 'https://<instance>.atlas.dev/.well-known/jwks.json',
 *   issuer: 'https://<instance>.atlas.dev',
 * });
 * ```
 */
export function handleAtlas(options: AtlasServerOptions): KitHandle {
  const backend = new AtlasBackend({
    jwksUrl: options.jwksUrl,
    issuer: options.issuer,
    authorizedParties: options.authorizedParties,
    fetchImpl: options.fetchImpl,
  });

  return async ({ event, resolve }) => {
    event.locals.auth = await resolveServerAuth(backend, event, options.cookieName ?? '__session');
    return resolve(event);
  };
}

/**
 * Read the auth state a prior {@link handleAtlas} put on `event.locals`.
 *
 * ```ts
 * // +layout.server.ts / +page.server.ts
 * import { getServerAuth } from '@atlasauth/svelte/server';
 * export const load = (event) => {
 *   const { userId, isSignedIn } = getServerAuth(event);
 *   return { userId, isSignedIn };
 * };
 * ```
 */
export function getServerAuth(event: { locals: { auth?: ServerAuth } }): ServerAuth {
  return event.locals.auth ?? bind(SIGNED_OUT);
}

export { ForbiddenError, type ProtectCondition, type SessionClaims };
