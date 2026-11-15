import { beforeEach, describe, expect, it } from 'vitest';
import { SignJWT, decodeProtectedHeader, exportJWK, generateKeyPair } from 'jose';
import { createHash } from 'node:crypto';
import { AtlasBackend } from './verify';
import { BACKCHANNEL_LOGOUT_EVENT, verifyLogoutToken } from './logout-token';
import { oidcCallback, oidcStart, resetOidcCaches } from './oidc';
import { verifyStatusListToken } from './status-list';
import { createTestIssuer } from './testing';

/** Every verifier accepts the five instance algorithms, checks the key type against the alg, and refuses none and HS*. */

const ALGS = ['RS256', 'ES256', 'ES384', 'PS256', 'EdDSA'] as const;
const REDIRECT = 'https://app.example.com/auth/callback';
const SECRET = 'a-test-secret-that-is-at-least-32-characters';
const noNet = (async () => {
  throw new Error('no network expected');
}) as unknown as typeof fetch;
beforeEach(() => resetOidcCaches());

describe.each(ALGS)('%s instance', (alg) => {
  it('verifies session tokens; none, a foreign key and HS256 are refused', async () => {
    const fx = await createTestIssuer({ alg });
    const token = await fx.mintSession({ sub: 'user_1' });
    expect(decodeProtectedHeader(token).alg).toBe(alg);
    const atlas = new AtlasBackend({ jwks: fx.jwks, issuer: fx.issuer, fetchImpl: noNet });
    expect((await atlas.verify(token)).ok).toBe(true);
    expect((await atlas.verify(await fx.mintSession({ sub: 'user_1' }, { tamper: 'foreign_key' }))).ok).toBe(false);
    expect((await atlas.verify(await fx.mintSession({ sub: 'user_1' }, { tamper: 'alg_none' }))).ok).toBe(false);
  });

  it('verifies an ID token through the relying-party flow', async () => {
    const fx = await createTestIssuer({ alg });
    const started = await oidcStart({ issuer: fx.issuer, clientId: fx.clientId, redirectUri: REDIRECT, secret: SECRET, fetchImpl: fx.fetch });
    const back = await fx.authorize(started.url, { sub: 'user_1' });
    const id = await oidcCallback({ issuer: fx.issuer, clientId: fx.clientId, redirectUri: REDIRECT, query: back.callbackUrl, cookie: started.cookie.split(';')[0]!, secret: SECRET, fetchImpl: fx.fetch });
    expect(decodeProtectedHeader(id.idToken).alg).toBe(alg);
  });

  it('verifies logout tokens; HS256 and a key of another type are refused', async () => {
    const { privateKey, publicKey } = await generateKeyPair(alg);
    const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'k', alg, use: 'sig' }] };
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: 'https://i.example', aud: 'c', iat: now, exp: now + 60, jti: `j_${alg}`, sub: 'u', events: { [BACKCHANNEL_LOGOUT_EVENT]: {} } };
    const sign = (a: string, key: never) => new SignJWT(claims).setProtectedHeader({ alg: a, kid: 'k', typ: 'logout+jwt' }).sign(key);
    const opts = { issuer: 'https://i.example', clientId: 'c', jwks };
    expect(await verifyLogoutToken(await sign(alg, privateKey as never), opts)).toMatchObject({ ok: true });
    expect((await verifyLogoutToken(await sign('HS256', new TextEncoder().encode('x'.repeat(32)) as never), opts)).ok).toBe(false);
    // The token says `alg`, but the published key behind its kid is of the other family.
    const other = alg === 'EdDSA' ? 'ES256' : 'EdDSA';
    const wrong = await generateKeyPair(other);
    const wrongJwks = { keys: [{ ...(await exportJWK(wrong.publicKey)), kid: 'k', use: 'sig' }] };
    expect((await verifyLogoutToken(await sign(alg, privateKey as never), { ...opts, jwks: wrongJwks })).ok).toBe(false);
  });

  it('verifies status lists; a key of another type is refused', async () => {
    const pair = (await crypto.subtle.generateKey(
      (alg === 'RS256' ? { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }
        : alg === 'PS256' ? { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }
        : alg === 'EdDSA' ? { name: 'Ed25519' }
        : { name: 'ECDSA', namedCurve: alg === 'ES384' ? 'P-384' : 'P-256' }) as never,
      true,
      ['sign', 'verify'],
    )) as unknown as { publicKey: any; privateKey: any };
    const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k', alg, use: 'sig' };
    const b64 = (b: Uint8Array | string) => Buffer.from(b).toString('base64url');
    const nowSec = 1_800_000_000;
    const claims = { iss: 'https://atlas.test', aud: 'atlas:session-status-list', token_use: 'session_status_list', iat: nowSec, exp: nowSec + 120, since: 0, window_seconds: 3600, hash_bytes: 8, count: 1, truncated: false, h: b64(createHash('sha256').update('sess_a').digest().subarray(0, 8)) };
    const head = b64(JSON.stringify({ alg, kid: 'k', typ: 'statuslist+jwt' }));
    const data = `${head}.${b64(JSON.stringify(claims))}`;
    const params = alg === 'RS256' ? { name: 'RSASSA-PKCS1-v1_5' } : alg === 'PS256' ? { name: 'RSA-PSS', saltLength: 32 } : alg === 'EdDSA' ? { name: 'Ed25519' } : { name: 'ECDSA', hash: alg === 'ES384' ? 'SHA-384' : 'SHA-256' };
    const token = `${data}.${b64(new Uint8Array(await crypto.subtle.sign(params, pair.privateKey, new TextEncoder().encode(data))))}`;
    const opts = { issuer: 'https://atlas.test', now: () => (nowSec + 10) * 1000 };
    expect((await verifyStatusListToken(token, { ...opts, jwks: { keys: [jwk] } })).count).toBe(1);
    const other = (await crypto.subtle.generateKey({ name: 'Ed25519' } as never, true, ['sign', 'verify'])) as unknown as { publicKey: any };
    const otherJwk = alg === 'EdDSA' ? { ...(await crypto.subtle.exportKey('jwk', ((await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as unknown as { publicKey: any }).publicKey)) } : { ...(await crypto.subtle.exportKey('jwk', other.publicKey)) };
    await expect(verifyStatusListToken(token, { ...opts, jwks: { keys: [{ ...otherJwk, kid: 'k' }] } })).rejects.toMatchObject({ name: expect.any(String) });
  });
});
