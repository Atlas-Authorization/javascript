/**
 * Native session for Expo / React Native.
 *
 * A thin wiring of the framework-agnostic {@link NativeSessionManager} from
 * `@atlasauth/js` to this package's {@link TokenStorage} secure-store adapter.
 * The core manager owns the exchange / refresh / rotation logic; this file's only
 * job is to PERSIST each rotated session into `expo-secure-store` (or whatever
 * adapter the app wired) and to rehydrate the manager from it on boot.
 *
 * The whole session is stored as one JSON string under the adapter's single
 * slot — the refresh token (which rotates and must survive a restart) alongside
 * the session id the refresh call needs and the current JWT. Use a storage slot
 * DEDICATED to the native session (its own key), separate from the one you pass
 * to `AtlasProvider`, since each slot holds one value. `tokenStorageFor(cache,
 * 'atlas.native-session')` builds such a slot from the same token cache.
 */

import {
  NativeSessionManager,
  parseNativeSession,
  serializeNativeSession,
  type NativeSession,
} from '@atlasauth/js';
import { createInMemoryStorage, type TokenStorage } from './token-cache';

export interface NativeSessionConfig {
  /** The instance's FAPI origin, e.g. `https://fapi.acme.atlasauth.net`. */
  frontendApi: string;
  /** The publishable key — sent on the refresh call and in `authHeaders()`. */
  publishableKey: string;
  /** The first-party OAuth client id (for a later in-manager exchange). */
  clientId?: string;
  /**
   * Where the rotated session is persisted. Defaults to a NON-persistent
   * in-memory store — ship an `expo-secure-store` adapter (see {@link
   * TokenStorage}) in production, dedicated to the native session.
   */
  storage?: TokenStorage;
  /** Injectable for tests; defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable clock, epoch ms. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Build a {@link NativeSessionManager} wired to an Expo secure store.
 *
 * Async because the secure store is async: it reads whatever session the adapter
 * holds and seeds the manager with it, so a returning user is signed in before
 * the first request. Thereafter every rotation is written straight back to the
 * adapter via the manager's `persist` hook.
 */
export async function createNativeSessionManager(
  config: NativeSessionConfig,
): Promise<NativeSessionManager> {
  const storage = config.storage ?? createInMemoryStorage();
  const initial = parseNativeSession(await storage.getToken()) ?? undefined;

  return new NativeSessionManager({
    baseUrl: config.frontendApi,
    publishableKey: config.publishableKey,
    clientId: config.clientId,
    initial,
    fetchImpl: config.fetchImpl,
    now: config.now,
    // The manager calls this on every set/rotate; persist the fresh session so
    // the rotated refresh token survives an app restart. Fire-and-forget — the
    // adapter may be async, and a write failure must not break the live session.
    persist: (session: NativeSession) => {
      void Promise.resolve(storage.setToken(serializeNativeSession(session))).catch(
        () => undefined,
      );
    },
  });
}

/** Clear the persisted native session (sign-out). */
export async function clearNativeSession(storage: TokenStorage): Promise<void> {
  await storage.clearToken();
}

export { NativeSessionManager, type NativeSession } from '@atlasauth/js';
export { exchangeForSession, refreshNativeSession } from '@atlasauth/js';
