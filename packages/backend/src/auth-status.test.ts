import { describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { AtlasBackend } from './verify';
import { authenticateHeaders } from './request-auth';
import { AUTH_STATUS_HEADER, authStatusHeaders, deriveAuthStatus, hasSessionCookies, setAuthStatusHeader, withAuthStatus } from './auth-status';
import { refreshSessionFromRequest } from './refresh-session';

const ISSUER = 'https://t.fapi.example.com';

async function setup(options: { authorizedParties?: string[] } = {}) {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'k', alg: 'RS256', use: 'sig' }] };
  const backend = new AtlasBackend({
    jwksUrl: `${ISSUER}/.well-known/jwks.json`,
    issuer: ISSUER,
    fetchImpl: (async () => new Response(JSON.stringify(jwks))) as unknown as typeof fetch,
    ...options,
  });
  const mint = (o: { key?: unknown; expiresIn?: number; issuer?: string; claims?: Record<string, unknown> } = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ sid: 's1', ...o.claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'k' })
      .setSubject('user_1')
      .setIssuer(o.issuer ?? ISSUER)
      .setIssuedAt(now - 600)
      .setExpirationTime(now + (o.expiresIn ?? 60))
      .sign((o.key ?? privateKey) as never);
  };
  return { backend, mint, otherKey: other.privateKey };
}

describe('deriveAuthStatus', () => {
  it('maps every outcome', () => {
    expect(deriveAuthStatus({ ok: true }, null).status).toBe('signed_in');
    expect(deriveAuthStatus(null, null)).toEqual({ status: 'signed_out', reason: 'no_token' });
    expect(deriveAuthStatus(null, '__atlas_rt=r')).toEqual({ status: 'session_expired', reason: 'no_token' });
    expect(deriveAuthStatus(null, '__atlas_uat=1700000000').status).toBe('session_expired');
    expect(deriveAuthStatus(null, '__atlas_uat=0').status).toBe('signed_out');
    expect(deriveAuthStatus(null, '__atlas_uat=abc').status).toBe('signed_out');
    expect(deriveAuthStatus({ ok: false, reason: 'invalid', expired: true }, null)).toEqual({ status: 'signed_out', reason: 'expired' });
    expect(deriveAuthStatus({ ok: false, reason: 'invalid', expired: true }, '__atlas_rt=r')).toEqual({ status: 'session_expired', reason: 'expired' });
    expect(deriveAuthStatus({ ok: false, reason: 'malformed' }, '__atlas_rt=r')).toEqual({ status: 'token_invalid', reason: 'malformed' });
    expect(hasSessionCookies(undefined)).toBe(false);
  });
});

describe('header helpers', () => {
  it('builds kebab-case headers and nothing when signed in', () => {
    expect(authStatusHeaders({ status: 'signed_in' })).toEqual({});
    expect(authStatusHeaders({ status: 'signed_out' })).toEqual({ [AUTH_STATUS_HEADER]: 'signed-out' });
    expect(authStatusHeaders({ status: 'session_expired' })).toEqual({ [AUTH_STATUS_HEADER]: 'session-expired' });
    expect(authStatusHeaders({ status: 'token_invalid' })).toEqual({ [AUTH_STATUS_HEADER]: 'token-invalid' });
  });

  it('withAuthStatus sets the header, and survives immutable headers', async () => {
    const ok = withAuthStatus(new Response('x', { status: 401 }), { status: 'session_expired' });
    expect(ok.headers.get('x-atlas-auth-status')).toBe('session-expired');
    const redirect = Response.redirect('https://example.com/', 302);
    const copy = withAuthStatus(redirect, { status: 'signed_out' });
    expect(copy.headers.get('x-atlas-auth-status')).toBe('signed-out');
    expect(copy.status).toBe(302);
    const untouched = new Response('x');
    expect(withAuthStatus(untouched, { status: 'signed_in' })).toBe(untouched);
    expect(untouched.headers.has('x-atlas-auth-status')).toBe(false);
  });

  it('setAuthStatusHeader works with Express and Fastify shapes', () => {
    const express = { setHeader: vi.fn() };
    setAuthStatusHeader(express, { status: 'token_invalid' });
    expect(express.setHeader).toHaveBeenCalledWith('x-atlas-auth-status', 'token-invalid');
    const fastify = { header: vi.fn() };
    setAuthStatusHeader(fastify, { status: 'signed_out' });
    expect(fastify.header).toHaveBeenCalledWith('x-atlas-auth-status', 'signed-out');
    const quiet = { setHeader: vi.fn() };
    setAuthStatusHeader(quiet, { status: 'signed_in' });
    expect(quiet.setHeader).not.toHaveBeenCalled();
  });
});

