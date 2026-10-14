import {
  FapiClient,
  msUntilRefresh,
  readExpiry,
  resolveFrontendApi,
  type ProviderToken,
} from '@atlasauth/js';
import { StorageCache, type TokenStore } from './storage';

/**
 * The extension FAPI layer.
 *
 * Every network call goes through the framework-agnostic `@atlasauth/js`
 * `FapiClient` — the same client the web and React Native SDKs use — so there is
 * one implementation of "how an Atlas request is shaped". This module adds the
 * one thing an extension needs that a first-party web page gets for free:
 * **bearer auth**. The browser attaches the session via a cookie; an extension
 * has none, so the token from the {@link TokenStore} rides in an
 * `Authorization: Bearer` header instead.
 */

/** The session claims the SDK reads off the (unverified) JWT — a scheduling hint. */
interface SessionTokenClaims {
  sid?: string;
  exp?: number;
}

/** Read the unverified claims out of a JWT. Never a security decision — the
 *  server validates the signature; this only tells the client which session to
 *  refresh and roughly when. Returns null for anything that is not a JWT. */
export function decodeTokenClaims(jwt: string): SessionTokenClaims | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(
      atob(parts[1]!.replace(/-/g, '+').replace(/_/g, '/')),
    ) as SessionTokenClaims;
  } catch {
    return null;
  }
}

/**
 * Wrap a `fetch` so every request carries the current session token as a bearer.
 * The token is read FRESH from the store on each call — never captured — so a
 * refresh or a sign-out between requests is always reflected. A request made
 * while signed out simply carries no `Authorization` header.
 */
export function bearerFetch(fetchImpl: typeof fetch, store: TokenStore): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const token = await store.getToken();
    const headers = new Headers(init?.headers);
    if (token) headers.set('authorization', `Bearer ${token}`);
    return fetchImpl(input, { ...init, headers });
  };
}

/** Pull a request URL string out of whatever `fetch` was handed. */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}

/**
 * A {@link bearerFetch} that ALSO captures a freshly-minted session token out of
 * the response and persists it to the store.
 *
 * The web SDK's provider keeps its refreshed JWT in memory, which is exactly
 * what an extension cannot do — the popup that received the token is closed
 * moments later, and the service worker is torn down. So when a token-issuing
 * endpoint (`/v1/client/...`) answers with a `jwt` in its JSON body, we write it
 * back to `chrome.storage`, so the next request from ANY surface — and the next
 * cold start of the service worker — picks up the current token. Scoped to
 * `/v1/client` responses and guarded by JSON parsing, so a non-JSON or unrelated
 * response is left untouched.
 */
export function persistingBearerFetch(
  fetchImpl: typeof fetch,
  store: TokenStore,
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const token = await store.getToken();
    const headers = new Headers(init?.headers);
    if (token) headers.set('authorization', `Bearer ${token}`);
    const response = await fetchImpl(input, { ...init, headers });

    if (response.ok && /\/v1\/client(\/|\?|$)/.test(urlOf(input))) {
      try {
        const body = (await response.clone().json()) as { jwt?: unknown };
        if (typeof body.jwt === 'string') await store.setToken(body.jwt);
      } catch {
        // Not JSON, or no body (a 204 revoke). Nothing to capture.
      }
    }
    return response;
  };
}

