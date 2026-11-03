/**
 * The "dev browser": sign-in on a development instance from an app on
 * `localhost`.
 *
 * The session lives in cookies on the instance's Frontend API host. From
 * `localhost` that host is cross-site, so a browser that blocks third-party
 * cookies (Chrome, Safari) drops them: the sign-in completes, then the next
 * boot finds no session. On a development instance (a `pk_test_` key) the SDK
 * therefore also keeps the session's refresh token in `localStorage` and
 * presents it as `x-refresh-token`, which development instances accept in
 * place of the cookie. Production keys never do this: a token readable by
 * page scripts is fine for local development, not for real users.
 *
 * {@link withDevBrowser} wraps a `fetch`, so every Frontend API caller (the
 * FAPI client and each framework provider) behaves the same:
 *  - `POST /v1/client/tickets/exchange` asks for the refresh token
 *    (`return_refresh_token: true`) and keeps it;
 *  - `GET /v1/client` and `POST /v1/client/sessions/:id/tokens` present it;
 *    the rotated token a refresh returns replaces it;
 *  - a boot that finds no session, a refused refresh, or a sign-out forgets it.
 * The cookies are still set and sent where the browser allows them; the
 * header is only read when there is no cookie.
 */

const STORAGE_PREFIX = '__atlas_dev_session:';
const EXCHANGE = '/v1/client/tickets/exchange';
const BOOT = '/v1/client';
const REFRESH = /^\/v1\/client\/sessions\/[^/]+\/tokens$/;
const REVOKE = /^\/v1\/client\/sessions\/[^/]+\/revoke$/;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * Where the dev-browser refresh token is kept: `local` (default, survives restarts and is shared
 * by every tab), `session` (this tab only) or `memory` (this page load only, nothing written).
 */
export type PersistenceMode = 'local' | 'session' | 'memory';

const memory = new Map<string, string>();
const memoryStore: Store = {
  getItem: (k) => memory.get(k) ?? null,
  setItem: (k, v) => void memory.set(k, v),
  removeItem: (k) => void memory.delete(k),
};

let mode: PersistenceMode = 'local';

/** Choose the storage for this page. The FAPI client calls it from its `persistence` option. */
export function setPersistence(next: PersistenceMode | undefined): void {
  mode = next ?? 'local';
}

/** The storage in force (`local` unless set). Exposed for tests. */
export function getPersistence(): PersistenceMode {
  return mode;
}

function storage(): Store | null {
  if (mode === 'memory') return memoryStore;
  try {
    const g = globalThis as { localStorage?: Store; sessionStorage?: Store };
    const s = mode === 'session' ? g.sessionStorage : g.localStorage;
    return s && typeof s.getItem === 'function' ? s : null;
  } catch {
    return null;
  }
}

/** Whether the dev browser applies: a development instance's key, in a browser with storage. */
export function devBrowserEnabled(publishableKey: string): boolean {
  return publishableKey.startsWith('pk_test_') && storage() !== null;
}

/** The stored refresh token for a development instance, or null. */
export function devBrowserToken(publishableKey: string): string | null {
  try {
    return storage()?.getItem(STORAGE_PREFIX + publishableKey) ?? null;
  } catch {
    return null;
  }
}

const SESSION_SUFFIX = ':sid';

function remember(publishableKey: string, token: unknown, sessionId: unknown): void {
  if (typeof token !== 'string' || !token) return;
  try {
    storage()?.setItem(STORAGE_PREFIX + publishableKey, token);
    if (typeof sessionId === 'string' && sessionId) storage()?.setItem(STORAGE_PREFIX + publishableKey + SESSION_SUFFIX, sessionId);
  } catch {
    // Storage full or blocked: the cookie path still works where the browser allows it.
  }
}

function storedSessionId(publishableKey: string): string | null {
  try {
    return storage()?.getItem(STORAGE_PREFIX + publishableKey + SESSION_SUFFIX) ?? null;
  } catch {
    return null;
  }
}

/** Forget the stored refresh token (sign-out; tests). */
export function forgetDevBrowserToken(publishableKey: string): void {
  try {
    storage()?.removeItem(STORAGE_PREFIX + publishableKey);
    storage()?.removeItem(STORAGE_PREFIX + publishableKey + SESSION_SUFFIX);
  } catch {
    // nothing to forget
  }
}

function pathOf(input: RequestInfo | URL): string | null {
  try {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return new URL(url, 'https://invalid.example').pathname;
  } catch {
    return null;
  }
}

/** The session id in `/v1/client/sessions/:id/…`. */
function sessionIdIn(path: string): string | null {
  const m = /^\/v1\/client\/sessions\/([^/]+)\//.exec(path);
  return m ? decodeURIComponent(m[1]!) : null;
}

