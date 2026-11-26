import { getRequestHeader, getCookie, type H3Event } from 'h3';
import { atlasBackend } from './backend';
import { verifyCarriers, type AtlasAuth } from './auth';

export type { AtlasAuth } from './auth';
export { verifyCarriers, build } from './auth';
export { atlasBackend } from './backend';
export { atlasHandshake } from './handshake';

/**
 * Read the verified auth state for the current request — the server-route peer
 * of the client `useAuth()`.
 *
 * ```ts
 * export default defineEventHandler(async (event) => {
 *   const auth = await getAtlasAuth(event)
 *   auth.protect()                 // 401 if not signed in
 *   return { userId: auth.userId }
 * })
 * ```
 *
 * The result is memoized on `event.context.auth`, so the global middleware and
 * any number of handlers on the same request share ONE verification. The header
 * takes precedence over the `__session` cookie, matching `@atlasauth/backend`.
 */
export async function getAtlasAuth(event: H3Event): Promise<AtlasAuth> {
  if (event.context.auth) return event.context.auth;

  const backend = atlasBackend();
  const auth = await verifyCarriers(backend, {
    authorization: getRequestHeader(event, 'authorization') ?? null,
    // The suffixed name (an instance with cookie isolation) first, then the plain one.
    sessionCookie: (backend.cookieSuffix ? getCookie(event, backend.cookieName('__session')) : undefined) ?? getCookie(event, '__session') ?? null,
  });

  event.context.auth = auth;
  return auth;
}

declare module 'h3' {
  interface H3EventContext {
    /** The Atlas auth state resolved for this request by `@atlasauth/nuxt`. */
    auth?: AtlasAuth;
  }
}

// Rate limiting and grant usage (see ./limits).
export { atlasRateLimit, atlasGrantUsage, type AtlasLimitOptions, type GrantUsageCheck, type GrantUsageOptions, type RateLimitCheck, type RateLimiter, type LimitClaims, type LimitVerdict } from './limits';
