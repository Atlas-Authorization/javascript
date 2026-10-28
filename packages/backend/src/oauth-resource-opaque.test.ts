import { describe, expect, it } from 'vitest';
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';
import { createAccessTokenVerifier, createIntrospector, type AccessTokenVerifierOptions } from './oauth-resource';

/**
 * Opaque access tokens at a resource server: a token that is not a JWT is
 * validated at the instance's introspection endpoint (RFC 7662) with the API's
 * own client credentials, the answer is cached, and every other rule (issuer,
 * audience, scopes, DPoP) applies to the introspected claims exactly as to a JWT.
 */

const ISSUER = 'https://auth.example.com';
const API = 'https://api.example.com/orders';
const TOKEN = `oat_${'A'.repeat(43)}`;

type Answer = Record<string, unknown> | ((body: URLSearchParams) => Record<string, unknown>);

function fakeIntrospection(answer: Answer, status = 200) {
  const calls: Array<{ url: string; authorization: string | null; body: URLSearchParams }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body ?? ''));
    const headers = new Headers(init?.headers);
    calls.push({ url: String(url), authorization: headers.get('authorization'), body });
    const json = typeof answer === 'function' ? answer(body) : answer;
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const active = (extra: Record<string, unknown> = {}) => ({
  active: true,
  iss: ISSUER,
  sub: 'user_1',
  aud: API,
  scope: 'orders:read',
  client_id: 'client_app',
  token_use: 'access_token',
  token_type: 'Bearer',
  exp: Math.floor(Date.now() / 1000) + 600,
  iat: Math.floor(Date.now() / 1000),
  ...extra,
});

const options = (fetchImpl: typeof fetch, o: Partial<AccessTokenVerifierOptions> = {}): AccessTokenVerifierOptions => ({
  issuer: ISSUER,
  audience: API,
  jwks: { keys: [] },
  introspection: { clientId: 'client_api', clientSecret: 'oacs_api-secret' },
  fetchImpl,
  ...o,
});

const req = (authorization: string, extra: Record<string, string> = {}) => ({
  method: 'GET',
  url: 'https://api.example.com/orders/1',
  headers: { authorization, ...extra },
});

