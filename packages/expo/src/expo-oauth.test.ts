import { describe, expect, it, vi } from 'vitest';
import { FapiClient } from '@atlasauth/js';
import { createExpoOAuth, isExpoGo } from './expo-oauth';
import { createExpoNativeContext } from './fapi-context';
import { createCacheFetch } from './cache-fetch';
import { createInMemoryTokenCache } from './token-cache';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const START = { authorization_url: 'https://provider.test/auth', attempt_id: 'att_1', redirect_url: 'https://fapi.test/v1/oauth/native-callback/napp_1' };

function setup(browserResult: { type: string; url?: string }, modules: Record<string, unknown> = {}) {
  const calls: Array<{ path: string; body: any }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: init.body ? JSON.parse(init.body as string) : null });
    return path.endsWith('/oauth/token') ? json(200, { object: 'session', jwt: 'a.b.c', session_id: 's1' }) : json(200, START);
  }) as unknown as typeof fetch;
  const client = new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://fapi.test', fetchImpl, exposeSession: false });
  const webBrowser = { openAuthSessionAsync: vi.fn(async () => browserResult) };
  const adopt = vi.fn(async () => {});
  const setPending = vi.fn();
  const oauth = createExpoOAuth({ client, appId: 'napp_1', adopt, setPending, modules: { webBrowser, linking: { createURL: (p: string) => `exp://192.168.1.5:8081/--${p}` }, constants: null, ...modules } });
  return { oauth, webBrowser, adopt, setPending, calls };
}

describe('isExpoGo', () => {
  it('detects the store client and the legacy ownership flag', () => {
    expect(isExpoGo({ executionEnvironment: 'storeClient' })).toBe(true);
    expect(isExpoGo({ appOwnership: 'expo' })).toBe(true);
    expect(isExpoGo({ executionEnvironment: 'standalone' })).toBe(false);
    expect(isExpoGo(null)).toBe(false);
  });
});

describe('createExpoOAuth.signInWithSSO', () => {
  it('starts the enterprise route with the Expo callback and adopts the jwt', async () => {
    const t = setup({ type: 'success', url: 'exp://192.168.1.5:8081/--/atlas-oauth?__atlas_attempt=att_1&__atlas_code=c1' });
    expect(await t.oauth.signInWithSSO({ identifier: 'ada@example.com', strategy: 'wsfed' })).toEqual({ status: 'complete', errors: [] });
    expect(t.calls[0]!.path).toBe('/v1/client/sign_ins/wsfed');
    expect(t.calls[0]!.body).toMatchObject({ email: 'ada@example.com', native_app_id: 'napp_1', callback: 'exp://192.168.1.5:8081/--/atlas-oauth' });
    expect(t.calls[1]!.path).toBe('/v1/client/sign_ins/oauth/token');
    expect(t.adopt).toHaveBeenCalledWith('a.b.c');
  });

  it('defaults to the OIDC SSO route', async () => {
    const t = setup({ type: 'cancel' });
    expect(await t.oauth.signInWithSSO({ connectionId: 'ssoc_1' })).toEqual({ status: 'cancelled', errors: [] });
    expect(t.calls[0]!.path).toBe('/v1/client/sign_ins/sso');
  });
});

describe('createExpoOAuth.signInWithOAuth', () => {
  it('completes: sends the Expo callback, the app id and a non-ephemeral session, then adopts the jwt', async () => {
    const t = setup({ type: 'success', url: 'exp://192.168.1.5:8081/--/atlas-oauth?__atlas_attempt=att_1&__atlas_code=c1' });
    expect(await t.oauth.signInWithOAuth('discord')).toEqual({ status: 'complete', errors: [] });
    expect(t.calls[0]!.body).toMatchObject({ provider: 'discord', native_app_id: 'napp_1', callback: 'exp://192.168.1.5:8081/--/atlas-oauth' });
    expect(t.webBrowser.openAuthSessionAsync).toHaveBeenCalledWith('https://provider.test/auth', 'exp://192.168.1.5:8081/--/atlas-oauth', { preferEphemeralSession: false });
    expect(t.adopt).toHaveBeenCalledWith('a.b.c');
  });

  it('cancel and dismiss and locked are cancelled', async () => {
    for (const type of ['cancel', 'dismiss', 'locked']) {
      expect(await setup({ type }).oauth.signInWithOAuth('discord')).toEqual({ status: 'cancelled', errors: [] });
    }
  });

  it('hands a second factor to the sign-in screen', async () => {
    const t = setup({ type: 'success', url: 'x://cb?__atlas_attempt=att_1&__atlas_status=needs_second_factor' });
    expect(await t.oauth.signInWithOAuth('discord', { callback: 'x://cb' })).toMatchObject({ status: 'needs_second_factor', attemptId: 'att_1' });
    expect(t.setPending).toHaveBeenCalledWith({ id: 'att_1', status: 'needs_second_factor', codeVerifier: expect.stringMatching(/^[A-Za-z0-9_-]{43,128}$/) });
    expect(t.adopt).not.toHaveBeenCalled();
  });

  it('says what to install when expo-web-browser is missing', async () => {
    const t = setup({ type: 'cancel' }, { webBrowser: null });
    expect(await t.oauth.signInWithOAuth('discord')).toMatchObject({ status: 'error', errors: [{ code: 'EXPO_WEB_BROWSER_MISSING' }] });
    expect(t.calls).toHaveLength(0);
  });
});

describe('createExpoOAuth.signInWithGoogle', () => {
  it('falls back to the browser flow in Expo Go and with no native module', async () => {
    const google = { signIn: vi.fn() };
    const goT = setup({ type: 'success', url: 'x://cb?__atlas_attempt=att_1&__atlas_code=c' }, { constants: { executionEnvironment: 'storeClient' } });
    expect((await goT.oauth.signInWithGoogle(google)).status).toBe('complete');
    expect(goT.calls[0]!.body.provider).toBe('google');
    expect(google.signIn).not.toHaveBeenCalled();
    const noMod = setup({ type: 'cancel' });
    expect(await noMod.oauth.signInWithGoogle(null)).toEqual({ status: 'cancelled', errors: [] });
    expect(noMod.calls[0]!.body.provider).toBe('google');
  });
});

describe('pending attempt hand-off', () => {
  it('delivers an earlier attempt to a screen that mounts later, once', () => {
    const ctx = createExpoNativeContext({ saveToken: async () => {} });
    ctx.setPending({ id: 'att_1', status: 'needs_second_factor' });
    const first = vi.fn();
    ctx.onPending(first);
    expect(first).toHaveBeenCalledWith({ id: 'att_1', status: 'needs_second_factor' });
    const second = vi.fn();
    ctx.onPending(second);
    expect(second).not.toHaveBeenCalled();
    ctx.setPending({ id: 'att_2', status: 'needs_required_action' });
    expect(first).toHaveBeenCalledTimes(2);
  });
});

describe('createCacheFetch appId', () => {
  it('sends X-Atlas-App-Id on every request', async () => {
    let seen: Headers | null = null;
    const f = createCacheFetch({ cache: createInMemoryTokenCache(), key: 'k', appId: 'napp_1', fetchImpl: (async (_i: unknown, init: RequestInit) => { seen = new Headers(init.headers); return json(200, {}); }) as unknown as typeof fetch });
    await f('https://fapi.test/v1/client');
    expect(seen!.get('x-atlas-app-id')).toBe('napp_1');
  });
});
