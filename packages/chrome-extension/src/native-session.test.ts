import { describe, expect, it } from 'vitest';
import { serializeNativeSession, type NativeSession } from '@atlasauth/js';
import { clearNativeSession, createNativeSessionManager } from './native-session';
import { createMemoryStorageArea, StorageCache } from './storage';

const BASE = 'https://fapi.example.test';

const session1: NativeSession = {
  sessionToken: 'sess.jwt.1',
  refreshToken: 'refr_1',
  sessionId: 'sess_1',
  expiresInSeconds: 60,
};

function refreshRouter(): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({ jwt: 'sess.jwt.2', session_id: 'sess_1', expires_in: 60, refresh_token: 'refr_2' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
}

describe('createNativeSessionManager (chrome-extension)', () => {
  it('rehydrates from chrome.storage via the store', async () => {
    const store = new StorageCache({ area: createMemoryStorageArea() });
    await store.setToken(serializeNativeSession(session1));
    const mgr = await createNativeSessionManager({
      frontendApi: BASE,
      publishableKey: 'pk_test',
      store,
      now: () => 1_000_000,
    });
    expect(mgr.current?.sessionToken).toBe('sess.jwt.1');
  });

  it('boots signed-out from an empty store', async () => {
    const store = new StorageCache({ area: createMemoryStorageArea() });
    const mgr = await createNativeSessionManager({ frontendApi: BASE, publishableKey: 'pk_test', store });
    expect(mgr.current).toBeNull();
  });

  it('persists the rotated session back to chrome.storage', async () => {
    const store = new StorageCache({ area: createMemoryStorageArea() });
    await store.setToken(serializeNativeSession(session1));
    let clock = 1_000_000;
    const mgr = await createNativeSessionManager({
      frontendApi: BASE,
      publishableKey: 'pk_test',
      store,
      fetchImpl: refreshRouter(),
      now: () => clock,
    });
    clock += 55_000;
    expect(await mgr.getToken()).toBe('sess.jwt.2');
    // Let the fire-and-forget chrome.storage write settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(JSON.parse((await store.getToken())!)).toMatchObject({
      sessionToken: 'sess.jwt.2',
      refreshToken: 'refr_2',
    });
  });
});

describe('clearNativeSession', () => {
  it('drops the persisted session', async () => {
    const store = new StorageCache({ area: createMemoryStorageArea() });
    await store.setToken(serializeNativeSession(session1));
    await clearNativeSession(store);
    expect(await store.getToken()).toBeNull();
  });
});
