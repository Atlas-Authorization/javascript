import type { TombstoneStore } from '@atlasauth/js';

/**
 * The RN session store.
 *
 * The web SDK keeps its short-lived JWT in memory and lets the browser carry
 * the refresh token in an HttpOnly cookie. React Native has neither a cookie
 * jar nor `localStorage`, so the session token has to live somewhere the app
 * chooses — and where it lives is a security decision the SDK must not make for
 * the app. A token in AsyncStorage is readable by any code in the process; a
 * token in the Keychain / Keystore (expo-secure-store) is hardware-backed.
 *
 * So the SDK depends only on this three-method interface and ships an in-memory
 * default. The consumer wires the real store — `expo-secure-store`, RN Keychain,
 * or AsyncStorage — by writing a tiny adapter with the shape below. Every method
 * may be sync or async, so the same adapter fits AsyncStorage (Promises) and a
 * synchronous MMKV store alike.
 */
export interface TokenStorage {
  /** The stored session token, or null when signed out. */
  getToken(): string | null | Promise<string | null>;
  /** Persist the session token. Called on every successful sign-in / refresh. */
  setToken(token: string): void | Promise<void>;
  /** Drop the token. Called on sign-out and whenever the session is rejected. */
  clearToken(): void | Promise<void>;
}

/**
 * A process-memory store. The default so the SDK works out of the box in tests
 * and prototypes — but it does NOT survive an app restart, so ship a persistent
 * adapter (below) in production.
 *
 * ── expo-secure-store (recommended: hardware-backed) ──────────────────────────
 *   import * as SecureStore from 'expo-secure-store';
 *   const secureStorage: TokenStorage = {
 *     getToken: () => SecureStore.getItemAsync('atlas.session'),
 *     setToken: (t) => SecureStore.setItemAsync('atlas.session', t),
 *     clearToken: () => SecureStore.deleteItemAsync('atlas.session'),
 *   };
 *
 * ── @react-native-async-storage/async-storage (not encrypted) ─────────────────
 *   import AsyncStorage from '@react-native-async-storage/async-storage';
 *   const asyncStorage: TokenStorage = {
 *     getToken: () => AsyncStorage.getItem('atlas.session'),
 *     setToken: (t) => AsyncStorage.setItem('atlas.session', t),
 *     clearToken: () => AsyncStorage.removeItem('atlas.session'),
 *   };
 *
 * Neither library is a dependency of this package — the adapter is the whole
 * contract, so the app installs only what it actually uses.
 */
export function createInMemoryStorage(): TokenStorage {
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
 * A process-memory {@link TombstoneStore} — the default for
 * `AtlasStoreConfig.tombstoneStore`. It remembers the sessions this app signed
 * out of only until the app restarts; pass a persistent adapter so a session
 * whose revoke never reached the server stays refused after a cold start too.
 * Tombstones are session ids, never tokens, so an unencrypted store is fine.
 *
 * ── @react-native-async-storage/async-storage ─────────────────────────────────
 *   import AsyncStorage from '@react-native-async-storage/async-storage';
 *   const tombstoneStore: TombstoneStore = {
 *     getItem: (key) => AsyncStorage.getItem(key),
 *     setItem: (key, value) => AsyncStorage.setItem(key, value),
 *   };
 *
 * ── expo-secure-store ─────────────────────────────────────────────────────────
 *   import * as SecureStore from 'expo-secure-store';
 *   // SecureStore keys allow only [A-Za-z0-9._-]: map the Atlas key onto one.
 *   const tombstoneStore: TombstoneStore = {
 *     getItem: () => SecureStore.getItemAsync('atlas.signed-out-sessions'),
 *     setItem: (_key, value) => SecureStore.setItemAsync('atlas.signed-out-sessions', value),
 *   };
 *
 * Pass it as `<AtlasProvider tombstoneStore={tombstoneStore}>` (or
 * `createAtlasStore({ tombstoneStore })`).
 */
export function createInMemoryTombstoneStore(): TombstoneStore {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

export type { TombstoneStore };
