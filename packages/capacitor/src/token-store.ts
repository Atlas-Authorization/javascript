/**
 * The Capacitor session token store.
 *
 * The web SDK keeps its short-lived JWT in memory and lets the browser carry the
 * refresh token in an HttpOnly cookie. A Capacitor app — a WebView with no cookie
 * jar against the FAPI origin — has to put the session somewhere the app chooses,
 * and WHERE it lives is a security decision this SDK must not make for the app.
 *
 * So the SDK depends only on the small {@link TokenStore} interface below (the
 * same three-method shape the `@atlasauth/js` native-session manager persists
 * through) and ships two adapters: an in-memory default and a
 * `@capacitor/preferences` one. `@capacitor/preferences` is an OPTIONAL peer, so
 * its surface is declared structurally ({@link PreferencesPlugin}) and the app
 * passes the real plugin in — the package compiles, typechecks and tests without
 * it installed.
 *
 * ⚠️ `@capacitor/preferences` is NOT encrypted at rest (UserDefaults /
 * SharedPreferences). For production, back the store with a secure-storage
 * community plugin — e.g. `@capacitor-community/secure-storage` or
 * `capacitor-secure-storage-plugin` — behind this same {@link TokenStore}
 * interface. See {@link createPreferencesTokenStore} for the drop-in shape.
 */

import type { TombstoneStore } from '@atlasauth/js';
import type { PreferencesPlugin } from './plugins';

/**
 * A single-slot token store: read, write, clear one string value. This is the
 * exact contract the `@atlasauth/js` {@link NativeSessionManager} persists the
 * serialized session through (its `persist` hook writes, boot reads, sign-out
 * clears). Every method may be sync or async, so an in-memory store and an async
 * `@capacitor/preferences` store both fit.
 */
export interface TokenStore {
  /** The stored value, or null when absent. */
  getToken(): string | null | Promise<string | null>;
  /** Persist `value`. Called on every successful sign-in / refresh. */
  setToken(value: string): void | Promise<void>;
  /** Drop the stored value (sign-out, or a rejected session). */
  clearToken(): void | Promise<void>;
}

/** The default key the serialized native session is stored under. */
export const DEFAULT_SESSION_KEY = 'atlas.native_session';

/**
 * Build a {@link TokenStore} backed by `@capacitor/preferences`, keyed by `key`.
 * The app imports the plugin and passes it in — the SDK never imports
 * `@capacitor/preferences` itself, so it stays an optional peer:
 *
 * ```ts
 * import { Preferences } from '@capacitor/preferences';
 * import { createPreferencesTokenStore } from '@atlasauth/capacitor';
 *
 * const store = createPreferencesTokenStore(Preferences);
 * ```
 *
 * Preferences is plaintext at rest; swap a secure-storage plugin behind this same
 * interface for production (see the module header).
 */
export function createPreferencesTokenStore(
  preferences: PreferencesPlugin,
  key: string = DEFAULT_SESSION_KEY,
): TokenStore {
  return {
    getToken: async () => (await preferences.get({ key })).value ?? null,
    setToken: (value) => preferences.set({ key, value }),
    clearToken: () => preferences.remove({ key }),
  };
}

/**
 * A process-memory {@link TokenStore}. The zero-config default so the SDK runs
 * out of the box in tests and prototypes — but it does NOT survive an app
 * restart, so ship {@link createPreferencesTokenStore} (or a secure-storage
 * adapter) in production.
 */
export function createInMemoryTokenStore(): TokenStore {
  let token: string | null = null;
  return {
    getToken: () => token,
    setToken: (next: string) => {
      token = next;
    },
    clearToken: () => {
      token = null;
    },
  };
}

/**
 * A {@link TombstoneStore} over `@capacitor/preferences` — where the ids of the
 * sessions this app signed out of are kept, so a restart never re-adopts one
 * (see `SignOutGuard` in `@atlasauth/js`). The default when the plugin is
 * present. Tombstones are session ids, never credentials, so plaintext is fine.
 */
export function createPreferencesTombstoneStore(preferences: PreferencesPlugin): TombstoneStore {
  return {
    getItem: async (key) => (await preferences.get({ key })).value ?? null,
    setItem: (key, value) => preferences.set({ key, value }),
  };
}

/**
 * Adapt a single-slot {@link TokenStore} (e.g. a secure-storage-backed one) to
 * a {@link TombstoneStore}. Give it its OWN slot — never the session's: the
 * key `SignOutGuard` asks for is ignored, every read and write hits that slot.
 */
export function tombstoneStoreFromTokenStore(store: TokenStore): TombstoneStore {
  return {
    getItem: () => store.getToken(),
    setItem: (_key, value) => store.setToken(value),
  };
}
