import { describe, expect, it, vi } from 'vitest';
import { FapiClient } from './fapi';
import {
  exchangeMigrationBrowserSession,
  readAmplifyBrowserSession,
  readFirebaseBrowserSession,
  readAppwriteBrowserSession,
  readMsalBrowserSession,
  readNhostBrowserSession,
  readPocketBaseBrowserSession,
  readSupabaseBrowserSession,
} from './migration-browser-sessions';

/** A Storage with the Web Storage API's semantics. */
function storage(initial: Record<string, string>) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    removeItem: (k: string) => void map.delete(k),
  };
}

const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (payload: Record<string, unknown>) => `${b64url({ alg: 'RS256' })}.${b64url(payload)}.sig`;
const future = () => Math.floor(Date.now() / 1000) + 3600;
const past = () => Math.floor(Date.now() / 1000) - 3600;

function client(status: number, body: unknown) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, client: new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://f.example', fetchImpl, referral: false }) };
}

describe('exchangeMigrationBrowserSession', () => {
  it('posts the token with cookie delivery and clears the old session on success', async () => {
    const clear = vi.fn();
    const { client: c, calls } = client(200, { object: 'session', id: 'sess_1', user_id: 'user_1', jwt: 'atlas.jwt' });
    expect(await exchangeMigrationBrowserSession(c, { source: 'firebase', token: 'old.id.token', clear })).toEqual({
      status: 'complete',
      sessionId: 'sess_1',
      userId: 'user_1',
      jwt: 'atlas.jwt',
    });
    expect(calls).toEqual([{ path: '/v1/client/migrations/firebase/exchange', body: { token: 'old.id.token', delivery: 'cookie' } }]);
    expect(clear).toHaveBeenCalledOnce();
  });

  it('keeps the old session on a transient refusal, clears it on a final one', async () => {
    const clear = vi.fn();
    let { client: c } = client(503, { errors: [{ code: 'unavailable', message: 'x' }] });
    expect(await exchangeMigrationBrowserSession(c, { source: 'cognito', token: 't', clear })).toEqual({ status: 'refused', outcome: 'error' });
    expect(clear).not.toHaveBeenCalled();
    ({ client: c } = client(401, { errors: [{ code: 'bridge_refused', message: 'x', meta: { bridge_outcome: 'expired' } }] }));
    expect(await exchangeMigrationBrowserSession(c, { source: 'cognito', token: 't', clear })).toEqual({ status: 'refused', outcome: 'expired' });
    expect(clear).toHaveBeenCalledOnce();
  });

  it('passes the MFA continuation through, and does nothing without a token', async () => {
    const { client: c } = client(200, { object: 'sign_in_attempt', id: 'sia_1', status: 'needs_second_factor' });
    expect(await exchangeMigrationBrowserSession(c, { source: 'supabase', token: 't' })).toEqual({ status: 'needs_second_factor', attemptId: 'sia_1' });
    expect(await exchangeMigrationBrowserSession(c, { source: 'supabase' })).toEqual({ status: 'none' });
  });
});

