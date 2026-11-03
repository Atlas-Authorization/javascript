import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApiError, createRelyingParty, memorySidStore, resetOidcCaches, sqlSidStore, type RelyingPartyConfig } from './rp';
import { mockIssuer, type MockIssuer } from './rp-testing';

vi.setConfig({ testTimeout: 30_000 });

/**
 * App-credential keep-alive / end (Sign in with Atlas: no instance secret key),
 * the sid store + back-channel logout, and the `@atlasauth/rp/testing` mock issuer.
 */

const ISSUER = 'https://atlasauth.net';
const APP = 'https://app.example.com';
const SECRET = 'a-test-secret-that-is-at-least-32-characters';

beforeEach(() => resetOidcCaches());

interface Call { url: string; auth: string | null; body: string }

function spy(mock: MockIssuer) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method === 'POST') calls.push({ url: request.url, auth: request.headers.get('authorization'), body: await request.clone().text() });
    return mock.fetch(request);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function makeRp(mock: MockIssuer, extra: Partial<RelyingPartyConfig> = {}) {
  return createRelyingParty({
    issuer: mock.issuer,
    clientId: mock.clientId,
    clientSecret: 'cs_test',
    redirectUri: `${APP}/auth/callback`,
    secret: SECRET,
    fetchImpl: mock.fetch,
    ...extra,
  });
}

const backchannelRequest = (token: string) =>
  new Request(`${APP}/auth/backchannel-logout`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ logout_token: token }),
  });

describe('touchIfDue / endAppSession with app credentials', () => {
  it('touches with client_secret_basic, maps a numeric idle_expires_at, and a gone sid to ended/not_found', async () => {
    const mock = await mockIssuer({ issuer: ISSUER, clientId: 'client_app' });
    await mock.idToken({ sid: 'sid_1' });
    const { fetchImpl, calls } = spy(mock);
    const rp = makeRp(mock, { fetchImpl });
    const touched = await rp.touchIfDue('sid_1', null);
    expect(touched).toMatchObject({ status: 'touched', idleExpiresAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) });
    expect(calls[0]).toEqual({
      url: `${ISSUER}/oauth2/session/touch`,
      auth: `Basic ${btoa('client_app:cs_test')}`,
      body: 'sid=sid_1',
    });
    expect(await rp.touchIfDue('sid_unknown', null)).toEqual({ status: 'ended', reason: 'not_found' });
  });

  it('client_secret_post puts the credentials in the body', async () => {
    const mock = await mockIssuer({ issuer: ISSUER, clientId: 'client_app' });
    await mock.idToken({ sid: 'sid_1' });
    const { fetchImpl, calls } = spy(mock);
    await makeRp(mock, { fetchImpl, clientAuth: 'client_secret_post' }).touchIfDue('sid_1', 0);
    expect(calls[0]!.auth).toBeNull();
    expect(new URLSearchParams(calls[0]!.body).get('client_secret')).toBe('cs_test');
  });

  it('endAppSession ends once, then not_found; other failures throw AtlasApiError', async () => {
    const mock = await mockIssuer({ issuer: ISSUER, clientId: 'client_app' });
    await mock.idToken({ sid: 'sid_1' });
    const rp = makeRp(mock);
    expect(await rp.endAppSession('sid_1')).toBe('ended');
    expect(await rp.endAppSession('sid_1')).toBe('not_found');
    expect(await rp.touchIfDue('sid_1', null)).toEqual({ status: 'ended', reason: 'not_found' });
    const broken = makeRp(mock, { fetchImpl: (async () => new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 })) as typeof fetch });
    const error = await broken.touchIfDue('sid_1', null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AtlasApiError);
    expect((error as AtlasApiError).errors[0]!.code).toBe('invalid_client');
    // A 404 that is not session_not_found (wrong issuer URL) is not "signed out".
    const missing = makeRp(mock, { fetchImpl: (async () => new Response('{}', { status: 404 })) as typeof fetch });
    await expect(missing.endAppSession('sid_1')).rejects.toBeInstanceOf(AtlasApiError);
  });

  it('with a secretKey, touch stays on the Backend API', async () => {
    const mock = await mockIssuer({ issuer: ISSUER, clientId: 'client_app' });
    const urls: string[] = [];
    const rp = makeRp(mock, {
      secretKey: 'sk_test_1',
      apiUrl: 'https://api.example.test',
      fetchImpl: (async (input: Parameters<typeof fetch>[0]) => {
        urls.push(String(input));
        return new Response(JSON.stringify({ idle_expires_at: '2030-01-01T00:00:00.000Z' }), { status: 200 });
      }) as typeof fetch,
    });
    expect(await rp.touchIfDue('sess_1', null)).toMatchObject({ status: 'touched', idleExpiresAt: '2030-01-01T00:00:00.000Z' });
    expect(urls).toEqual(['https://api.example.test/v1/sessions/sess_1/touch']);
  });

  it('a public client (no secret, or clientAuth none) gets a clear TypeError', async () => {
    const mock = await mockIssuer({ issuer: ISSUER, clientId: 'client_app' });
    await expect(makeRp(mock, { clientSecret: undefined }).touchIfDue('sid_1', null)).rejects.toThrow(/clientSecret.*secretKey/);
    await expect(makeRp(mock, { clientAuth: 'none' }).endAppSession('sid_1')).rejects.toBeInstanceOf(TypeError);
  });
});