describe('opaque access tokens', () => {
  it('are validated by introspection with the API client credentials', async () => {
    const fake = fakeIntrospection(active());
    const verify = createAccessTokenVerifier(options(fake.fetchImpl, { requiredScopes: ['orders:read'] }));
    const out = await verify(req(`Bearer ${TOKEN}`));
    expect(out).toMatchObject({ ok: true, subject: 'user_1', clientId: 'client_app', scopes: ['orders:read'], dpopBound: false });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.url).toBe(`${ISSUER}/oauth2/introspect`);
    expect(fake.calls[0]!.authorization).toBe(`Basic ${btoa('client_api:oacs_api-secret')}`);
    expect(fake.calls[0]!.body.get('token')).toBe(TOKEN);
    expect(fake.calls[0]!.body.get('token_type_hint')).toBe('access_token');
  });

  it('caches answers (active and inactive) and never past the token expiry', async () => {
    let now = Date.now();
    let exp = Math.floor(now / 1000) + 30;
    const fake = fakeIntrospection(() => active({ exp }));
    const verify = createAccessTokenVerifier(options(fake.fetchImpl, { now: () => now, introspection: { clientId: 'c', clientSecret: 's', cacheTtlSeconds: 120 } }));
    expect((await verify(req(`Bearer ${TOKEN}`))).ok).toBe(true);
    expect((await verify(req(`Bearer ${TOKEN}`))).ok).toBe(true);
    expect(fake.calls).toHaveLength(1);
    // Past the token's exp the cache no longer answers (and the token is expired).
    now += 31_000;
    exp = Math.floor(now / 1000) + 600;
    expect((await verify(req(`Bearer ${TOKEN}`))).ok).toBe(true);
    expect(fake.calls).toHaveLength(2);

    const inactive = fakeIntrospection({ active: false });
    let t = Date.now();
    const v2 = createAccessTokenVerifier(options(inactive.fetchImpl, { now: () => t }));
    const refused = await v2(req(`Bearer ${TOKEN}`));
    expect(refused).toMatchObject({ ok: false, status: 401, error: 'invalid_token' });
    await v2(req(`Bearer ${TOKEN}`));
    expect(inactive.calls).toHaveLength(1);
    t += 11_000;
    await v2(req(`Bearer ${TOKEN}`));
    expect(inactive.calls).toHaveLength(2);
  });

  it('applies the issuer, audience and scope rules to the introspected claims', async () => {
    const otherIssuer = createAccessTokenVerifier(options(fakeIntrospection(active({ iss: 'https://evil.example.com' })).fetchImpl));
    expect((await otherIssuer(req(`Bearer ${TOKEN}`))).ok).toBe(false);
    const otherApi = createAccessTokenVerifier(options(fakeIntrospection(active({ aud: 'https://other.example.com' })).fetchImpl));
    expect(await otherApi(req(`Bearer ${TOKEN}`))).toMatchObject({ ok: false, status: 401 });
    const missingScope = createAccessTokenVerifier(options(fakeIntrospection(active()).fetchImpl, { requiredScopes: ['orders:write'] }));
    expect(await missingScope(req(`Bearer ${TOKEN}`))).toMatchObject({ ok: false, status: 403, error: 'insufficient_scope' });
    const refreshToken = createAccessTokenVerifier(options(fakeIntrospection(active({ token_use: 'refresh_token' })).fetchImpl));
    expect((await refreshToken(req(`Bearer ${TOKEN}`))).ok).toBe(false);
  });

  it('refuses an opaque token when introspection is not configured, and when Atlas is unreachable', async () => {
    const noIntrospection = createAccessTokenVerifier({ issuer: ISSUER, audience: API, jwks: { keys: [] } });
    const out = await noIntrospection(req(`Bearer ${TOKEN}`));
    expect(out).toMatchObject({ ok: false, status: 401, error: 'invalid_token' });
    const down = createAccessTokenVerifier(options(fakeIntrospection({ error: 'server_error' }, 503).fetchImpl));
    expect(await down(req(`Bearer ${TOKEN}`))).toMatchObject({ ok: false, status: 401 });
  });

  it('keeps the DPoP sender constraint of an opaque token', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const jwk = await exportJWK(publicKey);
    const jkt = await calculateJwkThumbprint(jwk, 'sha256');
    const fake = fakeIntrospection(active({ cnf: { jkt }, token_type: 'DPoP' }));
    const verify = createAccessTokenVerifier(options(fake.fetchImpl));
    expect((await verify(req(`Bearer ${TOKEN}`))).ok).toBe(false);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(TOKEN)));
    const proof = await new SignJWT({ htm: 'GET', htu: 'https://api.example.com/orders/1', jti: 'p1', ath: Buffer.from(digest).toString('base64url') })
      .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk })
      .setIssuedAt()
      .sign(privateKey);
    const ok = await verify(req(`DPoP ${TOKEN}`, { dpop: proof }));
    expect(ok).toMatchObject({ ok: true, dpopBound: true });
  });

  it('can check JWTs live too (introspectJwts), so a revoked grant is refused before expiry', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const pub = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    const jwt = await new SignJWT({ scope: 'orders:read', token_use: 'access_token', client_id: 'client_app' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setSubject('user_1')
      .setAudience(API)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    const local = createAccessTokenVerifier({ issuer: ISSUER, audience: API, jwks: { keys: [pub] } });
    expect((await local(req(`Bearer ${jwt}`))).ok).toBe(true);
    const revoked = fakeIntrospection({ active: false });
    const live = createAccessTokenVerifier({
      issuer: ISSUER,
      audience: API,
      jwks: { keys: [pub] },
      introspection: { clientId: 'c', clientSecret: 's', introspectJwts: true },
      fetchImpl: revoked.fetchImpl,
    });
    expect((await live(req(`Bearer ${jwt}`))).ok).toBe(false);
    expect(revoked.calls).toHaveLength(1);
  });
});

describe('createIntrospector', () => {
  it('posts to a custom endpoint and keys its cache by a hash of the token', async () => {
    const fake = fakeIntrospection(active());
    const introspect = createIntrospector(ISSUER, { clientId: 'c', clientSecret: 's', endpoint: 'https://internal.example.com/introspect' }, { fetchImpl: fake.fetchImpl });
    expect((await introspect(TOKEN))?.sub).toBe('user_1');
    expect((await introspect(`oat_${'B'.repeat(43)}`))?.sub).toBe('user_1');
    expect(fake.calls.map((c) => c.url)).toEqual(['https://internal.example.com/introspect', 'https://internal.example.com/introspect']);
  });
});
