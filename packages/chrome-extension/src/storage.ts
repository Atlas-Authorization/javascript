/**
 * The extension token store.
 *
 * A browser extension surface — popup, options page, side panel, a content
 * script, and the background service worker — has NO cookie jar to the Atlas
 * FAPI origin. A cross-origin `fetch` from an extension cannot lean on the
 * browser attaching a session cookie the way a first-party web app does, so the
 * whole cookie-based session the web SDK relies on is simply unavailable. The
 * session token therefore has to live somewhere the extension itself controls,
 * and be attached to every request by hand as a bearer.
 *
 * `chrome.storage.local` is that place:
 *   - it SURVIVES the service worker being torn down between events (a plain
 *     module-level variable in a service worker does not — MV3 kills the worker
 *     when idle and re-imports it on the next event, losing memory state);
 *   - it is readable from EVERY extension surface, so the popup that signs the
 *     user in and the background worker that refreshes the token share one copy.
 *
 * This module is the single owner of "where the token lives". Everything else
 * (the FAPI client, the background sync, the React provider) reads and writes it
 * only through the {@link TokenStore} interface below.
 */

import type { TombstoneStore } from '@atlasauth/js';

/**
 * The minimal, structural shape of the two `chrome.storage.local` methods this
 * package uses. Declared here — rather than pulled from `@types/chrome` — so the
 * package type-checks with NO extra type dependency; at runtime the extension
 * platform supplies the real object. MV3's `chrome.storage` methods return a
 * Promise when called without a callback, which is the form used throughout.
 */
export interface ChromeStorageArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

/**
 * The three-method contract the rest of the SDK depends on. `StorageCache` is
 * the shipped `chrome.storage.local` implementation; tests and non-extension
 * prototypes can supply any object with this shape.
 */
export interface TokenStore {
  /** The stored session token, or null when signed out. */
  getToken(): Promise<string | null>;
  /** Persist the session token. Called after sign-in and on every refresh. */
  setToken(token: string): Promise<void>;
  /** Drop the token. Called on sign-out and when a session is rejected. */
  removeToken(): Promise<void>;
}

/** The storage key the token is kept under. Namespaced to avoid collisions. */
export const DEFAULT_TOKEN_KEY = '__atlas_session_token';

export interface StorageCacheOptions {
  /** Override the storage key (e.g. to isolate multiple instances). */
  key?: string;
  /**
   * The backing storage area. Defaults to `chrome.storage.local`, resolved
   * lazily on first use. Inject an in-memory area ({@link createMemoryStorageArea})
   * in tests, or `chrome.storage.session` / `.sync` to change persistence.
   */
  area?: ChromeStorageArea;
}

/**
 * Resolve `chrome.storage.local` off the global. Done lazily (on first access,
 * not at construction) so importing or wiring the SDK never throws in a context
 * where `chrome` is absent — only an actual read/write does.
 */
function resolveChromeLocal(): ChromeStorageArea {
  const runtime = (
    globalThis as { chrome?: { storage?: { local?: ChromeStorageArea } } }
  ).chrome;
  const local = runtime?.storage?.local;
  if (!local) {
    throw new Error(
      '@atlasauth/chrome-extension: chrome.storage.local is unavailable. Run this ' +
        'inside an extension with the "storage" permission in its manifest, or pass ' +
        'a custom `area` to StorageCache (e.g. createMemoryStorageArea()).',
    );
  }
  return local;
}

/**
 * A token cache over `chrome.storage.local`. The session token is a single
 * string value under one key — the extension analogue of the web SDK's cookie.
 */
export class StorageCache implements TokenStore {
  private readonly key: string;
  private area: ChromeStorageArea | null;

  constructor(options: StorageCacheOptions = {}) {
    this.key = options.key ?? DEFAULT_TOKEN_KEY;
    // Held null until first use so construction never touches `chrome`.
    this.area = options.area ?? null;
  }

  private storage(): ChromeStorageArea {
    if (!this.area) this.area = resolveChromeLocal();
    return this.area;
  }

  async getToken(): Promise<string | null> {
    const result = await this.storage().get(this.key);
    const value = result[this.key];
    return typeof value === 'string' ? value : null;
  }

  async setToken(token: string): Promise<void> {
    await this.storage().set({ [this.key]: token });
  }

  async removeToken(): Promise<void> {
    await this.storage().remove(this.key);
  }

  /**
   * A {@link TombstoneStore} over this cache's storage area — where the ids of
   * sessions the extension signed out of are kept, so no surface re-adopts one.
   */
  tombstoneStore(): TombstoneStore {
    return createChromeTombstoneStore(() => this.storage());
  }
}

/**
 * A {@link TombstoneStore} over `chrome.storage.local` (or the given area): the
 * sign-out tombstones `SignOutGuard` keeps (session ids, never tokens), shared by
 * every extension surface and surviving the service worker being torn down.
 * `chrome` is resolved on first use; with none, reads and writes reject (the
 * guard then falls back to memory).
 */
export function createChromeTombstoneStore(
  area?: ChromeStorageArea | (() => ChromeStorageArea),
): TombstoneStore {
  const resolve = (): ChromeStorageArea =>
    typeof area === 'function' ? area() : (area ?? resolveChromeLocal());
  return {
    getItem: async (key) => {
      const value = (await resolve().get(key))[key];
      return typeof value === 'string' ? value : null;
    },
    setItem: async (key, value) => {
      await resolve().set({ [key]: value });
    },
  };
}

/**
 * An in-memory `ChromeStorageArea`, for tests and for prototyping outside an
 * extension. It implements the same async contract as the real thing but keeps
 * everything in a `Map`, so it does NOT survive a process (or service-worker)
 * restart — never ship it as the store in production.
 */
export function createMemoryStorageArea(): ChromeStorageArea {
  const map = new Map<string, unknown>();

  const pick = (keys: string | string[] | null): Record<string, unknown> => {
    if (keys === null) return Object.fromEntries(map);
    const list = Array.isArray(keys) ? keys : [keys];
    const out: Record<string, unknown> = {};
    for (const k of list) {
      if (map.has(k)) out[k] = map.get(k);
    }
    return out;
  };

  return {
    get: (keys) => Promise.resolve(pick(keys)),
    set: (items) => {
      for (const [k, v] of Object.entries(items)) map.set(k, v);
      return Promise.resolve();
    },
    remove: (keys) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) map.delete(k);
      return Promise.resolve();
    },
  };
}
