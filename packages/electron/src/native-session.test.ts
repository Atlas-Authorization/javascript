import { describe, expect, it } from 'vitest';
import { serializeNativeSession, type NativeSession } from '@atlasauth/js';
import {
  clearNativeSession,
  createNativeSessionManager,
  DEFAULT_NATIVE_SESSION_KEY,
} from './native-session';
import { createInMemoryTokenStorage, type TokenStorage } from './storage';

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

describe('createNativeSessionManager (electron)', () => {
  it('rehydrates from the main-process store under the default key', async () => {
    const storage = createInMemoryTokenStorage();
    await storage.set(DEFAULT_NATIVE_SESSION_KEY, serializeNativeSession(session1));
    const mgr = await createNativeSessionManager({
      frontendApi: BASE,
      publishableKey: 'pk_test',
      storage,
      now: () => 1_000_000,
    });
    expect(mgr.current?.sessionToken).toBe('sess.jwt.1');
  });

  it('boots signed-out from an empty store', async () => {
    const mgr = await createNativeSessionManager({
      frontendApi: BASE,
      publishableKey: 'pk_test',
      storage: createInMemoryTokenStorage(),
    });
    expect(mgr.current).toBeNull();
  });

  it('persists the rotated session back to the store (encrypted at rest by the store)', async () => {
    const storage = createInMemoryTokenStorage();
    await storage.set(DEFAULT_NATIVE_SESSION_KEY, serializeNativeSession(session1));
    let clock = 1_000_000;
    const mgr = await createNativeSessionManager({
      frontendApi: BASE,
      publishableKey: 'pk_test',
      storage,
      fetchImpl: refreshRouter(),
      now: () => clock,
    });
    clock += 55_000;
    expect(await mgr.getToken()).toBe('sess.jwt.2');
    // Let the fire-and-forget persist settle, then assert the rotated token landed.
    await Promise.resolve();
    expect(JSON.parse((await storage.get(DEFAULT_NATIVE_SESSION_KEY))!)).toMatchObject({
      sessionToken: 'sess.jwt.2',
      refreshToken: 'refr_2',
    });
  });

  it('honours a custom session key', async () => {
    const storage: TokenStorage = createInMemoryTokenStorage();
    await storage.set('my.key', serializeNativeSession(session1));
    const mgr = await createNativeSessionManager({
      frontendApi: BASE,
      publishableKey: 'pk_test',
      storage,
      sessionKey: 'my.key',
      now: () => 1_000_000,
    });
    expect(mgr.current?.sessionId).toBe('sess_1');
  });
});

describe('clearNativeSession', () => {
  it('drops the persisted session under the default key', async () => {
    const storage = createInMemoryTokenStorage();
    await storage.set(DEFAULT_NATIVE_SESSION_KEY, serializeNativeSession(session1));
    await clearNativeSession(storage);
    expect(await storage.get(DEFAULT_NATIVE_SESSION_KEY)).toBeNull();
  });
});
