import { describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { verifyTransactionToken } from './txn-token';

const ISS = 'https://auth.example.com';

async function setup() {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256' }] };
  const mint = (over: Record<string, unknown> = {}, typ = 'txntoken+jwt', aud = 'prod.example.com', key = privateKey) =>
    new SignJWT({ txn: 't1', scope: 'orders:read payments:write', req_wl: 'checkout', ...over })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ })
      .setIssuer(ISS)
      .setSubject('user_1')
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime('2m')
      .sign(key);
  return { jwks, mint };
}

describe('verifyTransactionToken', () => {
  it('accepts a good token and splits the scope', async () => {
    const { jwks, mint } = await setup();
    const r = await verifyTransactionToken(await mint(), { issuer: ISS, trustDomain: 'prod.example.com', jwks });
    expect(r.ok && r.scopes).toEqual(['orders:read', 'payments:write']);
  });
  it('refuses another trust domain, a wrong typ, a missing claim and a foreign signer', async () => {
    const { jwks, mint } = await setup();
    const opts = { issuer: ISS, trustDomain: 'prod.example.com', jwks };
    expect((await verifyTransactionToken(await mint({}, 'txntoken+jwt', 'other.example.com'), opts)).ok).toBe(false);
    expect((await verifyTransactionToken(await mint({}, 'JWT'), opts)).ok).toBe(false);
    expect((await verifyTransactionToken(await mint({ req_wl: undefined }), opts)).ok).toBe(false);
    expect((await verifyTransactionToken(await mint({}, 'txntoken+jwt', 'prod.example.com', (await generateKeyPair('ES256')).privateKey), opts)).ok).toBe(false);
  });
});
