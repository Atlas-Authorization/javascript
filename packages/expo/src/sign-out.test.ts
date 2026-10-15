import { describe, expect, it, vi } from 'vitest';
import { SessionTombstones, revokeSession } from '@atlasauth/js';
import { createCacheFetch } from './cache-fetch';
import {
  DEFAULT_SESSION_KEY,
  createInMemoryTokenCache,
  createSecureStoreTokenCache,
  tombstoneStoreFor,
  type SecureStore,
  type TokenCache,
} from './token-cache';

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  // The provider is a thin wrapper: run its one `useState` initializer directly
  // (this package has no DOM renderer) and inspect what it hands to React's provider.
  return {
    ...actual,
    useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => undefined],
  };
});

/**
 * Sign-out on Expo: React's provider drops its in-memory state, but the session
 * credential is the bearer token in the TokenCache, and React Native has no
 * `localStorage` for the sign-out tombstones. These prove a confirmed revoke
 * drops the token, a failed one keeps it for the background re-try, and the
 * tombstone survives an app restart (a fresh cache-fetch + tombstones over the
 * same store).
 */

const BASE = 'https://fapi.example.test';
const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwtFor = (sid: string, n = 1) => `${b64({ alg: 'none' })}.${b64({ sid, n })}.sig`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A fake expo-secure-store that, like the real one, refuses keys outside `[A-Za-z0-9._-]`. */
function fakeSecureStore(): SecureStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  const check = (key: string) => {
    if (!/^[A-Za-z0-9._-]+$/.test(key)) throw new Error(`Invalid key provided to SecureStore: ${key}`);
  };
  return {
    map,
    getItemAsync: async (key) => {
      check(key);
      return map.get(key) ?? null;
    },
    setItemAsync: async (key, value) => {
      check(key);
      map.set(key, value);
    },
    deleteItemAsync: async (key) => {
      check(key);
      map.delete(key);
    },
  };
}

type Handler = (url: string, init: RequestInit | undefined, auth: string | null) => Response | Promise<Response>;

function server(handler: Handler) {
  const calls: { method: string; url: string; auth: string | null }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get('authorization');
    calls.push({ method: init?.method ?? 'GET', url, auth });
    return handler(url, init, auth);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** The provider's FAPI request, bound to one cache-fetch (what React's `call` does). */
const requestVia = (cacheFetch: typeof fetch) => (path: string, init?: RequestInit) =>
  cacheFetch(`${BASE}${path}`, init);

describe('createCacheFetch on sign-out', () => {
  async function revokeWith(response: () => Response | Promise<Response>, token = jwtFor('sess_1')) {
    const cache = createInMemoryTokenCache();
    await cache.saveToken(DEFAULT_SESSION_KEY, token);
    const { fetchImpl, calls } = server(() => response());
    const cacheFetch = createCacheFetch({ cache, key: DEFAULT_SESSION_KEY, fetchImpl });
    const res = await cacheFetch(`${BASE}/v1/client/sessions/sess_1/revoke`, { method: 'POST' }).catch(() => null);
    await flush();
    return { cache, calls, res, stored: await cache.getToken(DEFAULT_SESSION_KEY) };
  }

  it('clears the stored token once the revoke succeeds (the server response shape)', async () => {
    const { stored, calls, res } = await revokeWith(() => json({ object: 'session', id: 'sess_1', status: 'revoked' }));
    // The revoke itself was authenticated with the token…
    expect(calls[0]!.auth).toBe(`Bearer ${jwtFor('sess_1')}`);
    // …and the token is gone before the caller sees the response.
    expect(stored ?? null).toBeNull();
    expect(res!.status).toBe(200);
  });

  it('clears it on a 404 (the session is already gone)', async () => {
    const { stored } = await revokeWith(() => json({ error: 'not_found' }, 404));
    expect(stored ?? null).toBeNull();
  });

  it('keeps it when the revoke fails, so the background re-try can authenticate', async () => {
    expect((await revokeWith(() => json({}, 503))).stored).toBe(jwtFor('sess_1'));
    expect(
      (
        await revokeWith(() => {
          throw new TypeError('offline');
        })
      ).stored,
    ).toBe(jwtFor('sess_1'));
  });

  it('keeps the token when another session is revoked', async () => {
    const { stored } = await revokeWith(() => json({ status: 'revoked' }), jwtFor('sess_other'));
    expect(stored).toBe(jwtFor('sess_other'));
  });

  it('still persists a jwt the revoke response carries (a promoted session)', async () => {
    const { stored } = await revokeWith(() =>
      json({ status: 'revoked', active_session_id: 'sess_2', jwt: jwtFor('sess_2') }),
    );
    expect(stored).toBe(jwtFor('sess_2'));
  });

  it('leaves other POSTs alone', async () => {
    const cache = createInMemoryTokenCache();
    await cache.saveToken(DEFAULT_SESSION_KEY, jwtFor('sess_1'));
    const { fetchImpl } = server(() => json({ ok: true }));
    const cacheFetch = createCacheFetch({ cache, key: DEFAULT_SESSION_KEY, fetchImpl });
    await cacheFetch(`${BASE}/v1/client/sessions/sess_1/touch`, { method: 'POST' });
    await cacheFetch(`${BASE}/v1/client/sessions/sess_1/revoke`); // a GET is not a revoke
    expect(await cache.getToken(DEFAULT_SESSION_KEY)).toBe(jwtFor('sess_1'));
  });
});