describe('sid stores', () => {
  it('memorySidStore: take returns and removes every live binding; expired ones are dropped', () => {
    let t = 1_000;
    const store = memorySidStore(() => t);
    store.bind('sid_1', 'app_a', 5_000);
    store.bind('sid_1', 'app_b', new Date(2_000));
    store.bind('sid_2', 'app_c', 5_000);
    t = 3_000;
    expect(store.take('sid_1')).toEqual(['app_a']);
    expect(store.take('sid_1')).toEqual([]);
    expect(store.take('sid_2')).toEqual(['app_c']);
  });

  it('sqlSidStore: upserts on bind and returns only live rows from a delete … returning', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const store = sqlSidStore({
      query: async (sql, params) => {
        queries.push({ sql, params });
        return { rows: sql.startsWith('delete') ? [{ app_session_id: 'app_a', live: true }, { app_session_id: 'app_old', live: false }] : [] };
      },
    });
    await store.bind('sid_1', 'app_a', 5_000);
    expect(queries[0]!.sql).toMatch(/insert into atlas_rp_sessions .* on conflict \(sid, app_session_id\) do update/);
    expect(queries[0]!.params).toEqual(['sid_1', 'app_a', new Date(5_000)]);
    expect(await store.take('sid_1')).toEqual(['app_a']);
    expect(queries[1]!.sql).toMatch(/^delete from atlas_rp_sessions where sid = \$1 returning/);
    expect(queries[1]!.params).toEqual(['sid_1']);
  });
});