export interface CreateAtlasClientOptions {
  publishableKey: string;
  /** The instance's FAPI origin, e.g. `https://fapi.your-instance.atlasauth.net`. */
  frontendApi: string;
  /** Where the token lives. Defaults to `chrome.storage.local` via {@link StorageCache}. */
  store?: TokenStore;
  /** Injectable for tests; defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * The extension client. A thin, React-free handle the background service worker
 * and any extension page share: the `@atlasauth/js` FAPI client (bearer-wired),
 * the token store, and the session-token lifecycle helpers.
 */
export interface AtlasClient {
  /** The bearer-wired `@atlasauth/js` client for any raw FAPI call. */
  readonly fapi: FapiClient;
  /** The token store this client reads and writes. */
  readonly store: TokenStore;
  /** The current session token, or null when signed out. */
  getToken(): Promise<string | null>;
  /** Seed the token after an out-of-band sign-in (e.g. a hosted-page flow). */
  setToken(token: string): Promise<void>;
  /** The signed-in user's live token at a connected provider (Google, …). */
  getProviderToken(provider: string): Promise<ProviderToken | null>;
  /** Refresh the token if it is near expiry (or `force`) and persist it. */
  syncSessionToken(options?: SyncOptions): Promise<string | null>;
  /** Revoke the session server-side and clear the stored token. */
  signOut(): Promise<void>;
}

/**
 * Build an {@link AtlasClient}. `background: true` is accepted for parity with
 * the sibling SDKs and to read as intent at the call site; the client behaves
 * the same in a service worker as on a page.
 */
export function createAtlasClient(
  options: CreateAtlasClientOptions & { background?: boolean },
): AtlasClient {
  // Throws an `AtlasConfigError` on a missing/invalid value. An extension's own
  // origin (chrome-extension://…) is not where the Frontend API lives, so
  // "same-origin" / a bare path is refused too.
  const baseUrl = resolveFrontendApi(options.frontendApi, {
    component: 'createAtlasClient()',
    allowSameOrigin: false,
  });
  const store = options.store ?? new StorageCache();
  const fetchImpl = options.fetchImpl ?? fetch;
  const fapi = new FapiClient({
    publishableKey: options.publishableKey,
    baseUrl,
    fetchImpl: bearerFetch(fetchImpl, store),
  });

  const client: AtlasClient = {
    fapi,
    store,
    getToken: () => store.getToken(),
    setToken: (token: string) => store.setToken(token),
    getProviderToken: (provider: string) => getProviderTokenFor(fapi, provider),
    syncSessionToken: (opts?: SyncOptions) => syncSessionToken(client, opts),
    signOut: async () => {
      const current = await store.getToken();
      const sid = current ? decodeTokenClaims(current)?.sid : undefined;
      if (sid) {
        // Best-effort server revoke; the local token is cleared regardless so
        // the extension never keeps showing a signed-in state after sign-out.
        await fapi.post(`/v1/client/sessions/${sid}/revoke`).catch(() => undefined);
      }
      await store.removeToken();
    },
  };
  return client;
}

export interface SyncOptions {
  /** Refresh even if the current token is not yet inside its expiry window. */
  force?: boolean;
}

/**
 * Refresh and persist the session token — the call a background service worker
 * makes (typically on a `chrome.alarms` tick, or before a token-gated request).
 *
 * A service worker has no long-lived timer of its own — MV3 evicts it — so the
 * web SDK's in-page proactive-refresh loop does not translate. Instead the
 * worker calls this whenever it wakes: it reads the stored token, and if it is
 * within the refresh lead window (or `force`) mints a new one via
 * `POST /v1/client/sessions/:sid/tokens` (bearer-authenticated by the client)
 * and writes it back to `chrome.storage`.
 *
 * Returns the current token (fresh or unchanged), or null when signed out. A
 * failed refresh returns the existing token rather than throwing — the worker
 * can retry on its next tick, and the server rejects a truly-dead token on use.
 */
export async function syncSessionToken(
  client: AtlasClient,
  options: SyncOptions = {},
): Promise<string | null> {
  const current = await client.store.getToken();
  if (!current) return null;

  const claims = decodeTokenClaims(current);
  const expiresAt = readExpiry(current);

  // Still comfortably fresh and no force → nothing to do, and no needless call.
  if (!options.force && expiresAt !== null) {
    const wait = msUntilRefresh({
      token: { jwt: current, expiresAt, sessionId: claims?.sid ?? '' },
      now: Date.now(),
    });
    if (wait > 0) return current;
  }

  const sid = claims?.sid;
  if (!sid) return current;

  const response = await client.fapi.post<{ jwt?: string; session_id?: string }>(
    `/v1/client/sessions/${sid}/tokens`,
  );
  if (!response.ok || !response.data?.jwt) return current;

  await client.store.setToken(response.data.jwt);
  return response.data.jwt;
}

/**
 * §6.6 token vault. The signed-in user's OWN live access token at a connected
 * provider, so the extension can call e.g. the Google API directly. Returns null
 * when there is no usable token (no linked account / provider granted none).
 */
async function getProviderTokenFor(
  fapi: FapiClient,
  provider: string,
): Promise<ProviderToken | null> {
  const response = await fapi.get<{
    provider: string;
    access_token: string;
    expires_at: number | null;
    scopes: string[];
  }>(`/v1/client/me/external_accounts/${encodeURIComponent(provider)}/token`);

  if (!response.ok || !response.data) return null;
  return {
    provider: response.data.provider,
    accessToken: response.data.access_token,
    expiresAt: response.data.expires_at ?? null,
    scopes: response.data.scopes ?? [],
  };
}

export type { ProviderToken };
