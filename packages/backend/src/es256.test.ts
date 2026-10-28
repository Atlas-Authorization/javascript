import { beforeEach, describe, expect, it } from 'vitest';
import { SignJWT, decodeProtectedHeader, exportJWK, generateKeyPair } from 'jose';
import { AtlasBackend } from './verify';
import { BACKCHANNEL_LOGOUT_EVENT, verifyLogoutToken } from './logout-token';
import { oidcCallback, oidcStart, resetOidcCaches } from './oidc';
import { createAccessTokenVerifier } from './oauth-resource';
import { createTestIssuer } from './testing';

/**
 * An Atlas instance may sign with ES256 instead of RS256. Every verifier in
 * this package accepts both — and still nothing else.
 */

const REDIRECT = 'https://app.example.com/auth/callback';
const SECRET = 'a-test-secret-that-is-at-least-32-characters';
const forbiddenFetch = (async () => {
  throw new Error('no network expected');
}) as unknown as typeof fetch;

beforeEach(() => resetOidcCaches());

describe('ES256 instances', () => {
  it('session tokens verify, and the header says ES256', async () => {
    const fx = await createTestIssuer({ alg: 'ES256' });
    const token = await fx.mintSession({ sub: 'user_es' });
    expect(decodeProtectedHeader(token).alg).toBe('ES256');
    const atlas = new AtlasBackend({ jwks: fx.jwks, issuer: fx.issuer, fetchImpl: forbiddenFetch });
    const result = await atlas.verify(token);
    expect(result.ok).toBe(true);
    // A forged signature by another P-256 key under the same kid fails.
    const forged = await fx.mintSession({ sub: 'user_es' }, { tamper: 'foreign_key' });
    expect((await atlas.verify(forged)).ok).toBe(false);
    // alg:none is refused too.
    expect((await atlas.verify(await fx.mintSession({ sub: 'user_es' }, { tamper: 'alg_none' }))).ok).toBe(false);
  });

  it('the OIDC relying-party flow verifies an ES256 id_token', async () => {
    const fx = await createTestIssuer({ alg: 'ES256' });
    const started = await oidcStart({ issuer: fx.issuer, clientId: fx.clientId, redirectUri: REDIRECT, secret: SECRET, fetchImpl: fx.fetch });
    const back = await fx.authorize(started.url, { sub: 'user_es' });
    const id = await oidcCallback({
      issuer: fx.issuer,
      clientId: fx.clientId,
      redirectUri: REDIRECT,
      query: back.callbackUrl,
      cookie: started.cookie.split(';')[0]!,
      secret: SECRET,
      fetchImpl: fx.fetch,
    });
    expect(id.sub).toBe('user_es');
    expect(decodeProtectedHeader(id.idToken).alg).toBe('ES256');
  });

  it('back-channel logout tokens verify with ES256; HS256 is still refused', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'k', alg: 'ES256', use: 'sig' }] };
    const nowSec = Math.floor(Date.now() / 1000);
    const claims = { iss: 'https://i.example', aud: 'c', iat: nowSec, exp: nowSec + 60, jti: 'j', sub: 'u', events: { [BACKCHANNEL_LOGOUT_EVENT]: {} } };
    const token = await new SignJWT(claims).setProtectedHeader({ alg: 'ES256', kid: 'k', typ: 'logout+jwt' }).sign(privateKey);
    expect(await verifyLogoutToken(token, { issuer: 'https://i.example', clientId: 'c', jwks })).toMatchObject({ ok: true });
    const hmac = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256', kid: 'k', typ: 'logout+jwt' })
      .sign(new TextEncoder().encode('x'.repeat(32)));
    expect((await verifyLogoutToken(hmac, { issuer: 'https://i.example', clientId: 'c', jwks })).ok).toBe(false);
  });

  it('API access tokens signed ES256 pass the resource-server gate', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'api', alg: 'ES256', use: 'sig' }] };
    const nowSec = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ token_use: 'access_token', scope: 'read', client_id: 'c' })
      .setProtectedHeader({ alg: 'ES256', kid: 'api', typ: 'JWT' })
      .setIssuer('https://i.example')
      .setSubject('user_1')
      .setAudience('https://api.example.com')
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + 60)
      .sign(privateKey);
    const verify = createAccessTokenVerifier({ issuer: 'https://i.example', audience: 'https://api.example.com', jwks });
    const result = await verify({ method: 'GET', url: 'https://api.example.com/x', headers: { authorization: `Bearer ${token}` } });
    expect(result.ok).toBe(true);
  });
});
