import { afterEach, describe, expect, it } from 'vitest';
import {
  createMemoryStorageArea,
  DEFAULT_TOKEN_KEY,
  StorageCache,
} from './storage';
import {
  bearerFetch,
  createAtlasClient,
  decodeTokenClaims,
  persistingBearerFetch,
  syncSessionToken,
} from './client';

/**
 * The whole core with only `chrome.storage` and `fetch` faked — no real Chrome,
 * no network. The extension's one job over the web SDK is "cache the token and
 * attach it as a bearer", so that is precisely what these tests pin.
 */

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** A syntactically real, unsigned JWT the client can decode for claims. */
function makeJwt(claims: Record<string, unknown>): string {
  return `eyJhbGciOiJub25lIn0.${b64url(claims)}.sig`;
}

const FRONTEND = 'https://fapi.example.test';

/** Route fake responses by `METHOD /path`; record every request + its headers. */
function router(handlers: Record<string, { status?: number; body?: unknown }>): {
  fetchImpl: typeof fetch;
  calls: Array<{ method: string; path: string; authorization: string | null }>;
} {
  const calls: Array<{ method: string; path: string; authorization: string | null }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const path = new URL(url).pathname;
    const method = (init?.method ?? 'GET').toUpperCase();
    const authorization = new Headers(init?.headers).get('authorization');
    calls.push({ method, path, authorization });
    const handler = handlers[`${method} ${path}`];
    if (!handler) return new Response('null', { status: 404 });
    const { status = 200, body } = handler;
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

// ── StorageCache ────────────────────────────────────────────────────────────

describe('StorageCache', () => {
  it('sets, gets, and removes a token against chrome.storage.local', async () => {
    const cache = new StorageCache({ area: createMemoryStorageArea() });

    expect(await cache.getToken()).toBeNull();

    await cache.setToken('jwt-1');
    expect(await cache.getToken()).toBe('jwt-1');

    await cache.setToken('jwt-2');
    expect(await cache.getToken()).toBe('jwt-2');

    await cache.removeToken();
    expect(await cache.getToken()).toBeNull();
  });

  it('stores under the default key, and a custom key in isolation', async () => {
    const area = createMemoryStorageArea();
    const dflt = new StorageCache({ area });
    const scoped = new StorageCache({ area, key: 'other' });

    await dflt.setToken('a');
    await scoped.setToken('b');

    expect(await area.get(DEFAULT_TOKEN_KEY)).toEqual({ [DEFAULT_TOKEN_KEY]: 'a' });
    expect(await dflt.getToken()).toBe('a');
    expect(await scoped.getToken()).toBe('b');
  });

  it('returns null for a non-string stored value', async () => {
    const area = createMemoryStorageArea();
    await area.set({ [DEFAULT_TOKEN_KEY]: 42 });
    expect(await new StorageCache({ area }).getToken()).toBeNull();
  });

  describe('default (global chrome) resolution', () => {
    afterEach(() => {
      delete (globalThis as { chrome?: unknown }).chrome;
    });

    it('resolves chrome.storage.local lazily off the global', async () => {
      const area = createMemoryStorageArea();
      (globalThis as { chrome?: unknown }).chrome = { storage: { local: area } };

      const cache = new StorageCache();
      await cache.setToken('from-global');
      expect(await area.get(DEFAULT_TOKEN_KEY)).toEqual({
        [DEFAULT_TOKEN_KEY]: 'from-global',
      });
    });

    it('does not touch chrome at construction — only on access', () => {
      // No global chrome set here; constructing must not throw.
      const cache = new StorageCache();
      expect(cache).toBeInstanceOf(StorageCache);
      // The access is what throws.
      return expect(cache.getToken()).rejects.toThrow(/chrome\.storage\.local/);
    });
  });
});

// ── token attach ──────────────────────────────────────────────────────────────

describe('bearerFetch', () => {
  it('attaches the stored token as a bearer, read fresh each call', async () => {
    const area = createMemoryStorageArea();
    const store = new StorageCache({ area });
    const { fetchImpl, calls } = router({ 'GET /v1/client': { body: {} } });
    const wrapped = bearerFetch(fetchImpl, store);

    // Signed out → no Authorization header.
    await wrapped(`${FRONTEND}/v1/client`);
    expect(calls[0]!.authorization).toBeNull();

    // After a token is stored, the next call carries it (not captured earlier).
    await store.setToken('live-jwt');
    await wrapped(`${FRONTEND}/v1/client`);
    expect(calls[1]!.authorization).toBe('Bearer live-jwt');
  });
});

describe('persistingBearerFetch', () => {
  it('captures a jwt from a /v1/client response into the store', async () => {
    const area = createMemoryStorageArea();
    const store = new StorageCache({ area });
    const { fetchImpl } = router({
      'POST /v1/client/sessions/sess_1/tokens': { body: { jwt: 'refreshed-jwt' } },
    });
    const wrapped = persistingBearerFetch(fetchImpl, store);

    await wrapped(`${FRONTEND}/v1/client/sessions/sess_1/tokens`, { method: 'POST' });
    expect(await store.getToken()).toBe('refreshed-jwt');
  });

  it('leaves the store untouched for a response with no jwt', async () => {
    const area = createMemoryStorageArea();
    const store = new StorageCache({ area });
    await store.setToken('existing');
    const { fetchImpl } = router({ 'GET /v1/client': { body: { user: null } } });

    await persistingBearerFetch(fetchImpl, store)(`${FRONTEND}/v1/client`);
    expect(await store.getToken()).toBe('existing');
  });
});

describe('decodeTokenClaims', () => {
  it('reads sid and exp from a JWT, and null from a non-JWT', () => {
    const jwt = makeJwt({ sid: 'sess_9', exp: 123 });
    expect(decodeTokenClaims(jwt)).toMatchObject({ sid: 'sess_9', exp: 123 });
    expect(decodeTokenClaims('not-a-jwt')).toBeNull();
  });
});

// ── client + background sync ────────────────────────────────────────────────

describe('createAtlasClient', () => {
  it('throws a clear config error when frontendApi is missing', () => {
    let caught: unknown;
    try {
      createAtlasClient({ publishableKey: 'pk_test' } as unknown as Parameters<typeof createAtlasClient>[0]);
    } catch (error) {
      caught = error;
    }
    expect((caught as { name?: string }).name).toBe('AtlasConfigError');
    expect((caught as { code?: string }).code).toBe('FRONTEND_API_REQUIRED');
  });

  it('sends the stored token as a bearer on FAPI calls', async () => {
    const store = new StorageCache({ area: createMemoryStorageArea() });
    await store.setToken(makeJwt({ sid: 'sess_1', exp: Date.now() / 1000 + 3600 }));
    const { fetchImpl, calls } = router({ 'GET /v1/client': { body: { user: null } } });

    const client = createAtlasClient({
      publishableKey: 'pk_test',
      frontendApi: FRONTEND,
      store,
      fetchImpl,
    });
    await client.fapi.get('/v1/client');

    expect(calls[0]!.path).toBe('/v1/client');
    expect(calls[0]!.authorization).toMatch(/^Bearer /);
  });

  it('signOut revokes server-side and clears the stored token', async () => {
    const store = new StorageCache({ area: createMemoryStorageArea() });
    await store.setToken(makeJwt({ sid: 'sess_5', exp: Date.now() / 1000 + 3600 }));
    const { fetchImpl, calls } = router({
      'POST /v1/client/sessions/sess_5/revoke': { status: 204 },
    });

    const client = createAtlasClient({
      publishableKey: 'pk_test',
      frontendApi: FRONTEND,
      store,
      fetchImpl,
    });
    await client.signOut();

    expect(calls.map((c) => `${c.method} ${c.path}`)).toContain(
      'POST /v1/client/sessions/sess_5/revoke',
    );
    expect(await store.getToken()).toBeNull();
  });
});

describe('syncSessionToken', () => {
  it('refreshes a near-expiry token and persists the new one', async () => {
    const store = new StorageCache({ area: createMemoryStorageArea() });
    // exp 5s out — inside the 10s refresh lead window.
    const stale = makeJwt({ sid: 'sess_7', exp: Date.now() / 1000 + 5 });
    await store.setToken(stale);
    const fresh = makeJwt({ sid: 'sess_7', exp: Date.now() / 1000 + 3600 });
    const { fetchImpl, calls } = router({
      'POST /v1/client/sessions/sess_7/tokens': { body: { jwt: fresh } },
    });

    const client = createAtlasClient({
      publishableKey: 'pk_test',
      frontendApi: FRONTEND,
      store,
      fetchImpl,
    });
    const result = await syncSessionToken(client);

    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/v1/client/sessions/sess_7/tokens',
    });
    expect(calls[0]!.authorization).toBe(`Bearer ${stale}`);
    expect(result).toBe(fresh);
    expect(await store.getToken()).toBe(fresh);
  });

  it('does nothing when the token is still comfortably fresh', async () => {
    const store = new StorageCache({ area: createMemoryStorageArea() });
    const fresh = makeJwt({ sid: 'sess_7', exp: Date.now() / 1000 + 3600 });
    await store.setToken(fresh);
    const { fetchImpl, calls } = router({});

    const client = createAtlasClient({
      publishableKey: 'pk_test',
      frontendApi: FRONTEND,
      store,
      fetchImpl,
    });
    expect(await syncSessionToken(client)).toBe(fresh);
    expect(calls).toHaveLength(0);
  });

  it('force-refreshes even a fresh token', async () => {
    const store = new StorageCache({ area: createMemoryStorageArea() });
    await store.setToken(makeJwt({ sid: 'sess_7', exp: Date.now() / 1000 + 3600 }));
    const next = makeJwt({ sid: 'sess_7', exp: Date.now() / 1000 + 7200 });
    const { fetchImpl, calls } = router({
      'POST /v1/client/sessions/sess_7/tokens': { body: { jwt: next } },
    });

    const client = createAtlasClient({
      publishableKey: 'pk_test',
      frontendApi: FRONTEND,
      store,
      fetchImpl,
    });
    expect(await syncSessionToken(client, { force: true })).toBe(next);
    expect(calls).toHaveLength(1);
  });

  it('returns null when signed out', async () => {
    const store = new StorageCache({ area: createMemoryStorageArea() });
    const { fetchImpl, calls } = router({});
    const client = createAtlasClient({
      publishableKey: 'pk_test',
      frontendApi: FRONTEND,
      store,
      fetchImpl,
    });
    expect(await syncSessionToken(client)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('keeps the existing token when the refresh call fails', async () => {
    const store = new StorageCache({ area: createMemoryStorageArea() });
    const stale = makeJwt({ sid: 'sess_7', exp: Date.now() / 1000 + 5 });
    await store.setToken(stale);
    const { fetchImpl } = router({
      'POST /v1/client/sessions/sess_7/tokens': { status: 500 },
    });

    const client = createAtlasClient({
      publishableKey: 'pk_test',
      frontendApi: FRONTEND,
      store,
      fetchImpl,
    });
    expect(await syncSessionToken(client)).toBe(stale);
    expect(await store.getToken()).toBe(stale);
  });
});
