/**
 * Native session for a Chrome / MV3 extension.
 *
 * A thin wiring of the framework-agnostic {@link NativeSessionManager} from
 * `@atlasauth/js` to this package's {@link TokenStore} over `chrome.storage`.
 * The core manager owns the exchange/refresh/rotation; this file persists each
 * rotated session into `chrome.storage.local` (so the rotating refresh token
 * survives the service worker being torn down AND is readable from every
 * extension surface) and rehydrates the manager from it on each cold start.
 *
 * The whole session is stored as one JSON string under its OWN key, separate
 * from {@link StorageCache}'s session-token slot, so the two coexist.
 */

import {
  NativeSessionManager,
  parseNativeSession,
  serializeNativeSession,
  type NativeSession,
} from '@atlasauth/js';
import { StorageCache, type TokenStore } from './storage';

/** The `chrome.storage` key the serialized native session is kept under. */
export const DEFAULT_NATIVE_SESSION_KEY = '__atlas_native_session';

export interface NativeSessionOptions {
  /** The instance's FAPI origin, e.g. `https://fapi.acme.atlasauth.net`. */
  frontendApi: string;
  /** The publishable key — sent on the refresh call and in `authHeaders()`. */
  publishableKey: string;
  /** The first-party OAuth client id (for a later in-manager exchange). */
  clientId?: string;
  /**
   * Where the session is persisted. Defaults to a {@link StorageCache} over
   * `chrome.storage.local` under {@link DEFAULT_NATIVE_SESSION_KEY}. Inject a
   * memory-backed store (see `createMemoryStorageArea`) in tests.
   */
  store?: TokenStore;
  /** Injectable for tests; defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable clock, epoch ms. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Build a {@link NativeSessionManager} wired to `chrome.storage`.
 *
 * Async because `chrome.storage` is async: it reads whatever session the store
 * holds and seeds the manager, so a freshly-woken service worker (or a reopened
 * popup) is signed in before its first request. Thereafter every rotation is
 * written straight back through the manager's `persist` hook, so the next
 * surface — and the next cold start — picks up the rotated refresh token.
 */
export async function createNativeSessionManager(
  options: NativeSessionOptions,
): Promise<NativeSessionManager> {
  const store = options.store ?? new StorageCache({ key: DEFAULT_NATIVE_SESSION_KEY });
  const initial = parseNativeSession(await store.getToken()) ?? undefined;

  return new NativeSessionManager({
    baseUrl: options.frontendApi,
    publishableKey: options.publishableKey,
    clientId: options.clientId,
    initial,
    fetchImpl: options.fetchImpl,
    now: options.now,
    // Fire-and-forget: `chrome.storage` writes are async and a failure must not
    // break the live session held in memory.
    persist: (session: NativeSession) => {
      void store.setToken(serializeNativeSession(session)).catch(() => undefined);
    },
  });
}

/** Clear the persisted native session (sign-out). */
export async function clearNativeSession(store: TokenStore): Promise<void> {
  await store.removeToken();
}

export { NativeSessionManager, type NativeSession } from '@atlasauth/js';
export { exchangeForSession, refreshNativeSession } from '@atlasauth/js';