describe('vendor readers', () => {
  it('Firebase: a live ID token from storage persistence; an expired one is refreshed with the web API key', async () => {
    const key = 'firebase:authUser:AIzaKey123:[DEFAULT]';
    const live = jwt({ exp: future(), sub: 'uid' });
    let s = storage({ [key]: JSON.stringify({ uid: 'uid', stsTokenManager: { accessToken: live, refreshToken: 'rt', expirationTime: 1 } }) });
    const found = await readFirebaseBrowserSession({ storage: [s], indexedDB: undefined });
    expect(found?.token).toBe(live);
    await found!.clear();
    expect(s.map.has(key)).toBe(false);

    const stale = jwt({ exp: past(), sub: 'uid' });
    s = storage({ [key]: JSON.stringify({ stsTokenManager: { accessToken: stale, refreshToken: 'rt-1' } }) });
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://securetoken.googleapis.com/v1/token?key=AIzaKey123');
      expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({ grant_type: 'refresh_token', refresh_token: 'rt-1' });
      return new Response(JSON.stringify({ id_token: 'fresh.id.token' }), { status: 200 });
    }) as typeof fetch;
    expect((await readFirebaseBrowserSession({ storage: [s], fetchImpl }))?.token).toBe('fresh.id.token');
    expect(await readFirebaseBrowserSession({ storage: [s], apiKey: 'other', fetchImpl })).toBeUndefined();
  });

  it('Amplify: LastAuthUser → idToken, refreshed through REFRESH_TOKEN_AUTH when expired; clear removes the client keys', async () => {
    const p = 'CognitoIdentityServiceProvider.client123';
    const stale = jwt({ exp: past(), iss: 'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_Abc', token_use: 'id' });
    const s = storage({ [`${p}.LastAuthUser`]: 'ada', [`${p}.ada.idToken`]: stale, [`${p}.ada.refreshToken`]: 'rt', other: 'x' });
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://cognito-idp.eu-west-1.amazonaws.com/');
      expect(JSON.parse(String(init?.body))).toEqual({ AuthFlow: 'REFRESH_TOKEN_AUTH', ClientId: 'client123', AuthParameters: { REFRESH_TOKEN: 'rt' } });
      return new Response(JSON.stringify({ AuthenticationResult: { IdToken: 'fresh' } }), { status: 200 });
    }) as typeof fetch;
    const found = await readAmplifyBrowserSession({ storage: [s], fetchImpl });
    expect(found?.token).toBe('fresh');
    await found!.clear();
    expect([...s.map.keys()]).toEqual(['other']);
  });

  it('MSAL: the IdToken credential of a v2/v3 cache; an encrypted v4 entry is not a token', async () => {
    const id = jwt({ exp: future(), oid: 'o' });
    const s = storage({
      'uid.tid-login.windows.net-idtoken-app1-tid---': JSON.stringify({ credentialType: 'IdToken', clientId: 'app1', secret: id }),
      'msal.token.keys.app1': '{}',
      'enc-entry': JSON.stringify({ id: 'x', nonce: 'n', data: 'cipher' }),
    });
    const found = await readMsalBrowserSession({ storage: [s], clientId: 'app1' });
    expect(found?.token).toBe(id);
    await found!.clear();
    expect([...s.map.keys()]).toEqual(['enc-entry']);
    expect(await readMsalBrowserSession({ storage: [storage({ e: JSON.stringify({ id: 'x', data: 'cipher' }) })] })).toBeUndefined();
  });

  it('Supabase SPA, PocketBase and Nhost storage keys', async () => {
    expect((await readSupabaseBrowserSession({ storage: [storage({ 'sb-abc-auth-token': JSON.stringify({ access_token: 'sb.at', refresh_token: 'r' }) })] }))?.token).toBe('sb.at');
    expect((await readPocketBaseBrowserSession({ storage: [storage({ pocketbase_auth: JSON.stringify({ token: 'pb.tok', record: { id: 'r' } }) })] }))?.token).toBe('pb.tok');
    const n = storage({ nhostRefreshToken: 'uuid-rt', nhostRefreshTokenExpiresAt: '2030' });
    const found = await readNhostBrowserSession({ storage: [n] });
    expect(found?.token).toBe('uuid-rt');
    await found!.clear();
    expect(n.map.size).toBe(0);
    expect(await readSupabaseBrowserSession({ storage: [storage({})] })).toBeUndefined();
  });

  it('Appwrite cookieFallback, for one project or the only one', async () => {
    const fallback = { a_session_proj1: 'eyJpZCI6InUxIn0=', a_session_proj1_legacy: 'legacy' };
    const s = storage({ cookieFallback: JSON.stringify(fallback) });
    expect(await readAppwriteBrowserSession({ projectId: 'other', storage: [s] })).toBeUndefined();
    const found = await readAppwriteBrowserSession({ projectId: 'proj1', storage: [s] });
    expect(found?.token).toBe('eyJpZCI6InUxIn0=');
    expect((await readAppwriteBrowserSession({ storage: [s] }))?.token).toBe('eyJpZCI6InUxIn0=');
    await found!.clear();
    expect(s.map.has('cookieFallback')).toBe(false);
  });
});
