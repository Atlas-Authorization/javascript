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
 *   3. SIGN-OUT — a successful `POST /v1/client/sessions/:id/revoke` (2xx, or
 *      404: already gone) of the session the stored token belongs to clears the
 *      token, so a sign-out actually drops the credential and a restart boots
 *      signed out. The clear is awaited before the response is handed back, so
 *      no later request can still carry the token. A FAILED revoke keeps it: the
 *      provider remembers the session as signed out (its tombstone) and re-tries
 *      the revoke in the background, which needs the token to authenticate.
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

    const revoked = revokedSessionId(input, init);
    if (revoked && token && (response.ok || response.status === 404) && tokenBelongsTo(token, revoked)) {
      try {
        await cache.clearToken(key);
      } catch {
        // A secure-store failure must not break the sign-out response.
      }
    }

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

const REVOKE_PATH = /\/v1\/client\/sessions\/([^/?#]+)\/revoke(?:[?#]|$)/;

/** The session id a `POST …/v1/client/sessions/:id/revoke` targets, else null. */
function revokedSessionId(input: RequestInfo | URL, init?: RequestInit): string | null {
  const isRequest = typeof Request !== 'undefined' && input instanceof Request;
  const method = (init?.method ?? (isRequest ? input.method : 'GET')).toUpperCase();
  if (method !== 'POST') return null;
  const url = isRequest ? input.url : String(input);
  const match = REVOKE_PATH.exec(url);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return match[1]!;
  }
}

/**
 * Whether the stored token is the revoked session's: its `sid` claim matches.
 * A token whose claims cannot be read is treated as the session's own (the
 * provider only revokes the session it is signed in to, or one it refuses).
 */
function tokenBelongsTo(token: string, sessionId: string): boolean {
  const payload = token.split('.')[1];
  const decode = (globalThis as { atob?: (s: string) => string }).atob;
  if (!payload || !decode) return true;
  try {
    const claims = JSON.parse(decode(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { sid?: unknown };
    return typeof claims.sid !== 'string' || claims.sid === sessionId;
  } catch {
    return true;
  }
}
