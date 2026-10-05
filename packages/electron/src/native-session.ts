/**
 * Native session for Electron (MAIN process).
 *
 * A thin wiring of the framework-agnostic {@link NativeSessionManager} from
 * `@atlasauth/js` to this package's main-process {@link TokenStorage} — the same
 * OS-keystore-backed store the token bridge uses. The core manager owns the
 * exchange/refresh/rotation; this file persists each rotated session into that
 * store (so the rotating refresh token survives an app restart, encrypted at
 * rest) and rehydrates the manager from it on launch.
 *
 * It lives in the MAIN process because that is where the raw token belongs (a
 * renderer served from a custom scheme has no cookie and must not hold the
 * token), and because the refresh `fetch` runs here. Build it with the SAME
 * {@link createTokenStorage} store you pass to `createAtlasBridge`; the session
 * is kept under its own key, so it coexists with the bridge's token.
 */

import {
  NativeSessionManager,
  parseNativeSession,
  serializeNativeSession,
  type NativeSession,
} from '@atlasauth/js';
import { createInMemoryTokenStorage, type TokenStorage } from './storage';

/** The default key the serialized native session is stored under. */
export const DEFAULT_NATIVE_SESSION_KEY = 'atlas.native_session';

export interface NativeSessionOptions {
  /** The instance's FAPI origin, e.g. `https://fapi.acme.atlasauth.net`. */
  frontendApi: string;
  /** The publishable key — sent on the refresh call and in `authHeaders()`. */
  publishableKey: string;
  /** The first-party OAuth client id (for a later in-manager exchange). */
  clientId?: string;
  /**
   * The main-process store. Defaults to a NON-persistent in-memory cache — ship
   * `createTokenStorage(...)` (encrypted) in production, the same store the
   * bridge uses.
   */
  storage?: TokenStorage;
  /** The key the session is stored under. @default 'atlas.native_session' */
  sessionKey?: string;
  /** Injectable for tests; defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable clock, epoch ms. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Build a {@link NativeSessionManager} wired to the main-process token store.
 *
 * Async because the store may be async: it reads whatever session the store
 * holds (under `sessionKey`) and seeds the manager, so a returning user is
 * signed in before the first request. Thereafter every rotation is written
 * straight back through the manager's `persist` hook.
 */
export async function createNativeSessionManager(
  options: NativeSessionOptions,
): Promise<NativeSessionManager> {
  const storage = options.storage ?? createInMemoryTokenStorage();
  const key = options.sessionKey ?? DEFAULT_NATIVE_SESSION_KEY;
  const initial = parseNativeSession(await storage.get(key)) ?? undefined;

  return new NativeSessionManager({
    baseUrl: options.frontendApi,
    publishableKey: options.publishableKey,
    clientId: options.clientId,
    initial,
    fetchImpl: options.fetchImpl,
    now: options.now,
    // Fire-and-forget: the store may be async, and a write failure must not
    // break the live session (the server still accepts the in-memory token).
    persist: (session: NativeSession) => {
      void Promise.resolve(storage.set(key, serializeNativeSession(session))).catch(() => undefined);
    },
  });
}

/** Clear the persisted native session (sign-out). */
export async function clearNativeSession(
  storage: TokenStorage,
  sessionKey: string = DEFAULT_NATIVE_SESSION_KEY,
): Promise<void> {
  await storage.remove(sessionKey);
}

export { NativeSessionManager, type NativeSession } from '@atlasauth/js';
export { exchangeForSession, refreshNativeSession } from '@atlasauth/js';
