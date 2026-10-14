/**
 * Native session for Capacitor.
 *
 * A thin wiring of the framework-agnostic {@link NativeSessionManager} from
 * `@atlasauth/js` to this package's {@link TokenStore}. The core manager owns the
 * exchange / refresh / rotation logic; this file's only job is to PERSIST each
 * rotated session into the store (so the rotating refresh token survives an app
 * restart) and to rehydrate the manager from it on boot.
 *
 * The whole session is stored as one JSON string under the store's single slot —
 * the refresh token (which rotates and must survive a restart) alongside the
 * session id the refresh call needs and the current JWT. Give the native session
 * its OWN store/key, separate from any other value the app keeps.
 */

import {
  NativeSessionManager,
  parseNativeSession,
  serializeNativeSession,
  type NativeSession,
} from '@atlasauth/js';
import { createInMemoryTokenStore, type TokenStore } from './token-store';

export interface NativeSessionConfig {
  /** The instance's FAPI origin, e.g. `https://fapi.acme.atlasauth.net`. */
  frontendApi: string;
  /** The publishable key — sent on the refresh call and in `authHeaders()`. */
  publishableKey: string;
  /** The first-party OAuth client id (for a later in-manager exchange). */
  clientId?: string;
  /**
   * Where the rotated session is persisted. Defaults to a NON-persistent
   * in-memory store — ship a `@capacitor/preferences` (or secure-storage) store
   * (see {@link TokenStore}) in production.
   */
  storage?: TokenStore;
  /** Injectable for tests; defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable clock, epoch ms. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Build a {@link NativeSessionManager} wired to a Capacitor token store.
 *
 * Async because the store may be async: it reads whatever session the store
 * holds and seeds the manager with it, so a returning user is signed in before
 * the first request. Thereafter every rotation is written straight back to the
 * store via the manager's `persist` hook.
 */
export async function createNativeSessionManager(
  config: NativeSessionConfig,
): Promise<NativeSessionManager> {
  const storage = config.storage ?? createInMemoryTokenStore();
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
    // store may be async, and a write failure must not break the live session.
    persist: (session: NativeSession) => {
      void Promise.resolve(storage.setToken(serializeNativeSession(session))).catch(
        () => undefined,
      );
    },
  });
}

/** Clear the persisted native session (sign-out). */
export async function clearNativeSession(storage: TokenStore): Promise<void> {
  await storage.clearToken();
}

export {
  NativeSessionManager,
  exchangeForSession,
  refreshNativeSession,
  type NativeSession,
} from '@atlasauth/js';