describe('expiry detection', () => {
  it('flags only a genuinely expired, otherwise valid token', async () => {
    const { backend, mint } = await setup();
    const expired = await mint({ expiresIn: -120 });
    expect(await backend.verifyWithExpiry(expired)).toEqual({ ok: false, reason: 'invalid', expired: true });
    // The public contract is unchanged.
    expect(await backend.verify(expired)).toEqual({ ok: false, reason: 'invalid' });
    expect((await backend.verifyWithExpiry(await mint())).ok).toBe(true);
  });

  it('never calls a forged, wrong-issuer or wrong-azp token expired', async () => {
    const { backend, mint, otherKey } = await setup();
    expect(await backend.verifyWithExpiry(await mint({ expiresIn: -120, key: otherKey }))).toEqual({ ok: false, reason: 'invalid' });
    expect(await backend.verifyWithExpiry(await mint({ expiresIn: -120, issuer: 'https://evil.example.com' }))).toEqual({ ok: false, reason: 'invalid' });
    const strict = await setup({ authorizedParties: ['https://app.example.com'] });
    expect(await strict.backend.verifyWithExpiry(await strict.mint({ expiresIn: -120, claims: { azp: 'https://other.example.com' } }))).toEqual({
      ok: false,
      reason: 'unauthorized_party',
    });
    expect(await strict.backend.verifyWithExpiry(await strict.mint({ expiresIn: -120, claims: { azp: 'https://app.example.com' } }))).toMatchObject({ expired: true });
  });

  it('keeps tokens inside the clock skew valid', async () => {
    const { backend, mint } = await setup();
    expect((await backend.verifyWithExpiry(await mint({ expiresIn: -2 }))).ok).toBe(true);
  });
});

describe('authenticateRequest status', () => {
  const req = (headers: Record<string, string>) => ({ headers });

  it('reports every branch', async () => {
    const { backend, mint, otherKey } = await setup();
    const good = await backend.authenticateRequest(req({ cookie: `__session=${await mint()}` }));
    expect(good).toMatchObject({ ok: true, status: 'signed_in' });
    expect(good.ok && good.claims.sub).toBe('user_1');
    expect(await backend.authenticateRequest(req({}))).toMatchObject({ ok: false, reason: 'malformed', status: 'signed_out' });
    expect(await backend.authenticateRequest(req({ cookie: '__atlas_rt=r' }))).toMatchObject({ ok: false, status: 'session_expired' });
    expect(await backend.authenticateRequest(req({ cookie: '__atlas_uat=1700000000' }))).toMatchObject({ status: 'session_expired' });
    const expired = await mint({ expiresIn: -120 });
    expect(await backend.authenticateRequest(req({ cookie: `__session=${expired}; __atlas_rt=r` }))).toMatchObject({
      ok: false,
      reason: 'invalid',
      status: 'session_expired',
    });
    expect(await backend.authenticateRequest(req({ cookie: `__session=${expired}` }))).toMatchObject({ status: 'signed_out' });
    const forged = await mint({ key: otherKey });
    expect(await backend.authenticateRequest(req({ cookie: `__session=${forged}; __atlas_rt=r` }))).toMatchObject({ status: 'token_invalid' });
    expect(await backend.authenticateRequest(req({ cookie: '__session=garbage; __atlas_rt=r' }))).toMatchObject({ status: 'token_invalid' });
  });
});