describe('tombstoneStoreFor', () => {
  it('keeps tombstones in the token cache under a secure-store-safe key', async () => {
    const secure = fakeSecureStore();
    const cache = createSecureStoreTokenCache(secure);
    const tombstones = new SessionTombstones({ frontendApi: BASE, store: tombstoneStoreFor(cache) });
    await tombstones.ready;
    tombstones.add('sess_1');
    await flush();
    const keys = [...secure.map.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(secure.map.get(keys[0]!)).toContain('sess_1');

    // A restart: a fresh instance over the same store reads it back.
    const restarted = new SessionTombstones({ frontendApi: BASE, store: tombstoneStoreFor(createSecureStoreTokenCache(secure)) });
    await restarted.ready;
    expect(restarted.has('sess_1')).toBe(true);
  });
});

describe('a failed sign-out survives an app restart', () => {
  it('the restarted app refuses the session, and the background revoke clears token and tombstone', async () => {
    const secure = fakeSecureStore();
    let revokeWorks = false;
    let live = true; // the server-side session
    const handler: Handler = (url, _init, auth) => {
      if (url.endsWith('/v1/client')) {
        return auth && live
          ? json({ session: { id: 'sess_1', status: 'active' }, user: { id: 'user_1' }, jwt: jwtFor('sess_1', 2) })
          : json({ session: null, user: null });
      }
      if (url.endsWith('/v1/client/sessions/sess_1/revoke')) {
        if (!revokeWorks) return json({}, 503);
        live = false;
        return json({ object: 'session', id: 'sess_1', status: 'revoked' });
      }
      return json({});
    };

    // App run 1: signed in, then signOut() whose revoke fails twice.
    const wire = (cache: TokenCache) => {
      const { fetchImpl, calls } = server(handler);
      const cacheFetch = createCacheFetch({ cache, key: DEFAULT_SESSION_KEY, fetchImpl });
      const tombstones = new SessionTombstones({ frontendApi: BASE, store: tombstoneStoreFor(cache) });
      return { request: requestVia(cacheFetch), tombstones, calls };
    };
    const cache1 = createSecureStoreTokenCache(secure);
    await cache1.saveToken(DEFAULT_SESSION_KEY, jwtFor('sess_1'));
    const run1 = wire(cache1);
    await run1.tombstones.ready;
    run1.tombstones.add('sess_1');
    const outcome = await revokeSession(run1.request, 'sess_1');
    expect(outcome.revoked).toBe(false);
    await flush();
    // The token stays (the re-try needs it); the tombstone is persisted.
    expect(await cache1.getToken(DEFAULT_SESSION_KEY)).toBe(jwtFor('sess_1'));

    // App run 2: a fresh cache, cache-fetch and tombstones over the same store.
    const cache2 = createSecureStoreTokenCache(secure);
    const run2 = wire(cache2);
    await run2.tombstones.ready;
    const boot = (await (await run2.request('/v1/client')).json()) as { session: { id: string } | null };
    // The bearer still authenticates, so the server returns the session — refused.
    expect(boot.session?.id).toBe('sess_1');
    expect(run2.tombstones.has('sess_1')).toBe(true);
    await flush(); // the boot's rotated jwt is persisted

    // The background revoke (what the provider runs for a refused session) lands.
    revokeWorks = true;
    const retry = await revokeSession(run2.request, 'sess_1', { retries: 0 });
    expect(retry.revoked).toBe(true);
    expect(run2.calls.at(-1)!.auth).toBe(`Bearer ${jwtFor('sess_1', 2)}`);
    run2.tombstones.remove('sess_1');
    await flush();
    expect(await cache2.getToken(DEFAULT_SESSION_KEY)).toBeNull();

    // App run 3: nothing to refuse and no token — a clean signed-out boot.
    const run3 = wire(createSecureStoreTokenCache(secure));
    await run3.tombstones.ready;
    expect(run3.tombstones.has('sess_1')).toBe(false);
    const boot3 = (await (await run3.request('/v1/client')).json()) as { session: unknown };
    expect(boot3.session).toBeNull();
    expect(run3.calls[0]!.auth).toBeNull();
  });
});

describe('<AtlasProvider> (expo) wiring', () => {
  it('hands React the cache-fetch and a tombstone store over the same token cache', async () => {
    const { AtlasProvider } = await import('./AtlasProvider');
    const { AtlasProvider: ReactAtlasProvider } = await import('@atlasauth/react');
    const cache = createInMemoryTokenCache();
    await cache.saveToken(DEFAULT_SESSION_KEY, jwtFor('sess_1'));
    const { fetchImpl, calls } = server(() => json({}));
    const element = AtlasProvider({
      publishableKey: 'pk_test_x',
      frontendApi: BASE,
      tokenCache: cache,
      fetchImpl,
      children: null,
    });
    expect(element.type).toBe(ReactAtlasProvider);
    const props = element.props as {
      tombstoneStore: { getItem(k: string): unknown; setItem(k: string, v: string): unknown };
      fetchImpl: typeof fetch;
    };
    await props.fetchImpl(`${BASE}/v1/client`);
    expect(calls[0]!.auth).toBe(`Bearer ${jwtFor('sess_1')}`);
    await props.tombstoneStore.setItem('atlas:signed-out-sessions:https://fapi.example.test', '["x"]');
    expect(await props.tombstoneStore.getItem('atlas:signed-out-sessions:https://fapi.example.test')).toBe('["x"]');
    expect(await cache.getToken('atlas_signed-out-sessions_https___fapi.example.test')).toBe('["x"]');
  });

  it('lets an explicit tombstoneStore win', async () => {
    const { AtlasProvider } = await import('./AtlasProvider');
    const own = { getItem: () => null, setItem: () => undefined };
    const element = AtlasProvider({
      publishableKey: 'pk_test_x',
      frontendApi: BASE,
      tombstoneStore: own,
      fetchImpl: server(() => json({})).fetchImpl,
      children: null,
    });
    expect((element.props as { tombstoneStore: unknown }).tombstoneStore).toBe(own);
  });
});
