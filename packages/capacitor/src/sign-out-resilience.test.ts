import { describe, expect, it, vi } from 'vitest';
import { SessionTombstones } from '@atlasauth/js';
import { createAtlasCapacitor, type CreateAtlasCapacitorConfig } from './index';
import type { CapacitorPlugins, PreferencesPlugin } from './plugins';
import { createPreferencesTombstoneStore, type TokenStore } from './token-store';

/**
 * A sign-out the server never confirmed must not be undone: not by a refresh
 * that was in flight, and not by the next app start finding the session still
 * in the store (a clear that failed). The handle remembers the session it
 * signed out of — in the platform store — and refuses to re-adopt it. Native
 * twin of @atlasauth/react's sign-out-resilience tests: a "restart" is a fresh
 * `createAtlasCapacitor()` over the same fake Preferences.
 */

const FRONTEND = 'https://fapi.example.test';
const SESSION_KEY = 'atlas.native_session';

function fakePreferences(): PreferencesPlugin & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async ({ key }) => ({ value: map.get(key) ?? null }),
    set: async ({ key, value }) => {
      map.set(key, value);
    },
    remove: async ({ key }) => {
      map.delete(key);
    },
  };
}

const plugins = (prefs: PreferencesPlugin): CapacitorPlugins => ({
  Browser: null,
  App: null,
  Preferences: prefs,
  Capacitor: { isNativePlatform: () => true },
});

const stored = (sid: string, jwt = `${sid}.jwt`) =>
  JSON.stringify({ sessionToken: jwt, refreshToken: `refr_${sid}`, sessionId: sid, expiresInSeconds: 60 });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Call = { method: string; path: string; authorization: string | null };
type Route = (call: Call) => Response | Promise<Response> | undefined | void;

function fakeFetch(route: Route) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: new URL(String(input)).pathname,
      authorization: new Headers(init?.headers).get('authorization'),
    };
    calls.push(call);
    const answer = (await route(call)) as Response | undefined;
    return answer ?? json(null, 404);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const revokes = (calls: Call[]) => calls.filter((c) => c.path.endsWith('/revoke'));
const tombstonesIn = async (prefs: PreferencesPlugin) => {
  const t = new SessionTombstones({ frontendApi: FRONTEND, store: createPreferencesTombstoneStore(prefs) });
  await t.ready;
  return t;
};

function boot(prefs: PreferencesPlugin, fetchImpl: typeof fetch, extra: Partial<CreateAtlasCapacitorConfig> = {}) {
  return createAtlasCapacitor({
    publishableKey: 'pk_test',
    frontendApi: FRONTEND,
    plugins: plugins(prefs),
    fetchImpl,
    now: () => 1_000_000,
    signOutRetryDelaysMs: [],
    ...extra,
  });
}

