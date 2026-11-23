import { createSecureDeviceKey } from '@atlasauth/react-native';
import type { DeviceKey } from '@atlasauth/js';
import { ensureSecureRandom, loadCrypto } from './expo-oauth';
import { createInMemoryTokenCache, createSecureStoreTokenCache, tokenStorageFor, type SecureStore, type TokenCache } from './token-cache';

/** The cache key the device's private key is stored under. */
export const DEFAULT_DEVICE_KEY = 'atlas.device-key';
/** The cache key the held refresh token is stored under. */
export const DEFAULT_DEVICE_SESSION_KEY = 'atlas.device-session';

// Metro needs the module name as a literal.
const loadSecureStore = (): SecureStore | null => {
  try {
    return typeof require === 'function' ? (require('expo-secure-store') as SecureStore) ?? null : null;
  } catch {
    return null;
  }
};

/**
 * The device key of a native session on Expo: a P-256 key made once from `expo-crypto` random bytes and kept only in
 * the secure store (`cache`, default `expo-secure-store`; memory when that is not installed). `<AtlasProvider>` makes
 * one for you, so a build that upgrades needs no code. Signing is deterministic, so no randomness is used after keygen.
 */
export function createExpoDeviceKey(options: { cache?: TokenCache; storageKey?: string } = {}): DeviceKey {
  const secure = options.cache ? null : loadSecureStore();
  const cache = options.cache ?? (secure ? createSecureStoreTokenCache(secure) : createInMemoryTokenCache());
  return createSecureDeviceKey({
    storage: tokenStorageFor(cache, options.storageKey ?? DEFAULT_DEVICE_KEY),
    random: (n) => {
      if (!ensureSecureRandom(loadCrypto)) {
        if ((globalThis as { __DEV__?: boolean }).__DEV__) console.warn('[atlas] Install expo-crypto (npx expo install expo-crypto) so this app can stay signed in: the device key needs a secure random source.');
        throw new Error('No secure random source');
      }
      return (globalThis as unknown as { crypto: { getRandomValues(a: Uint8Array): Uint8Array } }).crypto.getRandomValues(new Uint8Array(n));
    },
  });
}