async function bodyOf(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const b = (await response.clone().json()) as unknown;
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * `fetchImpl` with the dev browser for `publishableKey`. Returns `fetchImpl`
 * unchanged for a production key or where there is no storage.
 */
const WRAPPED = Symbol.for('atlas.devBrowser');

/**
 * One in-flight ticket exchange per ticket, page-wide.
 *
 * A page whose effects run twice (React StrictMode in development, a remounted
 * provider) would POST the same one-time ticket twice; the second call would
 * fail with 400 and log a console error although the sign-in worked. Every
 * caller of `POST /v1/client/tickets/exchange` for the same attempt + ticket
 * shares the first request, and each gets its own copy of the response. A
 * finished exchange is kept for {@link EXCHANGE_SHARE_MS} so a remount just
 * after it still reuses the answer instead of spending the ticket again.
 * Shares are kept per underlying fetch: a remount wrapping the same fetch shares,
 * a different fetch (another client, a test's fresh mock) never sees them.
 */
const EXCHANGE_SHARE_MS = 10_000;
let exchangesByFetch = new WeakMap<object, Map<string, Promise<Response>>>();

function exchangeKey(init: RequestInit | undefined): string | null {
  if (typeof init?.body !== 'string') return null;
  try {
    const body = JSON.parse(init.body) as { attempt_id?: unknown; ticket?: unknown };
    return typeof body.attempt_id === 'string' && typeof body.ticket === 'string' ? `${body.attempt_id}\0${body.ticket}` : null;
  } catch {
    return null;
  }
}

function sharedExchange(
  owner: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  send: () => Promise<Response>,
): Promise<Response> {
  const key = (init?.method ?? 'GET').toUpperCase() === 'POST' && pathOf(input) === EXCHANGE ? exchangeKey(init) : null;
  if (!key) return send();
  const shares = exchangesByFetch.get(owner) ?? new Map<string, Promise<Response>>();
  exchangesByFetch.set(owner, shares);
  let first = shares.get(key);
  if (!first) {
    first = send();
    shares.set(key, first);
    const forget = () => {
      if (shares.get(key) === first) shares.delete(key);
    };
    // A failed exchange is not shared later (a retry should really retry); a success is, briefly.
    first.then(
      (r) => {
        if (!r.ok) return forget();
        const timer = setTimeout(forget, EXCHANGE_SHARE_MS);
        (timer as { unref?: () => void }).unref?.();
      },
      forget,
    );
  }
  return first.then((r) => r.clone());
}

/** Test hook: forget shared exchanges. */
export function resetSharedExchanges(): void {
  exchangesByFetch = new WeakMap();
}

export function withDevBrowser(publishableKey: string, fetchImpl: typeof fetch): typeof fetch {
  // A provider hands its (already wrapped) fetch to the FAPI client too: wrap once.
  if ((fetchImpl as unknown as Record<symbol, unknown>)[WRAPPED]) return fetchImpl;
  if (!publishableKey.startsWith('pk_test_')) {
    // Production keys: only the one-exchange-per-ticket share.
    const shared = (input: RequestInfo | URL, init?: RequestInit) => sharedExchange(fetchImpl, input, init, () => fetchImpl(input, init));
    (shared as unknown as Record<symbol, unknown>)[WRAPPED] = true;
    return shared as typeof fetch;
  }
  const wrapped = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    sharedExchange(fetchImpl, input, init, () => devBrowserFetch(input, init));
  const devBrowserFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!devBrowserEnabled(publishableKey)) return fetchImpl(input, init);
    const path = pathOf(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    let nextInit = init;
    let presented = false;

    if (path === EXCHANGE && method === 'POST' && typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body) as unknown;
        if (body && typeof body === 'object' && !Array.isArray(body)) {
          nextInit = { ...init, body: JSON.stringify({ ...(body as Record<string, unknown>), return_refresh_token: true }) };
        }
      } catch {
        // not JSON: send it as it is
      }
    }
    const token = devBrowserToken(publishableKey);
    if (token && ((path === BOOT && method === 'GET') || (path && REFRESH.test(path) && method === 'POST'))) {
      const headers = new Headers(nextInit?.headers);
      if (!headers.has('x-refresh-token')) headers.set('x-refresh-token', token);
      nextInit = { ...nextInit, headers };
      presented = true;
    }

    const response = await fetchImpl(input, nextInit);
    if (!path) return response;
    if (path === EXCHANGE && response.ok) {
      const body = await bodyOf(response);
      remember(publishableKey, body?.refresh_token, body?.id);
    } else if (path && REFRESH.test(path)) {
      if (response.ok) remember(publishableKey, (await bodyOf(response))?.refresh_token, sessionIdIn(path));
      else if (presented && response.status === 401) forgetDevBrowserToken(publishableKey);
    } else if (path === BOOT && presented && response.ok) {
      const body = await bodyOf(response);
      if (body && body.session === null) forgetDevBrowserToken(publishableKey);
    } else if (path && REVOKE.test(path) && (response.ok || response.status === 404)) {
      // Only this browser's own session: revoking another device keeps us signed in.
      const sid = storedSessionId(publishableKey);
      if (!sid || sid === sessionIdIn(path)) forgetDevBrowserToken(publishableKey);
    }
    return response;
  };
  (wrapped as unknown as Record<symbol, unknown>)[WRAPPED] = true;
  return wrapped as typeof fetch;
}
