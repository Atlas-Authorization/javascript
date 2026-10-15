import {
  FapiClient,
  SessionTombstones,
  SignOutGuard,
  msUntilRefresh,
  readExpiry,
  resolveFrontendApi,
  type FapiRequest,
  type ProviderToken,
  type SignOutOptions,
  type SignOutResult,
  type TombstoneStore,
} from '@atlasauth/js';
import { StorageCache, createChromeTombstoneStore, type TokenStore } from './storage';

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

/** The session id in a stored token, or null. */
function sidOf(token: string | null | undefined): string | null {
  const sid = token ? decodeTokenClaims(token)?.sid : undefined;
  return typeof sid === 'string' && sid ? sid : null;
}

export interface ExtensionSignOutGuardOptions {
  publishableKey: string;
  /** The (validated) Frontend API base URL. Tombstones are kept per Frontend API origin. */
  frontendApi: string;
  /** Injectable for tests; defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
  /** Where tombstones live. Defaults to `chrome.storage.local`. */
  tombstoneStore?: TombstoneStore;
  /** Delays (ms) between background re-tries of a failed revoke. @default `[15_000, 60_000, 300_000]` */
  retryDelaysMs?: number[];
}

/**
 * The safer sign-out for an extension, where several surfaces (popup, options
 * page, content scripts, the service worker) share one token in
 * `chrome.storage` but each has its own memory.
 *
 * Wraps `@atlasauth/js`'s {@link SignOutGuard} with tombstones in
 * `chrome.storage.local`, and re-reads them before every decision — so a surface
 * that booted before another one signed out still sees the sign-out: it neither
 * adopts the signed-out session's token ({@link guardStore} `getToken`) nor
 * writes back a token a refresh rotated for it (`setToken`). Revokes ride on the
 * very token being dropped ({@link bearerRequest}), so a background re-try can
 * still authenticate after the store was cleared.
 */
export class ExtensionSignOutGuard {
  readonly guard: SignOutGuard;
  private readonly baseUrl: string;
  private readonly publishableKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly store: TombstoneStore;
  /** Tokens dropped at sign-out, by session id, for a revoke re-tried after the store was cleared. */
  private readonly dropped = new Map<string, string>();

  constructor(options: ExtensionSignOutGuardOptions) {
    this.baseUrl = options.frontendApi;
    this.publishableKey = options.publishableKey;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.store = options.tombstoneStore ?? createChromeTombstoneStore();
    this.guard = new SignOutGuard({
      request: this.bearerRequest(null),
      frontendApi: options.frontendApi,
      store: this.store,
      ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
    });
  }

  /** A Frontend API request carrying exactly `token` as its bearer (none for null). */
  bearerRequest(token: string | null): FapiRequest {
    return (path, init) => {
      const headers = new Headers(init?.headers);
      headers.set('x-publishable-key', this.publishableKey);
      if (token) headers.set('authorization', `Bearer ${token}`);
      return this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    };
  }

  /**
   * Whether the extension signed out of `sessionId` — on ANY surface: the
   * tombstones another surface wrote to the shared store are learned first.
   */
  async isSignedOut(sessionId: string | null | undefined): Promise<boolean> {
    if (!sessionId) return false;
    await this.guard.ready;
    if (this.guard.isSignedOut(sessionId)) return true;
    const shared = new SessionTombstones({ frontendApi: this.baseUrl, store: this.store });
    await shared.ready;
    this.guard.learn({ signedOut: shared.list() });
    return this.guard.isSignedOut(sessionId);
  }

  /** Remember the token of a session being signed out of, for later re-tries of its revoke. */
  remember(sessionId: string, token: string): void {
    this.dropped.set(sessionId, token);
  }

  /** The token a session was signed out with, if this surface dropped it. */
  droppedToken(sessionId: string): string | null {
    return this.dropped.get(sessionId) ?? null;
  }