describe('authenticateRequest revocation status', () => {
  const NOW = Date.now();
  const BAPI = 'https://api.example.com';

  /** A backend whose JWKS and revoked-session feed are in-memory fakes, on a clock the test moves by hand. */
  async function revocable(feed: () => Response) {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'k', alg: 'RS256', use: 'sig' }] };
    const clock = { t: NOW };
    const backend = new AtlasBackend({
      jwksUrl: `${ISSUER}/.well-known/jwks.json`,
      issuer: ISSUER,
      secretKey: 'sk_test_example',
      bapiBaseUrl: BAPI,
      now: () => clock.t,
      fetchImpl: (async (url: string) => (String(url).includes('/v1/sessions/revoked') ? feed() : new Response(JSON.stringify(jwks)))) as unknown as typeof fetch,
    });
    const token = new SignJWT({ sid: 's1' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k' })
      .setSubject('user_1')
      .setIssuer(ISSUER)
      .setIssuedAt(Math.floor(NOW / 1000) - 60)
      .setExpirationTime(Math.floor(NOW / 1000) + 600)
      .sign(privateKey);
    return { backend, clock, token };
  }
  const request = (token: string) => ({ headers: { cookie: `__session=${token}; __atlas_rt=r` } });
  const page = (sids: string[]) =>
    new Response(JSON.stringify({ data: sids.map((sid) => ({ sid, revoked_at: NOW })), has_more: false, next_cursor: null, server_time: NOW }));

  it('maps a revoked session to token_invalid, even with the refresh cookie present', async () => {
    const { backend, token } = await revocable(() => page(['s1']));
    expect(await backend.authenticateRequest(request(await token), { revocation: { mode: 'sid_list' } })).toEqual({
      ok: false,
      reason: 'revoked',
      status: 'token_invalid',
    });
  });

  it('stays signed in when the session is not on the revoked list', async () => {
    const { backend, token } = await revocable(() => page(['other']));
    expect(await backend.authenticateRequest(request(await token), { revocation: { mode: 'sid_list' } })).toMatchObject({ ok: true, status: 'signed_in' });
  });

  it('maps revocation_unavailable to token_invalid once the list is stale and onStale is reject', async () => {
    const { backend, clock, token } = await revocable(() => new Response('down', { status: 500 }));
    const revocation = { mode: 'sid_list' as const, onStale: 'reject' as const, staleAfterMs: 1000, onError: () => {} };
    const jwt = await token;
    // Fresh: the failed poll is still inside staleAfterMs, so the last (empty) list is trusted.
    expect(await backend.authenticateRequest(request(jwt), { revocation })).toMatchObject({ ok: true, status: 'signed_in' });
    clock.t = NOW + 5000;
    expect(await backend.authenticateRequest(request(jwt), { revocation })).toEqual({
      ok: false,
      reason: 'revocation_unavailable',
      status: 'token_invalid',
    });
  });

  it('keeps trusting the last list when onStale is allow', async () => {
    const { backend, clock, token } = await revocable(() => new Response('down', { status: 500 }));
    const revocation = { mode: 'sid_list' as const, staleAfterMs: 1000, onError: () => {} };
    const jwt = await token;
    await backend.authenticateRequest(request(jwt), { revocation });
    clock.t = NOW + 5000;
    expect(await backend.authenticateRequest(request(jwt), { revocation })).toMatchObject({ ok: true, status: 'signed_in' });
  });
});

