import { describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { verifyDelegationToken } from './credential-verify';

const issuer = 'https://auth.example.com';

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const keys = { keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' }] };
  const mint = (claims: Record<string, unknown> = {}, aud = 'https://shop.example.com') =>
    new SignJWT({ scope: 'orders:read orders:write', act: { sub: 'svc_checkout' }, token_use: 'delegation', ...claims })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'delegation+jwt' })
      .setIssuer(issuer)
      .setSubject('user_1')
      .setAudience(aud)
      .setJti('jti_1')
      .setIssuedAt()
      .setExpirationTime('2m')
      .sign(privateKey);
  return { keys, mint };
}

describe('verifyDelegationToken', () => {
  it('accepts a token for your audience and returns the user and the actor', async () => {
    const { keys, mint } = await setup();
    const r = await verifyDelegationToken(await mint(), { issuer, keys, audience: 'https://shop.example.com', requiredScopes: ['orders:read'] });
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.claims.sub).toBe('user_1');
      expect(r.claims.act.sub).toBe('svc_checkout');
    }
  });

  it('refuses another audience, a missing scope, a missing act and a wrong token kind', async () => {
    const { keys, mint } = await setup();
    const base = { issuer, keys, audience: 'https://shop.example.com' };
    expect(await verifyDelegationToken(await mint({}, 'https://other.example.com'), base)).toEqual({ valid: false, code: 'invalid_token' });
    expect(await verifyDelegationToken(await mint(), { ...base, requiredScopes: ['admin'] })).toEqual({ valid: false, code: 'insufficient_scope' });
    expect(await verifyDelegationToken(await mint({ act: undefined }), base)).toEqual({ valid: false, code: 'wrong_token_type' });
    expect(await verifyDelegationToken(await mint({ token_use: 'session' }), base)).toEqual({ valid: false, code: 'wrong_token_type' });
    expect(await verifyDelegationToken(await mint(), { ...base, allowedActors: ['someone_else'] })).toEqual({ valid: false, code: 'wrong_token_type' });
  });

  it('lets you deny a known-revoked token id and needs an audience', async () => {
    const { keys, mint } = await setup();
    const base = { issuer, keys, audience: 'https://shop.example.com' };
    expect(await verifyDelegationToken(await mint(), { ...base, isRevoked: (id) => id === 'jti_1' })).toEqual({ valid: false, code: 'revoked' });
    await expect(verifyDelegationToken(await mint(), { issuer, keys, audience: '' })).rejects.toThrow();
  });
});