  /**
   * Wrap a {@link TokenStore} so it never hands out — nor accepts — a token of
   * a session the extension signed out of. A refused stored token is removed
   * and its session revoked again in the background, as itself.
   */
  guardStore(store: TokenStore): TokenStore {
    return {
      getToken: async () => {
        const token = await store.getToken();
        const sid = sidOf(token);
        if (!token || !sid || !(await this.isSignedOut(sid))) return token;
        this.guard.refuse(sid, this.bearerRequest(token));
        // Only if no surface has stored a newer token meanwhile.
        if ((await store.getToken().catch(() => null)) === token) {
          await store.removeToken().catch(() => undefined);
        }
        return null;
      },
      setToken: async (token: string) => {
        // A refresh that was in flight at sign-out (here or on another surface)
        // must not write the signed-out session's token back.
        if (await this.isSignedOut(sidOf(token))) return;
        await store.setToken(token);
      },
      removeToken: () => store.removeToken(),
    };
  }
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
  /**
   * Make it sign-out safe: a stored token of a signed-out session is never
   * sent nor written back, and a revoke of the stored token's session
   * tombstones it and drops the token from `chrome.storage` for every surface.
   */
  signOutGuard?: ExtensionSignOutGuard,
): typeof fetch {
  const tokens = signOutGuard ? signOutGuard.guardStore(store) : store;
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    let token = await tokens.getToken();
    const url = urlOf(input);
    const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
    const revoking = signOutGuard && method === 'POST' ? /\/v1\/client\/sessions\/([^/?#]+)\/revoke(?:[?#]|$)/.exec(url) : null;
    let dropping: string | null = null;
    if (signOutGuard && revoking) {
      const sid = decodeURIComponent(revoking[1]!);
      if (token && sidOf(token) === sid) {
        // Signing out of the session this extension is signed in with:
        // remember it first, so no surface re-adopts it from here on.
        await signOutGuard.guard.ready;
        signOutGuard.guard.tombstones.add(sid);
        signOutGuard.remember(sid, token);
        dropping = sid;
      } else if (!token) {
        // A re-try after the token was dropped: authenticate as that session.
        token = signOutGuard.droppedToken(sid);
      }
    }
    const headers = new Headers(init?.headers);
    if (token) headers.set('authorization', `Bearer ${token}`);
    const dropped = async (response: Response | null) => {
      if (!signOutGuard || !dropping || !token) return;
      // Signed out locally whatever the server said — but only if no surface
      // stored a newer token meanwhile.
      if ((await store.getToken().catch(() => null)) === token) await store.removeToken().catch(() => undefined);
      if (!response || (!response.ok && response.status !== 404)) {
        // Keep trying in the background (retried once, then on the guard's delays).
        void signOutGuard.guard.revoke(dropping, { request: signOutGuard.bearerRequest(token), frontchannel: false });
      }
    };
    let response: Response;
    try {
      response = await fetchImpl(input, { ...init, headers });
    } catch (error) {
      await dropped(null);
      throw error;
    }
    await dropped(response);

    if (response.ok && /\/v1\/client(\/|\?|$)/.test(url)) {
      try {
        const body = (await response.clone().json()) as { jwt?: unknown };
        if (typeof body.jwt === 'string') await tokens.setToken(body.jwt);
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
  /**
   * Where the ids of sessions the extension signed out of are kept, shared by
   * every surface. Defaults to the {@link StorageCache}'s storage area (else
   * `chrome.storage.local`).
   */
  tombstoneStore?: TombstoneStore;
  /**
   * Delays (ms) between background re-tries of a revoke `signOut()` could not
   * complete. @default `[15_000, 60_000, 300_000]`
   */
  signOutRetryDelaysMs?: number[];
}

/**
 * The extension client. A thin, React-free handle the background service worker
 * and any extension page share: the `@atlasauth/js` FAPI client (bearer-wired),
 * the token store, and the session-token lifecycle helpers.
 */
export interface AtlasClient {
  /** The bearer-wired `@atlasauth/js` client for any raw FAPI call. */
  readonly fapi: FapiClient;
  /**
   * The token store this client reads and writes. It never hands out — nor
   * writes back — a token of a session the extension signed out of.
   */
  readonly store: TokenStore;
  /** The current session token, or null when signed out. */
  getToken(): Promise<string | null>;
  /** Seed the token after an out-of-band sign-in (e.g. a hosted-page flow). */
  setToken(token: string): Promise<void>;
  /** The signed-in user's live token at a connected provider (Google, …). */
  getProviderToken(provider: string): Promise<ProviderToken | null>;
  /** Refresh the token if it is near expiry (or `force`) and persist it. */
  syncSessionToken(options?: SyncOptions): Promise<string | null>;
  /**
   * Sign out: remember the session id in `chrome.storage` (so no surface
   * re-adopts it, and a refresh in flight anywhere cannot write its token
   * back), revoke it on the Frontend API with the token being dropped (retried
   * once, then in the background), and clear the stored token. Resolves
   * `{ revoked }` — `false` when the server could not be reached (signed out
   * locally regardless); `{ strict: true }` rejects with a `SignOutError`
   * instead, after the local sign-out. A promoted `activeSessionId` is only
   * reported: the bearer revoke returns no credential for it.
   */
  signOut(options?: SignOutOptions): Promise<SignOutResult>;
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
  const rawStore = options.store ?? new StorageCache();
  const fetchImpl = options.fetchImpl ?? fetch;
  const signOutGuard = new ExtensionSignOutGuard({
    publishableKey: options.publishableKey,
    frontendApi: baseUrl,
    fetchImpl,
    tombstoneStore:
      options.tombstoneStore ??
      (rawStore instanceof StorageCache ? rawStore.tombstoneStore() : createChromeTombstoneStore()),
    ...(options.signOutRetryDelaysMs ? { retryDelaysMs: options.signOutRetryDelaysMs } : {}),
  });
  const store = signOutGuard.guardStore(rawStore);
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
    signOut: async (opts: SignOutOptions = {}) => {
      const token = await rawStore.getToken().catch(() => null);
      await signOutGuard.guard.ready;
      // Tombstones the session (when the token names it) before anything below
      // yields; with a token but no `sid`, GET /v1/client finds it. The revoke
      // rides on the token being dropped, so its background re-try still can.
      const pending = token
        ? signOutGuard.guard.revoke(sidOf(token), { ...opts, request: signOutGuard.bearerRequest(token) })
        : null;
      // The local token is cleared regardless, so no surface keeps showing a
      // signed-in state after sign-out (the tombstone covers a failed clear).
      await rawStore.removeToken().catch(() => undefined);
      const attempt = pending ? await pending : { sessionId: null, outcome: { revoked: true, status: 200 } };
      return signOutGuard.guard.settle(attempt, opts);
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

export { SignOutError, type ProviderToken, type SignOutOptions, type SignOutResult, type TombstoneStore } from '@atlasauth/js';