describe('authenticateHeaders status', () => {
  it('carries status and reason on RequestAuth', async () => {
    const { backend, mint, otherKey } = await setup();
    expect(await authenticateHeaders(backend, { cookie: `__session=${await mint()}` })).toMatchObject({ status: 'signed_in', isSignedIn: true });
    expect(await authenticateHeaders(backend, {})).toMatchObject({ status: 'signed_out', reason: 'no_token', isSignedIn: false });
    expect(await authenticateHeaders(backend, { cookie: '__atlas_rt=r' })).toMatchObject({ status: 'session_expired', reason: 'no_token' });
    expect(await authenticateHeaders(backend, { cookie: `__session=${await mint({ expiresIn: -120 })}; __atlas_uat=1700000000` })).toMatchObject({
      status: 'session_expired',
      reason: 'expired',
      isSignedIn: false,
    });
    expect(await authenticateHeaders(backend, { cookie: `__session=${await mint({ expiresIn: -120 })}` })).toMatchObject({ status: 'signed_out', reason: 'expired' });
    expect(await authenticateHeaders(backend, { authorization: `Bearer ${await mint({ key: otherKey })}`, cookie: '__atlas_rt=r' })).toMatchObject({
      status: 'token_invalid',
      reason: 'invalid',
    });
    const broken = { verifyWithExpiry: async () => { throw new Error('boom'); } } as unknown as AtlasBackend;
    expect(await authenticateHeaders(broken, { authorization: 'Bearer a.b.c' })).toMatchObject({ status: 'token_invalid', isSignedIn: false });
  });
});

describe('refreshSessionFromRequest', () => {
  const request = (cookie: string | null, ua: string | null = 'agent/1') => ({
    headers: { get: (n: string) => (n === 'cookie' ? cookie : n === 'user-agent' ? ua : null) },
  });
  const okFetch = (setCookie: string[]) =>
    vi.fn(async () => {
      const h = new Headers({ 'content-type': 'application/json' });
      for (const c of setCookie) h.append('set-cookie', c);
      return new Response(JSON.stringify({ jwt: 'new.jwt.token' }), { status: 200, headers: h });
    });

  it('returns the token and Set-Cookie values, forwarding only Atlas cookies', async () => {
    const fetchImpl = okFetch(['__session=new.jwt.token; Path=/', '__atlas_uat=1; Path=/']);
    const out = await refreshSessionFromRequest(request('theme=dark; __atlas_rt=r1; __session=old'), {
      frontendApi: 'https://clerk.example.com',
      publishableKey: 'pk_test_x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out).toEqual({ token: 'new.jwt.token', setCookie: ['__session=new.jwt.token; Path=/', '__atlas_uat=1; Path=/'] });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string>; method: string }];
    expect(url).toBe('https://clerk.example.com/v1/client');
    expect(init.method).toBe('GET');
    expect(init.headers.cookie).toBe('__atlas_rt=r1; __session=old');
    expect(init.headers['x-publishable-key']).toBe('pk_test_x');
  });

  it('does nothing without the refresh cookie', async () => {
    const fetchImpl = okFetch([]);
    expect(await refreshSessionFromRequest(request('__session=old; __atlas_uat=1'), { frontendApi: 'https://x.example.com', fetchImpl: fetchImpl as unknown as typeof fetch })).toBeNull();
    expect(await refreshSessionFromRequest(request(null), { frontendApi: 'https://x.example.com', fetchImpl: fetchImpl as unknown as typeof fetch })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns null on a dead session, a missing jwt, a network error or a bad origin', async () => {
    const base = { frontendApi: 'https://x.example.com' };
    const c = request('__atlas_rt=r');
    expect(await refreshSessionFromRequest(c, { ...base, fetchImpl: (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch })).toBeNull();
    expect(await refreshSessionFromRequest(c, { ...base, fetchImpl: (async () => new Response(JSON.stringify({ session: null }))) as unknown as typeof fetch })).toBeNull();
    expect(await refreshSessionFromRequest(c, { ...base, fetchImpl: (async () => { throw new Error('down'); }) as unknown as typeof fetch })).toBeNull();
    expect(await refreshSessionFromRequest(c, { frontendApi: 'not a url' })).toBeNull();
  });
});
