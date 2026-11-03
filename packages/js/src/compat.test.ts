// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { Auth0CompatClient, Auth0CompatError, auth0UserFromClient, createAuth0CompatClient, decodeJwtPayload } from './compat';

/** A JWT-shaped string with the given payload (unsigned: the shim never verifies its own FAPI's token). */
const jwt = (payload: Record<string, unknown>) =>
  `h.${btoa(JSON.stringify(payload)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')}.s`;

const USER = {
  id: 'user_1',
  first_name: 'Ada',
  last_name: 'Lovelace',
  username: 'ada',
  image_url: 'https://img.test/a.png',
  email_addresses: [{ email_address: 'ada@acme.test', verified: true, primary: true }],
};

type Call = { method: string; path: string; body?: string; headers: Record<string, string> };

function fakeFapi(state: { signedIn: boolean; exp?: number }) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, body: init?.body as string | undefined, headers });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const exp = state.exp ?? Math.floor(Date.now() / 1000) + 60;
    if (url.pathname === '/v1/client') {
      return json(200, state.signedIn ? { session: { id: 'sess_1' }, user: USER, jwt: jwt({ sub: 'user_1', sid: 'sess_1', exp }) } : { session: null, user: null });
    }
    if (url.pathname === '/v1/client/sessions/sess_1/tokens') return json(200, { jwt: jwt({ sub: 'user_1', sid: 'sess_1', exp: Math.floor(Date.now() / 1000) + 60, fresh: true }), session_id: 'sess_1' });
    if (url.pathname === '/v1/client/sessions/sess_1/tokens/hasura') return json(200, { jwt: jwt({ sub: 'user_1', tpl: 'hasura' }), expires_in: 30 });
    if (url.pathname === '/v1/client/tickets/exchange') {
      state.signedIn = true;
      return json(200, { ok: true });
    }
    if (url.pathname === '/v1/client/sessions/sess_1/revoke') {
      state.signedIn = false;
      return json(200, { revoked: true });
    }
    if (url.pathname === '/v1/client/sign_ins/oauth') return json(200, { authorization_url: 'https://github.com/login/oauth/authorize?x=1' });
    if (url.pathname === '/v1/client/integrations/helpdesk/atlas_id_tokens' && headers.authorization === 'Bearer at_siwa') {
      return json(200, { jwt: jwt({ sub: 'atlas_sub', aud: 'helpdesk:acme' }), expires_in: 120, integration: 'helpdesk', audience: 'helpdesk:acme', issuer: 'https://id.test', jwks_uri: 'https://id.test/jwks' });
    }
    return json(404, { errors: [{ code: 'NOT_FOUND' }] });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const opts = (fetchImpl: typeof fetch) => ({ clientId: 'pk_live_ins_1', domain: 'auth.acme.test', fetchImpl });

beforeEach(() => sessionStorage.clear());

