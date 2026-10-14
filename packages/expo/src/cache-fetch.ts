import type { TokenCache } from './token-cache';

/**
 * The bridge that makes `@atlasauth/react`'s cookie-based provider work on Expo.
 *
 * The web provider authenticates with an HttpOnly cookie (`credentials:
 * 'include'`) and reads the rotated `jwt` out of each `/v1/client*` response into
 * an in-memory cache. React Native has no cookie jar, so neither half survives on
 * its own:
 *
 *   1. REQUEST — attach the session token from the {@link TokenCache} as an
 *      `Authorization: Bearer` header, so an authenticated call is recognised
 *      without a cookie. The token is read FRESH on every call (never captured),
 *      so a refresh or sign-out between requests is always reflected.
 *   2. RESPONSE — when a JSON body carries a fresh `jwt`, persist it back to the
 *      cache so the rotated session survives an app restart. The web provider
 *      also keeps that jwt in memory for the tab's lifetime; this adds the
 *      durable copy native needs. Reading the body is done on a `clone()` so the
 *      provider still gets to consume the original.
 *
 * The persist is fire-and-forget: a secure-store write failure must not break a
 * live, already-parsed response.
 */
export function createCacheFetch(opts: {
  cache: TokenCache;
  key: string;
  fetchImpl: typeof fetch;
}): typeof fetch {
  const { cache, key, fetchImpl } = opts;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const token = (await cache.getToken(key)) ?? null;
    const headers = new Headers(init?.headers);
    if (token) headers.set('authorization', `Bearer ${token}`);

    const response = await fetchImpl(input, { ...init, headers });

    // Capture a rotated session token for persistence, without consuming the
    // body the caller still needs.
    const contentType = response.headers.get('content-type') ?? '';
    if (response.ok && contentType.includes('application/json')) {
      void (async () => {
        try {
          const body = (await response.clone().json()) as { jwt?: unknown };
          if (typeof body.jwt === 'string' && body.jwt) {
            await cache.saveToken(key, body.jwt);
          }
        } catch {
          // Not JSON, an empty body, or a secure-store write failure — the live
          // response is unaffected.
        }
      })();
    }

    return response;
  };
}
