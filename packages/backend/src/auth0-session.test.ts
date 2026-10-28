import { hkdfSync } from 'node:crypto';
import { CompactEncrypt } from 'jose';
import { describe, expect, it } from 'vitest';
import { auth0CookieKey, auth0SessionTokenExtractor } from './auth0-session';
import { getMigrationBridgePreset, resolveMigrationBridgePreset } from './migration-presets';

/**
 * Session cookies sealed the way the Auth0 SDKs seal them: express-openid-connect
 * derives its key with Node's `hkdfSync('sha256', secret, '', 'JWE CEK', 32)`
 * (lib/crypto.js) and nextjs-auth0 with the same HKDF; both encrypt JSON as a
 * compact JWE with `dir` + `A256GCM`. The key here comes from Node's HKDF, not
 * from the code under test, so the derivation is checked independently.
 */
const SECRET = 'a-long-random-auth0-secret-value-0123456789';
const ID_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhdXRoMHxhYmMifQ.c2ln';

async function seal(payload: unknown, secret = SECRET, header: Record<string, unknown> = {}) {
  const key = new Uint8Array(hkdfSync('sha256', secret, Buffer.alloc(0), 'JWE CEK', 32));
  return new CompactEncrypt(new TextEncoder().encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...header })
    .encrypt(key);
}

describe('auth0SessionTokenExtractor', () => {
  it('derives the same key as the Auth0 SDKs', () => {
    expect(Buffer.from(auth0CookieKey(SECRET))).toEqual(Buffer.from(hkdfSync('sha256', SECRET, Buffer.alloc(0), 'JWE CEK', 32)));
  });

  it('opens nextjs-auth0 v4, v3 and express-openid-connect sessions', async () => {
    const extract = auth0SessionTokenExtractor({ secret: SECRET });
    const v4 = await seal({ user: { sub: 'auth0|abc' }, tokenSet: { accessToken: 'at', idToken: ID_TOKEN, expiresAt: 1 }, internal: { sid: 's', createdAt: 1 } });
    expect(await extract({ cookies: { __session: v4 }, headers: {} })).toBe(ID_TOKEN);
    const v3 = await seal({ user: { sub: 'auth0|abc' }, idToken: ID_TOKEN, accessToken: 'at' });
    expect(await extract({ cookies: { appSession: v3 }, headers: {} })).toBe(ID_TOKEN);
    const eoc = await seal({ id_token: ID_TOKEN, access_token: 'at', token_type: 'Bearer' });
    expect(await extract({ cookies: { appSession: eoc }, headers: {} })).toBe(ID_TOKEN);
  });

  it('joins chunked cookies (__session__N and appSession.N)', async () => {
    const extract = auth0SessionTokenExtractor({ secret: SECRET });
    const jwe = await seal({ tokenSet: { idToken: ID_TOKEN } });
    const mid = Math.floor(jwe.length / 2);
    expect(await extract({ cookies: { __session__0: jwe.slice(0, mid), __session__1: jwe.slice(mid) }, headers: {} })).toBe(ID_TOKEN);
    expect(await extract({ cookies: { 'appSession.0': jwe.slice(0, mid), 'appSession.1': jwe.slice(mid) }, headers: {} })).toBe(ID_TOKEN);
  });

  it('accepts a rotated-out secret, refuses a wrong one, an expired session and an Atlas JWT', async () => {
    const old = await seal({ idToken: ID_TOKEN }, 'previous-secret-value-previous-secret');
    expect(await auth0SessionTokenExtractor({ secret: [SECRET, 'previous-secret-value-previous-secret'] })({ cookies: { appSession: old }, headers: {} })).toBe(ID_TOKEN);
    expect(await auth0SessionTokenExtractor({ secret: SECRET })({ cookies: { appSession: old }, headers: {} })).toBeUndefined();
    const expired = await seal({ idToken: ID_TOKEN }, SECRET, { exp: Math.floor(Date.now() / 1000) - 10 });
    expect(await auth0SessionTokenExtractor({ secret: SECRET })({ cookies: { appSession: expired }, headers: {} })).toBeUndefined();
    expect(await auth0SessionTokenExtractor({ secret: SECRET })({ cookies: { __session: ID_TOKEN }, headers: {} })).toBeUndefined();
    expect(() => auth0SessionTokenExtractor({ secret: '' })).toThrow(/AUTH0_SECRET/);
  });
});

describe('identity-vendor bridge presets', () => {
  it('resolve with each vendor\'s issuer, keys and subject claim', () => {
    expect(resolveMigrationBridgePreset('clerk', { frontend_api: 'clerk.acme.example' })).toMatchObject({
      issuer: 'https://clerk.acme.example',
      keysUrl: 'https://clerk.acme.example/.well-known/jwks.json',
      claims: { subject: 'sub', sessionKey: 'sid' },
      sharesAtlasCookie: true,
    });
    expect(resolveMigrationBridgePreset('auth0', { domain: 'acme.us.auth0.com', client_id: 'cid123' })).toMatchObject({
      issuer: 'https://acme.us.auth0.com/',
      audience: ['cid123'],
      claims: { subject: 'sub', sessionKey: 'sid' },
    });
    expect(resolveMigrationBridgePreset('okta', { domain: 'acme.okta.com' })).toMatchObject({
      issuer: 'https://acme.okta.com/oauth2/default',
      keysUrl: 'https://acme.okta.com/oauth2/default/v1/keys',
      audience: ['api://default'],
      claims: { subject: 'uid' },
    });
    expect(resolveMigrationBridgePreset('kinde', { domain: 'acme.kinde.com' })).toMatchObject({ issuer: 'https://acme.kinde.com', keysUrl: 'https://acme.kinde.com/.well-known/jwks', cookies: ['access_token', 'id_token'] });
    expect(resolveMigrationBridgePreset('descope', { project_id: 'P2abc' })).toMatchObject({
      issuer: 'https://api.descope.com/P2abc',
      keysUrl: 'https://api.descope.com/v2/keys/P2abc',
      cookies: ['DS'],
      clearCookies: ['DS', 'DSR'],
    });
    expect(resolveMigrationBridgePreset('descope_project_issuer', { project_id: 'P2abc' }).issuer).toBe('P2abc');
    expect(getMigrationBridgePreset('auth0')!.notes).toMatch(/auth0SessionTokenExtractor/);
    expect(() => resolveMigrationBridgePreset('auth0', { domain: 'acme.us.auth0.com' })).toThrow(/client_id/);
  });
});