describe('auth0-spa-js compat client', () => {
  it('accepts auth0 option names and reads the session', async () => {
    const { fetchImpl, calls } = fakeFapi({ signedIn: true });
    const client = await createAuth0CompatClient(opts(fetchImpl));
    expect(client.frontendApi).toBe('https://auth.acme.test');
    expect(calls[0]).toMatchObject({ path: '/v1/client' });
    expect(calls[0]!.headers['x-publishable-key']).toBe('pk_live_ins_1');
    expect(await client.isAuthenticated()).toBe(true);
    expect(await client.getUser()).toEqual({
      sub: 'user_1',
      name: 'Ada Lovelace',
      given_name: 'Ada',
      family_name: 'Lovelace',
      nickname: 'ada',
      picture: 'https://img.test/a.png',
      email: 'ada@acme.test',
      email_verified: true,
    });
  });

  it('getTokenSilently returns the cached session token, refreshes near expiry, and supports templates', async () => {
    const { fetchImpl, calls } = fakeFapi({ signedIn: true });
    const client = new Auth0CompatClient(opts(fetchImpl));
    const token = await client.getTokenSilently();
    expect(decodeJwtPayload(token)?.sid).toBe('sess_1');
    expect(calls.some((c) => c.path.endsWith('/tokens'))).toBe(false);
    const fresh = await client.getTokenSilently({ cacheMode: 'off' });
    expect(decodeJwtPayload(fresh)?.fresh).toBe(true);
    const detailed = await client.getTokenSilently({ detailedResponse: true });
    expect(detailed.access_token).toBe(detailed.id_token);
    expect(detailed.expires_in).toBeGreaterThan(0);
    expect(decodeJwtPayload(await client.getTokenSilently({ template: 'hasura' }))?.tpl).toBe('hasura');
    const claims = await client.getIdTokenClaims();
    expect(claims?.sub).toBe('user_1');
    expect(typeof claims?.__raw).toBe('string');
  });

  it('getTokenSilently({ for, atlasIdAccessToken }) mints for a Sign in with Atlas user with no session', async () => {
    const { fetchImpl, calls } = fakeFapi({ signedIn: false });
    const client = new Auth0CompatClient(opts(fetchImpl));
    const token = await client.getTokenSilently({ for: 'helpdesk', atlasIdAccessToken: 'at_siwa' });
    expect(decodeJwtPayload(token)).toMatchObject({ sub: 'atlas_sub', aud: 'helpdesk:acme' });
    expect(calls.map((c) => c.path)).toEqual(['/v1/client/integrations/helpdesk/atlas_id_tokens']);
    const detailed = await client.getTokenSilently({ for: 'helpdesk', atlasIdAccessToken: 'at_siwa', detailedResponse: true });
    expect(detailed.expires_in).toBe(120);
    await expect(client.getTokenSilently({ for: 'helpdesk', atlasIdAccessToken: 'wrong' })).rejects.toMatchObject({ error: 'login_required' });
  });

  it('a nearly expired token is refreshed', async () => {
    const { fetchImpl } = fakeFapi({ signedIn: true, exp: Math.floor(Date.now() / 1000) + 2 });
    const client = new Auth0CompatClient(opts(fetchImpl));
    expect(decodeJwtPayload(await client.getTokenSilently())?.fresh).toBe(true);
  });

  it('signed out: login_required, no user, isAuthenticated false', async () => {
    const { fetchImpl } = fakeFapi({ signedIn: false });
    const client = new Auth0CompatClient(opts(fetchImpl));
    expect(await client.isAuthenticated()).toBe(false);
    expect(await client.getUser()).toBeUndefined();
    await expect(client.getTokenSilently()).rejects.toMatchObject({ error: 'login_required' });
    expect(await client.getIdTokenClaims()).toBeUndefined();
  });

  it('loginWithRedirect opens the hosted page (or the provider), and handleRedirectCallback exchanges the ticket and returns appState', async () => {
    const state = { signedIn: false };
    const { fetchImpl, calls } = fakeFapi(state);
    const client = new Auth0CompatClient(opts(fetchImpl));
    const opened: string[] = [];
    await client.loginWithRedirect({ appState: { target: '/billing' }, authorizationParams: { redirect_uri: 'https://app.test/cb' }, openUrl: (u) => void opened.push(u) });
    expect(opened[0]).toBe('https://auth.acme.test/hosted/sign-in?redirect_url=https%3A%2F%2Fapp.test%2Fcb');
    await client.loginWithRedirect({ authorizationParams: { screen_hint: 'signup', redirect_uri: 'https://app.test/cb' }, openUrl: (u) => void opened.push(u) });
    expect(opened[1]).toContain('/hosted/sign-up?');
    await client.loginWithRedirect({ authorizationParams: { connection: 'github', redirect_uri: 'https://app.test/cb' }, openUrl: (u) => void opened.push(u) });
    expect(opened[2]).toBe('https://github.com/login/oauth/authorize?x=1');
    expect(JSON.parse(calls.find((c) => c.path === '/v1/client/sign_ins/oauth')!.body!)).toMatchObject({ provider: 'github', redirect_url: 'https://app.test/cb' });

    const result = await client.handleRedirectCallback('https://app.test/cb?__atlas_attempt=att_1&__atlas_ticket=tk_1');
    expect(JSON.parse(calls.find((c) => c.path === '/v1/client/tickets/exchange')!.body!)).toEqual({ attempt_id: 'att_1', ticket: 'tk_1' });
    expect(result).toEqual({ appState: { target: '/billing' } });
    expect(await client.isAuthenticated()).toBe(true);
    // appState is consumed once.
    expect(await client.handleRedirectCallback('https://app.test/cb')).toEqual({});
  });

  it('maps auth0 connection names to Atlas providers', async () => {
    const { fetchImpl, calls } = fakeFapi({ signedIn: false });
    const client = new Auth0CompatClient(opts(fetchImpl));
    await client.loginWithRedirect({ authorizationParams: { connection: 'google-oauth2', redirect_uri: 'https://app.test' }, openUrl: () => undefined });
    expect(JSON.parse(calls.find((c) => c.path === '/v1/client/sign_ins/oauth')!.body!).provider).toBe('google');
  });

  it('logout revokes the session and goes to returnTo; openUrl:false stays put', async () => {
    const state = { signedIn: true };
    const { fetchImpl, calls } = fakeFapi(state);
    const client = new Auth0CompatClient(opts(fetchImpl));
    await client.checkSession();
    const went: string[] = [];
    await client.logout({ logoutParams: { returnTo: 'https://app.test/bye' }, openUrl: (u) => void went.push(u) });
    expect(calls.some((c) => c.path === '/v1/client/sessions/sess_1/revoke' && c.method === 'POST')).toBe(true);
    expect(went).toEqual(['https://app.test/bye']);
    expect(await client.isAuthenticated()).toBe(false);
    await client.logout({ openUrl: false });
  });

  it('requires a publishable key and projects users', () => {
    expect(() => new Auth0CompatClient({ domain: 'x.test' })).toThrow(/publishableKey/);
    expect(auth0UserFromClient(null)).toBeUndefined();
    expect(new Auth0CompatError('popup_closed', 'x').error).toBe('popup_closed');
  });
});