describe('@atlasauth/rp/testing round trip', () => {
  it('start → callback → bindSession → backchannelLogout via handle, with only mockIssuer.fetch', async () => {
    const mock = await mockIssuer({ issuer: ISSUER, clientId: 'client_app', alg: 'ES256' });
    const sidStore = memorySidStore();
    const ended: Array<{ ids: string[]; sid?: string }> = [];
    const rp = makeRp(mock, {
      sidStore,
      routes: { backchannelLogout: '/auth/backchannel-logout' },
      onSignedIn: async (user, _tokens, _req, result) => {
        await rp.bindSession(user.sid!, 'app_sess_1', Date.now() + 3_600_000);
        result.response.headers.append('set-cookie', 'app=app_sess_1');
      },
      onBackchannelLogout: (ids, claims) => void ended.push({ ids, sid: claims.sid }),
    });

    mock.nextClaims = { sub: 'user_ada', sid: 'sid_ada', name: 'Ada' };
    const started = (await rp.handle(new Request(`${APP}/auth/sign-in?return_to=%2Fhome`)))!;
    const callbackUrl = mock.authorize(started.headers.get('location')!);
    const cookie = started.headers.get('set-cookie')!.split(';')[0]!;
    const done = (await rp.handle(new Request(callbackUrl, { headers: { cookie } })))!;
    expect(done.status).toBe(302);
    expect(done.headers.get('location')).toBe('/home');
    expect(done.headers.get('set-cookie')).toContain('app=app_sess_1');
    expect(mock.nextClaims).toEqual({});

    const res = (await rp.handle(backchannelRequest(await mock.logoutToken({ sid: 'sid_ada', sub: 'user_ada' }))))!;
    expect(res.status).toBe(200);
    expect(ended).toEqual([{ ids: ['app_sess_1'], sid: 'sid_ada' }]);
    expect(sidStore.take('sid_ada')).toEqual([]);

    // A logout token signed by another key, and an ID token posing as one, are both 400.
    const other = await mockIssuer({ issuer: ISSUER, clientId: 'client_app' });
    expect((await rp.backchannelLogout(backchannelRequest(await other.logoutToken({ sid: 'sid_ada' })))).status).toBe(400);
    expect((await rp.backchannelLogout(backchannelRequest(await mock.idToken({ sid: 'sid_ada' })))).status).toBe(400);
    expect(ended).toHaveLength(1);
  });

  it('a throwing onBackchannelLogout answers 503 and keeps the bindings for the retry', async () => {
    const mock = await mockIssuer({ issuer: ISSUER, clientId: 'client_app' });
    const sidStore = memorySidStore();
    let fail = true;
    const seen: string[][] = [];
    const rp = makeRp(mock, {
      sidStore,
      onBackchannelLogout: (ids) => {
        seen.push(ids);
        if (fail) throw new Error('db down');
      },
    });
    await rp.bindSession('sid_1', 'app_a', Date.now() + 60_000);
    expect((await rp.backchannelLogout(backchannelRequest(await mock.logoutToken({ sid: 'sid_1' })))).status).toBe(503);
    fail = false;
    expect((await rp.backchannelLogout(backchannelRequest(await mock.logoutToken({ sid: 'sid_1' })))).status).toBe(200);
    expect(seen).toEqual([['app_a'], ['app_a']]);
  });

  it('bindSession needs a sidStore; backchannelLogout needs onBackchannelLogout', async () => {
    const mock = await mockIssuer({ issuer: ISSUER, clientId: 'client_app' });
    const rp = makeRp(mock);
    await expect(rp.bindSession('sid_1', 'a', 0)).rejects.toThrow(/sidStore/);
    await expect(rp.backchannelLogout(backchannelRequest('x'))).rejects.toThrow(/onBackchannelLogout/);
  });

  it('the mock token endpoint refuses a reused code and a public client', async () => {
    const mock = await mockIssuer({ issuer: ISSUER, clientId: 'client_app' });
    const url = new URL(mock.authorize(`${ISSUER}/oauth2/authorize?client_id=client_app&redirect_uri=${encodeURIComponent(`${APP}/cb`)}`));
    const redeem = (auth: Record<string, string>) =>
      mock.fetch(`${ISSUER}/oauth2/token`, {
        method: 'POST',
        body: new URLSearchParams({ grant_type: 'authorization_code', code: url.searchParams.get('code')!, redirect_uri: `${APP}/cb`, ...auth }),
      });
    expect((await redeem({ client_id: 'client_app' })).status).toBe(401);
    expect((await redeem({ client_id: 'client_app', client_secret: 's' })).status).toBe(200);
    expect((await redeem({ client_id: 'client_app', client_secret: 's' })).status).toBe(400);
  });
});
