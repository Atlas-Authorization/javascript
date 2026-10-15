/**
 * The Expo session token cache.
 *
 * The web SDK keeps its short-lived JWT in memory and lets the browser carry the
 * refresh token in an HttpOnly cookie. Expo / React Native has neither a cookie
 * jar nor `localStorage`, so the session token has to live somewhere the app
 * chooses — and where it lives is a security decision this SDK must not make for
 * the app. A token in AsyncStorage is readable by any code in the process; a
 * token in `expo-secure-store` is hardware-backed (Keychain / Keystore).
 *
 * So the SDK depends only on the small {@link TokenCache} interface below and
 * ships an in-memory default plus an `expo-secure-store` adapter. The
 * `expo-secure-store` module is an OPTIONAL peer, so its surface is declared
 * structurally ({@link SecureStore}) and the app passes the real module in — the
 * package compiles, typechecks and tests without `expo-secure-store` installed.
 */

import type { TombstoneStore } from '@atlasauth/js';

/**
 * A key→token cache, the shape `<AtlasProvider tokenCache>` and the native
 * session wiring both consume. Mirrors Clerk's Expo `tokenCache` contract
 * (`getToken` / `saveToken` / `clearToken`). Every method may be sync or async,
 * so the same adapter fits an async `expo-secure-store` and a synchronous MMKV
 * store alike.
 */
export interface TokenCache {
  /** The token stored under `key`, or null/undefined when absent. */
  getToken(key: string): string | null | undefined | Promise<string | null | undefined>;
  /** Persist `value` under `key`. Called on every successful sign-in / refresh. */
  saveToken(key: string, value: string): void | Promise<void>;
  /** Drop whatever is stored under `key` (sign-out, or a rejected session). */
  clearToken(key: string): void | Promise<void>;
}

/**
 * The slice of `expo-secure-store` this package uses, declared structurally so
 * the package needs no dependency on it. The real module (and a fake in tests)
 * is structurally compatible.
 *
 * Every method is optional-arg-compatible with `expo-secure-store`'s
 * `SecureStoreOptions` (keychain accessibility, service, etc.), which the app
 * may pass through via {@link SecureStoreTokenCacheOptions.secureStoreOptions}.
 */
export interface SecureStore {
  getItemAsync(key: string, options?: unknown): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: unknown): Promise<void>;
  deleteItemAsync(key: string, options?: unknown): Promise<void>;
}

export interface SecureStoreTokenCacheOptions {
  /**
   * Pass-through `SecureStoreOptions` (e.g. `{ keychainAccessible:
   * SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }`). Forwarded verbatim to every
   * `expo-secure-store` call.
   */
  secureStoreOptions?: unknown;
}

/**
 * Build a {@link TokenCache} backed by `expo-secure-store` (hardware-backed
 * Keychain / Keystore). The app imports the module and passes it in — the SDK
 * never imports `expo-secure-store` itself, so it stays an optional peer:
 *
 * ```ts
 * import * as SecureStore from 'expo-secure-store';
 * import { createSecureStoreTokenCache } from '@atlasauth/expo';
 *
 * export const tokenCache = createSecureStoreTokenCache(SecureStore);
 * ```
 */
export function createSecureStoreTokenCache(
  store: SecureStore,
  options: SecureStoreTokenCacheOptions = {},
): TokenCache {
  const opts = options.secureStoreOptions;
  return {
    getToken: (key) => store.getItemAsync(key, opts),
    saveToken: (key, value) => store.setItemAsync(key, value, opts),
    clearToken: (key) => store.deleteItemAsync(key, opts),
  };
}

/**
 * A process-memory token cache. The zero-config default so the SDK runs out of
 * the box in tests, prototypes and Expo Go — but it does NOT survive an app
 * restart, so ship {@link createSecureStoreTokenCache} in production.
 */
export function createInMemoryTokenCache(): TokenCache {
  const map = new Map<string, string>();
  return {
    getToken: (key) => map.get(key) ?? null,
    saveToken: (key, value) => {
      map.set(key, value);
    },
    clearToken: (key) => {
      map.delete(key);
    },
  };
}

/**
 * Adapt a single-slot {@link TokenCache} (plus a fixed key) to the three-method
 * {@link TokenStorage} the native-session manager wants. The native session is
 * kept under its OWN key, separate from the `AtlasProvider` session, because the
 * adapter holds one value per slot.
 */
export interface TokenStorage {
  getToken(): string | null | Promise<string | null>;
  setToken(token: string): void | Promise<void>;
  clearToken(): void | Promise<void>;
}

/** View a {@link TokenCache} + one key as a single-slot {@link TokenStorage}. */
export function tokenStorageFor(cache: TokenCache, key: string): TokenStorage {
  return {
    getToken: async () => (await cache.getToken(key)) ?? null,
    setToken: (token) => cache.saveToken(key, token),
    clearToken: () => cache.clearToken(key),
  };
}

/** A process-memory {@link TokenStorage}. Non-persistent — see note above. */
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
 * View a {@link TokenCache} as the `TombstoneStore` `@atlasauth/react` keeps its
 * sign-out tombstones in (the ids of sessions this app signed out of — never a
 * token). React Native has no `localStorage`, so without this the tombstones are
 * memory-only and an app restart could re-adopt a session whose revoke failed.
 *
 * The tombstone key (`atlas:signed-out-sessions:<frontend api origin>`) is
 * rewritten to the characters `expo-secure-store` accepts in a key
 * (`A–Z a–z 0–9 . - _`), so the same adapter fits every cache.
 */
export function tombstoneStoreFor(cache: TokenCache): TombstoneStore {
  return {
    getItem: (key) => cache.getToken(storeKey(key)),
    setItem: (key, value) => cache.saveToken(storeKey(key), value),
  };
}

function storeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** The default cache key the `<AtlasProvider>` session is stored under. */
export const DEFAULT_SESSION_KEY = 'atlas.session';
