import { describe, expect, it, vi } from 'vitest';
import { createAtlasCapacitor } from './index';
import type {
  AppPlugin,
  BrowserPlugin,
  CapacitorGlobal,
  CapacitorPlugins,
  PluginListenerHandle,
  PreferencesPlugin,
} from './plugins';

const FRONTEND = 'https://fapi.example.test';
const CLIENT = 'client_abc';
const REDIRECT = 'com.acme.app://auth';
const STATE = 'test-state';

/** A fake Preferences backed by a Map. */
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

/** A fake App that emits the callback the moment the browser opens. */
function fakeApp(): AppPlugin & { emit(url: string): void } {
  let listener: ((event: { url: string }) => void) | null = null;
  const handle: PluginListenerHandle = { remove: () => undefined };
  return {
    addListener: (_n: 'appUrlOpen', cb: (event: { url: string }) => void) => {
      listener = cb;
      return handle;
    },
    emit: (url: string) => listener?.({ url }),
  };
}

function tokenRouter(): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const grant = new URLSearchParams(String(init?.body ?? '')).get('grant_type');
    if (grant === 'authorization_code') {
      return new Response(JSON.stringify({ access_token: 'oauth-access-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({
        access_token: 'sess.jwt.1',
        session_id: 'sess_1',
        refresh_token: 'refr_1',
        expires_in: 60,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
}

function makePlugins(
  app: AppPlugin,
  browser: BrowserPlugin,
  prefs: PreferencesPlugin,
): CapacitorPlugins {
  const capacitor: CapacitorGlobal = { isNativePlatform: () => true };
  return { Browser: browser, App: app, Preferences: prefs, Capacitor: capacitor };
}

describe('createAtlasCapacitor', () => {
  it('signs in through the browser, stores the session, and reads it back', async () => {
    const app = fakeApp();
    const browser: BrowserPlugin = {
      open: vi.fn(async ({ url }: { url: string }) => {
        // Echo the state the SDK generated back on the callback.
        const state = new URL(url).searchParams.get('state')!;
        app.emit(`${REDIRECT}?code=the-code&state=${state}`);
      }),
      close: async () => undefined,
    };
    const prefs = fakePreferences();

    const atlas = await createAtlasCapacitor({
      publishableKey: 'pk_test',
      frontendApi: FRONTEND,
      clientId: CLIENT,
      redirectUri: REDIRECT,
      plugins: makePlugins(app, browser, prefs),
      fetchImpl: tokenRouter(),
      now: () => 1_000_000, // token stays fresh, so getToken does not refresh
    });

    const changes: string[] = [];
    atlas.onChange((s) => changes.push(s.sessionToken));

    expect(atlas.getSession()).toBeNull();

    const outcome = await atlas.signIn();
    expect(browser.open).toHaveBeenCalledOnce();
    expect(outcome.session).toMatchObject({ sessionToken: 'sess.jwt.1' });

    // getSession/getToken read from the manager.
    expect(atlas.getSession()?.sessionToken).toBe('sess.jwt.1');
    expect(await atlas.getToken()).toBe('sess.jwt.1');
    expect(changes).toContain('sess.jwt.1');

    // The session was persisted to the Preferences store (its own slot).
    expect(prefs.map.get('atlas.native_session')).toBeTruthy();
    expect(JSON.parse(prefs.map.get('atlas.native_session')!)).toMatchObject({
      sessionToken: 'sess.jwt.1',
      refreshToken: 'refr_1',
      sessionId: 'sess_1',
    });

    // authHeaders carries the bearer + publishable key.
    expect(await atlas.authHeaders()).toEqual({
      Authorization: 'Bearer sess.jwt.1',
      'x-publishable-key': 'pk_test',
    });
  });

  it('signOut clears the manager and the store', async () => {
    const app = fakeApp();
    const browser: BrowserPlugin = {
      open: async ({ url }: { url: string }) => {
        const state = new URL(url).searchParams.get('state')!;
        app.emit(`${REDIRECT}?code=the-code&state=${state}`);
      },
    };
    const prefs = fakePreferences();
    const atlas = await createAtlasCapacitor({
      publishableKey: 'pk_test',
      frontendApi: FRONTEND,
      clientId: CLIENT,
      redirectUri: REDIRECT,
      plugins: makePlugins(app, browser, prefs),
      fetchImpl: tokenRouter(),
      now: () => 1_000_000,
    });

    await atlas.signIn();
    expect(prefs.map.get('atlas.native_session')).toBeTruthy();

    await atlas.signOut();
    expect(atlas.getSession()).toBeNull();
    expect(await atlas.getToken()).toBeNull();
    expect(prefs.map.has('atlas.native_session')).toBe(false);
  });

  it('rehydrates a stored session on startup', async () => {
    const prefs = fakePreferences();
    prefs.map.set(
      'atlas.native_session',
      JSON.stringify({
        sessionToken: 'persisted.jwt',
        refreshToken: 'refr_0',
        sessionId: 'sess_0',
        expiresInSeconds: 60,
      }),
    );
    const atlas = await createAtlasCapacitor({
      publishableKey: 'pk_test',
      frontendApi: FRONTEND,
      plugins: makePlugins(fakeApp(), { open: async () => undefined }, prefs),
      fetchImpl: tokenRouter(),
      now: () => 1_000_000,
    });
    expect(atlas.getSession()?.sessionToken).toBe('persisted.jwt');
    expect(await atlas.getToken()).toBe('persisted.jwt');
  });

  it('requires clientId and redirectUri to sign in', async () => {
    const atlas = await createAtlasCapacitor({
      publishableKey: 'pk_test',
      frontendApi: FRONTEND,
      plugins: makePlugins(fakeApp(), { open: async () => undefined }, fakePreferences()),
      fetchImpl: tokenRouter(),
    });
    await expect(atlas.signIn()).rejects.toThrow(/clientId/);
    await expect(atlas.signIn({ clientId: CLIENT })).rejects.toThrow(/redirectUri/);
  });
});
