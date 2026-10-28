import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';
import {
  buildWwwAuthenticate,
  createAccessTokenVerifier,
  hmacDpopNonceSource,
  memoryDpopNonceSource,
} from './oauth-resource';

/**
 * DPoP server nonces (RFC 9449 §8): with a nonce source, a proof must carry the
 * current (or previous window's) nonce, a missing or stale one is answered with
 * `use_dpop_nonce` and a fresh `DPoP-Nonce`, and successes carry it too. The
 * HMAC source derives the same nonces as every other Atlas server SDK.
 */

const ISSUER = 'https://auth.example.com';
const API = 'https://api.example.com/orders';
const SECRET = 's'.repeat(32);

async function setup() {
  const signing = await generateKeyPair('RS256');
  const pub = { ...(await exportJWK(signing.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const holder = await generateKeyPair('ES256');
  const jwk = await exportJWK(holder.publicKey);
  const jkt = await calculateJwkThumbprint(jwk, 'sha256');
  const token = await new SignJWT({ scope: 'orders:read', token_use: 'access_token', cnf: { jkt } })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(ISSUER)
    .setSubject('user_1')
    .setAudience(API)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signing.privateKey);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  let n = 0;
  const proof = (extra: Record<string, unknown> = {}) =>
    new SignJWT({ htm: 'GET', htu: `${API}/1`, jti: `p${n++}`, ath: Buffer.from(digest).toString('base64url'), ...extra })
      .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk })
      .setIssuedAt()
      .sign(holder.privateKey);
  const req = async (extra?: Record<string, unknown>) => ({
    method: 'GET',
    url: `${API}/1`,
    headers: { authorization: `DPoP ${token}`, dpop: await proof(extra) },
  });
  return { jwks: { keys: [pub] }, req };
}

describe('DPoP server nonces', () => {
  it('asks for a nonce, then accepts a proof that carries it', async () => {
    const { jwks, req } = await setup();
    let now = Date.now();
    const nonces = hmacDpopNonceSource(SECRET, { windowSeconds: 60, now: () => now });
    const verify = createAccessTokenVerifier({ issuer: ISSUER, audience: API, jwks, dpopNonces: nonces, now: () => now });

    const first = await verify(await req());
    expect(first).toMatchObject({ ok: false, status: 401, error: 'use_dpop_nonce' });
    expect(first.dpopNonce).toBe(await nonces.current());
    expect(!first.ok && first.wwwAuthenticate).toMatch(/^DPoP error="use_dpop_nonce"/);

    expect(await verify(await req({ nonce: 'made-up' }))).toMatchObject({ ok: false, error: 'use_dpop_nonce' });
    const ok = await verify(await req({ nonce: first.dpopNonce }));
    expect(ok).toMatchObject({ ok: true, dpopBound: true, dpopNonce: first.dpopNonce });

    // The previous window's nonce still works; two windows back does not.
    now += 60_000;
    expect((await verify(await req({ nonce: first.dpopNonce }))).ok).toBe(true);
    now += 60_000;
    const stale = await verify(await req({ nonce: first.dpopNonce }));
    expect(stale).toMatchObject({ ok: false, error: 'use_dpop_nonce' });
    expect(stale.dpopNonce).not.toBe(first.dpopNonce);
  });

  it('leaves bearer tokens alone but still hands out the nonce', async () => {
    const signing = await generateKeyPair('RS256');
    const pub = { ...(await exportJWK(signing.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    const token = await new SignJWT({ scope: 'orders:read', token_use: 'access_token' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setSubject('user_1')
      .setAudience(API)
      .setExpirationTime('5m')
      .sign(signing.privateKey);
    const verify = createAccessTokenVerifier({ issuer: ISSUER, audience: API, jwks: { keys: [pub] }, dpopNonces: memoryDpopNonceSource() });
    const out = await verify({ method: 'GET', url: `${API}/1`, headers: { authorization: `Bearer ${token}` } });
    expect(out.ok).toBe(true);
    expect(out.dpopNonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('the HMAC source is stateless, shared by processes holding the secret, and matches the cross-SDK derivation', async () => {
    const now = 1_760_000_000_000;
    const a = hmacDpopNonceSource(SECRET, { windowSeconds: 300, now: () => now });
    const b = hmacDpopNonceSource(new TextEncoder().encode(SECRET), { windowSeconds: 300, now: () => now });
    const nonce = await a.current();
    expect(await b.current()).toBe(nonce);
    expect(await b.valid(nonce)).toBe(true);
    expect(await hmacDpopNonceSource('t'.repeat(32), { now: () => now }).valid(nonce)).toBe(false);

    const epoch = Buffer.alloc(8);
    epoch.writeBigUInt64BE(BigInt(Math.floor(now / 300_000)));
    const expected = createHmac('sha256', SECRET)
      .update(Buffer.concat([Buffer.from('atlas-dpop-nonce:'), epoch]))
      .digest('base64url');
    expect(nonce).toBe(expected);
    expect(() => hmacDpopNonceSource('short')).toThrow(/32 bytes/);
  });

  it('the memory source rotates per window and remembers only the previous nonce', async () => {
    let now = 0;
    const source = memoryDpopNonceSource({ windowSeconds: 10, now: () => now });
    const first = await source.current();
    expect(await source.current()).toBe(first);
    now += 10_000;
    const second = await source.current();
    expect(second).not.toBe(first);
    expect(await source.valid(first)).toBe(true);
    now += 10_000;
    expect(await source.valid(first)).toBe(false);
    expect(await source.valid(second)).toBe(true);
  });

  it('builds the use_dpop_nonce challenge', () => {
    expect(buildWwwAuthenticate({ scheme: 'DPoP', error: 'use_dpop_nonce', description: 'n' })).toBe('DPoP error="use_dpop_nonce", error_description="n"');
  });
});
