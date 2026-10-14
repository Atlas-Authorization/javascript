import { describe, expect, it } from 'vitest';
import {
  createInMemoryTokenCache,
  createSecureStoreTokenCache,
  tokenStorageFor,
  type SecureStore,
} from './token-cache';
import { createCacheFetch } from './cache-fetch';

/** Let the fire-and-forget persist (a floating promise) settle before asserting. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A fake expo-secure-store, structurally compatible with the real module. */
function fakeSecureStore(): SecureStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItemAsync: async (key) => map.get(key) ?? null,
    setItemAsync: async (key, value) => {
      map.set(key, value);
    },
    deleteItemAsync: async (key) => {
      map.delete(key);
    },
  };
}

describe('createSecureStoreTokenCache', () => {
  it('reads, writes and clears through the secure store', async () => {
    const store = fakeSecureStore();
    const cache = createSecureStoreTokenCache(store);

    expect(await cache.getToken('atlas.session')).toBeNull();
    await cache.saveToken('atlas.session', 'jwt.1');
    expect(store.map.get('atlas.session')).toBe('jwt.1');
    expect(await cache.getToken('atlas.session')).toBe('jwt.1');
    await cache.clearToken('atlas.session');
    expect(await cache.getToken('atlas.session')).toBeNull();
  });

  it('forwards SecureStoreOptions to every call', async () => {
    const seen: unknown[] = [];
    const store: SecureStore = {
      getItemAsync: async (_k, o) => {
        seen.push(o);
        return null;
      },
      setItemAsync: async (_k, _v, o) => {
        seen.push(o);
      },
      deleteItemAsync: async (_k, o) => {
        seen.push(o);
      },
    };
    const opts = { keychainAccessible: 'WHEN_UNLOCKED' };
    const cache = createSecureStoreTokenCache(store, { secureStoreOptions: opts });
    await cache.getToken('k');
    await cache.saveToken('k', 'v');
    await cache.clearToken('k');
    expect(seen).toEqual([opts, opts, opts]);
  });
});

describe('tokenStorageFor', () => {
  it('views a cache + key as a single-slot TokenStorage', async () => {
    const cache = createInMemoryTokenCache();
    const storage = tokenStorageFor(cache, 'atlas.native-session');

    expect(await storage.getToken()).toBeNull();
    await storage.setToken('serialized');
    expect(await storage.getToken()).toBe('serialized');
    // Isolation: a different key is a different slot.
    expect(await cache.getToken('atlas.session')).toBeNull();
    await storage.clearToken();
    expect(await storage.getToken()).toBeNull();
  });
});

describe('createCacheFetch', () => {
  it('attaches the stored token as a bearer header', async () => {
    const cache = createInMemoryTokenCache();
    await cache.saveToken('atlas.session', 'jwt.stored');
    let seenAuth: string | null = null;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenAuth = new Headers(init?.headers).get('authorization');
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const cacheFetch = createCacheFetch({ cache, key: 'atlas.session', fetchImpl });
    await cacheFetch('https://fapi.example.test/v1/client');

    expect(seenAuth).toBe('Bearer jwt.stored');
  });

  it('persists a rotated jwt from a JSON response back to the cache', async () => {
    const cache = createInMemoryTokenCache();
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ jwt: 'jwt.rotated', user: { id: 'u1' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    const cacheFetch = createCacheFetch({ cache, key: 'atlas.session', fetchImpl });
    const response = await cacheFetch('https://fapi.example.test/v1/client');

    // The original body is still consumable by the caller (read off a clone).
    expect(((await response.json()) as { jwt: string }).jwt).toBe('jwt.rotated');
    // …and the rotated token was persisted.
    await flush();
    expect(await cache.getToken('atlas.session')).toBe('jwt.rotated');
  });

  it('does not clobber the cache when the response carries no jwt', async () => {
    const cache = createInMemoryTokenCache();
    await cache.saveToken('atlas.session', 'jwt.existing');
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ user: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    const cacheFetch = createCacheFetch({ cache, key: 'atlas.session', fetchImpl });
    await cacheFetch('https://fapi.example.test/v1/client');
    await flush();

    expect(await cache.getToken('atlas.session')).toBe('jwt.existing');
  });
});