describe('signOut() resilience', () => {
  it('resolves { revoked: true }, revoking as the session, and clears the store', async () => {
    const prefs = fakePreferences();
    prefs.map.set(SESSION_KEY, stored('sess_1'));
    const { fetchImpl, calls } = fakeFetch((c) =>
      c.path === '/v1/client/sessions/sess_1/revoke' ? json({ status: 'revoked' }) : undefined,
    );
    const atlas = await boot(prefs, fetchImpl);
    expect(atlas.getSession()?.sessionId).toBe('sess_1');

    await expect(atlas.signOut()).resolves.toEqual({ revoked: true });
    expect(revokes(calls)).toEqual([
      { method: 'POST', path: '/v1/client/sessions/sess_1/revoke', authorization: 'Bearer sess_1.jwt' },
    ]);
    expect(atlas.getSession()).toBeNull();
    expect(await atlas.getToken()).toBeNull();
    expect(prefs.map.has(SESSION_KEY)).toBe(false);
  });

  it('retries once, then signs out locally; a refresh in flight does not bring the session back', async () => {
    const prefs = fakePreferences();
    prefs.map.set(SESSION_KEY, stored('sess_1'));
    let clock = 1_000_000;
    let releaseRefresh: (() => void) | null = null;
    const { fetchImpl, calls } = fakeFetch((c) => {
      if (c.path.endsWith('/revoke')) return json({}, 503);
      if (c.path === '/v1/client/sessions/sess_1/tokens') {
        return new Promise<Response>((resolve) => {
          releaseRefresh = () =>
            resolve(json({ jwt: 'sess_1.jwt.rotated', session_id: 'sess_1', refresh_token: 'refr_2', expires_in: 60 }));
        });
      }
    });
    const atlas = await boot(prefs, fetchImpl, { now: () => clock, signOutRetryDelaysMs: [60_000] });
    const listener = vi.fn();
    atlas.onChange(listener);

    // The token is due: a refresh starts and is still in flight at sign-out.
    clock = 1_060_000;
    const inFlight = atlas.getToken();
    await vi.waitFor(() => expect(releaseRefresh).not.toBeNull());

    await expect(atlas.signOut()).resolves.toEqual({ revoked: false });
    expect(revokes(calls)).toHaveLength(2);
    expect(atlas.getSession()).toBeNull();
    expect(prefs.map.has(SESSION_KEY)).toBe(false);
    await vi.waitFor(async () => expect((await tombstonesIn(prefs)).has('sess_1')).toBe(true));

    releaseRefresh!();
    expect(await inFlight).toBeNull();
    expect(atlas.getSession()).toBeNull();
    expect(prefs.map.has(SESSION_KEY)).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it('a restart after a failed revoke stays signed out; a later revoke clears the tombstone; a new session is adopted', async () => {
    const prefs = fakePreferences();
    prefs.map.set(SESSION_KEY, stored('sess_1'));
    // A store whose clear never lands: the signed-out session is still there on restart.
    const sticky: TokenStore = {
      getToken: async () => prefs.map.get(SESSION_KEY) ?? null,
      setToken: async (value) => {
        prefs.map.set(SESSION_KEY, value);
      },
      clearToken: async () => {
        throw new Error('keychain locked');
      },
    };
    let revokeWorks = false;
    const route: Route = (c) => {
      if (c.path === '/v1/client/sessions/sess_1/revoke') return revokeWorks ? json({ status: 'revoked' }) : json({}, 503);
    };

    const first = fakeFetch(route);
    const app1 = await boot(prefs, first.fetchImpl, { storage: sticky });
    await expect(app1.signOut()).resolves.toEqual({ revoked: false });
    expect(app1.getSession()).toBeNull();
    expect(prefs.map.has(SESSION_KEY)).toBe(true);
    await vi.waitFor(async () => expect((await tombstonesIn(prefs)).has('sess_1')).toBe(true));

    // (1) Restart: the stored session is refused, and its revoke re-tried in the
    // background — authenticated as the dropped session (still failing).
    const second = fakeFetch(route);
    const app2 = await boot(prefs, second.fetchImpl, { storage: sticky });
    expect(app2.getSession()).toBeNull();
    expect(await app2.getToken()).toBeNull();
    await vi.waitFor(() => expect(revokes(second.calls).length).toBeGreaterThan(0));
    expect(revokes(second.calls)[0]!.authorization).toBe('Bearer sess_1.jwt');
    expect((await tombstonesIn(prefs)).has('sess_1')).toBe(true);

    // (2) The server is reachable again: the next start's background revoke
    // lands and the tombstone is cleared — still signed out.
    revokeWorks = true;
    const third = fakeFetch(route);
    const app3 = await boot(prefs, third.fetchImpl, { storage: sticky });
    expect(app3.getSession()).toBeNull();
    await vi.waitFor(async () => expect((await tombstonesIn(prefs)).has('sess_1')).toBe(false));

    // (3) A new sign-in gives a new session id, which is adopted normally.
    const listener = vi.fn();
    app3.onChange(listener);
    app3.manager.setSession(JSON.parse(stored('sess_2')));
    expect(app3.getSession()?.sessionId).toBe('sess_2');
    expect(await app3.getToken()).toBe('sess_2.jwt');
    expect(listener).toHaveBeenCalledOnce();
    expect(JSON.parse(prefs.map.get(SESSION_KEY)!).sessionId).toBe('sess_2');
  });

  it('{ strict: true } rejects with a SignOutError after the local sign-out', async () => {
    const prefs = fakePreferences();
    prefs.map.set(SESSION_KEY, stored('sess_1'));
    const { fetchImpl } = fakeFetch((c) => {
      if (c.path.endsWith('/revoke')) throw new TypeError('offline');
    });
    const atlas = await boot(prefs, fetchImpl);
    const error = await atlas.signOut({ strict: true }).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'SignOutError', code: 'SIGN_OUT_REVOKE_FAILED', sessionId: 'sess_1', status: 0 });
    expect(atlas.getSession()).toBeNull();
    expect(prefs.map.has(SESSION_KEY)).toBe(false);
  });

  it('reports a promoted active_session_id without adopting it (no bearer credential comes with it)', async () => {
    const prefs = fakePreferences();
    prefs.map.set(SESSION_KEY, stored('sess_1'));
    const { fetchImpl } = fakeFetch((c) =>
      c.path.endsWith('/sessions/sess_1/revoke') ? json({ status: 'revoked', active_session_id: 'sess_2' }) : undefined,
    );
    const atlas = await boot(prefs, fetchImpl);
    await expect(atlas.signOut()).resolves.toEqual({ revoked: true, activeSessionId: 'sess_2' });
    expect(atlas.getSession()).toBeNull();
  });

  it('revokes even when the cached JWT has expired (rotates it once with the refresh token)', async () => {
    const prefs = fakePreferences();
    prefs.map.set(SESSION_KEY, stored('sess_7', 'stale.jwt'));
    const { fetchImpl, calls } = fakeFetch((c) => {
      if (c.path === '/v1/client/sessions/sess_7/revoke') {
        return c.authorization === 'Bearer fresh.jwt' ? json({ status: 'revoked' }) : json({}, 401);
      }
      if (c.path === '/v1/client/sessions/sess_7/tokens') {
        return json({ jwt: 'fresh.jwt', session_id: 'sess_7', refresh_token: 'refr_8', expires_in: 60 });
      }
    });
    const atlas = await boot(prefs, fetchImpl);
    await expect(atlas.signOut()).resolves.toEqual({ revoked: true });
    expect(revokes(calls).map((c) => c.authorization)).toEqual(['Bearer stale.jwt', 'Bearer fresh.jwt']);
    // The rotated session belongs to the dropped holder: never persisted.
    expect(prefs.map.has(SESSION_KEY)).toBe(false);
  });

  it('signed out already: resolves { revoked: true } without a request', async () => {
    const prefs = fakePreferences();
    const { fetchImpl, calls } = fakeFetch(() => undefined);
    const atlas = await boot(prefs, fetchImpl);
    await expect(atlas.signOut()).resolves.toEqual({ revoked: true });
    expect(calls).toHaveLength(0);
  });
});
