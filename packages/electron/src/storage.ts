import type { SafeStorageLike } from './shared';

/**
 * The token cache the MAIN process owns.
 *
 * This is the one place the raw session token lives in an Electron app. The web
 * SDK lets the browser keep the session in an HttpOnly cookie; a renderer served
 * from a custom scheme (`app://…`) has no such cookie against the FAPI origin, so
 * the token has to be held somewhere the app controls — and holding it in the
 * renderer would expose it to any page script. It belongs in the main process,
 * behind the OS keystore.
 *
 * WHERE it lives is a security decision this package must not make for the app,
 * so the whole contract is this three-method interface. Every method may be sync
 * or async, so the same shape fits an in-memory Map, a synchronous file store, or
 * an async keychain call alike. The key is supplied by the caller (the bridge
 * binds one key) so a single storage can hold more than one entry if needed.
 */
export interface TokenStorage {
  /** The stored value for `key`, or null when absent. */
  get(key: string): string | null | Promise<string | null>;
  /** Persist `value` under `key`. */
  set(key: string, value: string): void | Promise<void>;
  /** Drop whatever is stored under `key`. */
  remove(key: string): void | Promise<void>;
}

/**
 * A process-memory token cache. The zero-config default so the bridge works out
 * of the box in tests and prototypes — but it does NOT survive an app restart,
 * so ship {@link createTokenStorage} (persistent, encrypted) in production.
 */
export function createInMemoryTokenStorage(): TokenStorage {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => {
      map.set(key, value);
    },
    remove: (key) => {
      map.delete(key);
    },
  };
}

// ── persistent, encrypted storage ────────────────────────────────────────────

/**
 * A synchronous key/value file store — the shape `electron-store` and a plain
 * JSON file both satisfy. Declared structurally so this package needs neither.
 */
export interface PersistentStore {
  get(key: string): string | null | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

/**
 * A string→string cipher. The token storage deals only in strings and defers all
 * crypto to this, which keeps the storage logic trivially testable with a fake
 * cipher and keeps electron's `safeStorage` an optional, swappable backend
 * (see {@link safeStorageCipher}).
 */
export interface Cipher {
  encrypt(plainText: string): string;
  decrypt(cipherText: string): string;
}

/**
 * Marks a value encrypted through a {@link Cipher}; the remainder is its output.
 */
const ENCRYPTED_PREFIX = 'enc:';
/**
 * Marks a value persisted unencrypted (the `unencryptedFallback` escape hatch).
 */
const RAW_PREFIX = 'raw:';

export interface CreateTokenStorageOptions {
  /** Where entries are persisted (e.g. an `electron-store` instance). */
  store: PersistentStore;
  /**
   * The cipher to encrypt entries with. Pass `safeStorageCipher(safeStorage, …)`
   * in a real Electron app; pass null (or a cipher-less config) to persist
   * unencrypted only when {@link unencryptedFallback} is set.
   */
  cipher?: Cipher | null;
  /**
   * When no cipher is available, persist tokens UNENCRYPTED rather than not at
   * all. Off by default: without it, an app with no OS encryption signs the user
   * out on restart instead of writing a plaintext token to disk.
   *
   * @default false
   */
  unencryptedFallback?: boolean;
}

/**
 * Build a persistent, at-rest-encrypted {@link TokenStorage} over a structural
 * file store and an optional {@link Cipher}. Mirrors Clerk's electron storage:
 * entries are tagged `enc:` / `raw:` so a value's format is self-describing, an
 * undecryptable entry reads back as null (the app re-authenticates) rather than
 * throwing, and an unrecognised entry is dropped.
 */
export function createTokenStorage(options: CreateTokenStorageOptions): TokenStorage {
  const { store, cipher = null, unencryptedFallback = false } = options;

  return {
    get(key) {
      const stored = store.get(key);
      if (!stored) return null;

      if (stored.startsWith(RAW_PREFIX)) {
        return stored.slice(RAW_PREFIX.length);
      }

      if (stored.startsWith(ENCRYPTED_PREFIX)) {
        if (!cipher) return null; // no key to decrypt with right now; keep the entry
        try {
          return cipher.decrypt(stored.slice(ENCRYPTED_PREFIX.length));
        } catch {
          // Undecryptable — preserve it (a key rotation may recover it) and let
          // the app fall back to a fresh sign-in rather than crash on read.
          return null;
        }
      }

      // Unknown format: drop it so we do not fail on it forever.
      store.delete(key);
      return null;
    },

    set(key, value) {
      if (cipher) {
        try {
          store.set(key, ENCRYPTED_PREFIX + cipher.encrypt(value));
          return;
        } catch {
          // fall through to the unencrypted decision below
        }
      }
      if (unencryptedFallback) {
        store.set(key, RAW_PREFIX + value);
      }
      // else: refuse to persist a plaintext token — signed out on next launch.
    },

    remove(key) {
      store.delete(key);
    },
  };
}

/**
 * Adapt Electron's `safeStorage` to a {@link Cipher}. Returns null when OS
 * encryption is unavailable (a Linux box with no keyring), which
 * {@link createTokenStorage} treats as "no cipher".
 *
 * `fromBase64` rehydrates the persisted base64 into the `Buffer` Electron's
 * `decryptString` wants — pass `(b64) => Buffer.from(b64, 'base64')`. It is a
 * parameter, not a hard-coded `Buffer.from`, so this file needs no Node types.
 *
 * @example
 * ```ts
 * import { safeStorage } from 'electron';
 * import Store from 'electron-store';
 * import { createTokenStorage, safeStorageCipher } from '@atlasauth/electron';
 *
 * const storage = createTokenStorage({
 *   store: new Store({ name: 'atlas-tokens' }),
 *   cipher: safeStorageCipher(safeStorage, (b64) => Buffer.from(b64, 'base64')),
 * });
 * ```
 */
export function safeStorageCipher(
  safeStorage: SafeStorageLike,
  fromBase64: (b64: string) => unknown,
): Cipher | null {
  if (!safeStorage.isEncryptionAvailable()) return null;
  return {
    encrypt: (plainText) => safeStorage.encryptString(plainText).toString('base64'),
    decrypt: (cipherText) => safeStorage.decryptString(fromBase64(cipherText)),
  };
}
