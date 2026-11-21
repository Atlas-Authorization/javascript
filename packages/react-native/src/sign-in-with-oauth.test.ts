import { describe, expect, it, vi } from 'vitest';
import { createAtlasStore } from './store';
import type { TokenStorage } from './storage';

const jwt = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub: 'user_1', sid: 'sess_1', exp: 9999999999 })).toString('base64url')}.sig`;
const START = { authorization_url: 'https://provider.test/auth', attempt_id: 'att_1', redirect_url: 'https://fapi.test/v1/oauth/native-callback/napp_1' };

function setup(callbackUrl: string | null, appId: string | undefined = 'napp_1') {
  const seen: Array<{ path: string; body: any; headers: Headers }> = [];
  const fetchImpl = (async (input: string, init: RequestInit) => {
    const path = new URL(input).pathname;
    seen.push({ path, body: init.body ? JSON.parse(init.body as string) : null, headers: new Headers(init.headers) });
    const body = path.endsWith('/oauth/token') ? { object: 'session', jwt, session_id: 'sess_1' } : path === '/v1/client' ? { user: { id: 'user_1' }, session: { id: 'sess_1' } } : START;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  let token: string | null = null;
  const storage: TokenStorage = { getToken: () => token, setToken: (t) => void (token = t), clearToken: () => void (token = null) };
  const store = createAtlasStore({ publishableKey: 'pk_test_1', frontendApi: 'https://fapi.test', storage, fetchImpl, appId });
  const browser = { openAuthSession: vi.fn(async () => (callbackUrl ? { type: 'success' as const, url: callbackUrl } : { type: 'cancel' as const })) };
  return { store, browser, seen, token: () => token };
}

describe('AtlasStore.signInWithOAuth', () => {
  it('runs PKCE, redeems the code, stores the session and sends X-Atlas-App-Id', async () => {
    const t = setup('exampleapp://cb?__atlas_attempt=att_1&__atlas_code=c1');
    const out = await t.store.signInWithOAuth('discord', { browser: t.browser });
    expect(out).toEqual({ status: 'complete', errors: [] });
    expect(t.token()).toBe(jwt);
    expect(t.store.getSnapshot().status).toBe('signed_in');
    expect(t.seen[0]!.body).toMatchObject({ provider: 'discord', native_app_id: 'napp_1', code_challenge_method: 'S256' });
    expect(t.seen.every((c) => c.headers.get('x-atlas-app-id') === 'napp_1')).toBe(true);
    expect(t.seen[1]!.path).toBe('/v1/client/sign_ins/oauth/token');
  });

  it('a cancelled browser is cancelled and stores nothing', async () => {
    const t = setup(null);
    expect(await t.store.signInWithOAuth('discord', { browser: t.browser })).toEqual({ status: 'cancelled', errors: [] });
    expect(t.token()).toBeNull();
  });

  it('hands a pending second factor back with the attempt id', async () => {
    const t = setup('exampleapp://cb?__atlas_attempt=att_1&__atlas_status=needs_second_factor');
    expect(await t.store.signInWithOAuth('discord', { browser: t.browser })).toMatchObject({ status: 'needs_second_factor', attemptId: 'att_1' });
    expect(t.token()).toBeNull();
  });

  it('refuses to run in a WebView', async () => {
    const t = setup('x');
    const out = await t.store.signInWithOAuth('discord', { browser: t.browser, inWebView: true });
    expect(out).toMatchObject({ status: 'error', errors: [{ code: 'WEBVIEW_NOT_ALLOWED' }] });
    expect(t.seen).toHaveLength(0);
  });
});
