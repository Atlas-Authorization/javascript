import { describe, expect, it } from 'vitest';
import { serializeNativeSession, type NativeSession } from '@atlasauth/js';
import { clearNativeSession, createNativeSessionManager } from './native-session';
import type { TokenStorage } from './token-cache';

const BASE = 'https://fapi.example.test';

/** A fake TokenStorage backed by a mutable local, so tests can inspect it. */
function fakeStorage(initial: string | null = null): TokenStorage & { value: string | null } {
  const store = {
    value: initial,
    getToken: () => store.value,
    setToken: (t: string) => {
      store.value = t;
    },
    clearToken: () => {
      store.value = null;
    },
  };
  return store;
}

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

describe('createNativeSessionManager (expo)', () => {
  it('rehydrates the manager from the secure store', async () => {
    const storage = fakeStorage(serializeNativeSession(session1));
    const mgr = await createNativeSessionManager({
      frontendApi: BASE,
      publishableKey: 'pk_test',
      storage,
      now: () => 1_000_000, // fresh
    });
    expect(mgr.current?.sessionToken).toBe('sess.jwt.1');
    expect(await mgr.getToken()).toBe('sess.jwt.1');
  });

  it('boots signed-out from an empty store', async () => {
    const mgr = await createNativeSessionManager({
      frontendApi: BASE,
      publishableKey: 'pk_test',
      storage: fakeStorage(null),
    });
    expect(mgr.current).toBeNull();
    expect(await mgr.getToken()).toBeNull();
  });

  it('persists the rotated session back to the secure store', async () => {
    const storage = fakeStorage(serializeNativeSession(session1));
    let clock = 1_000_000;
    const mgr = await createNativeSessionManager({
      frontendApi: BASE,
      publishableKey: 'pk_test',
      storage,
      fetchImpl: refreshRouter(),
      now: () => clock,
    });
    clock += 55_000; // inside the refresh lead window
    expect(await mgr.getToken()).toBe('sess.jwt.2');
    // The rotated refresh token is what was written to the secure store.
    expect(JSON.parse(storage.value!)).toMatchObject({ sessionToken: 'sess.jwt.2', refreshToken: 'refr_2' });
  });
});

describe('createNativeSessionManager config', () => {
  it('refuses a missing frontendApi with a clear config error', async () => {
    await expect(
      createNativeSessionManager({ frontendApi: undefined as unknown as string, publishableKey: 'pk_test' }),
    ).rejects.toMatchObject({ name: 'AtlasConfigError', code: 'FRONTEND_API_REQUIRED' });
  });
});

describe('clearNativeSession', () => {
  it('drops the persisted session', async () => {
    const storage = fakeStorage(serializeNativeSession(session1));
    await clearNativeSession(storage);
    expect(storage.value).toBeNull();
  });
});
