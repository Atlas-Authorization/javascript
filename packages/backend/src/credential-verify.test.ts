import { describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { JwksCache } from './jwks-cache';
import { verifyApiKeyToken, verifyMachineToken } from './credential-verify';

const ISSUER = 'https://auth.example.test';

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const { privateKey: otherKey } = await generateKeyPair('RS256');
  const sign = (claims: Record<string, unknown>, opts: { key?: typeof privateKey; exp?: number; iss?: string; aud?: string } = {}) => {
    const jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(opts.iss ?? ISSUER)
      .setSubject(String(claims.sub ?? 'eak_1'))
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? Math.floor(Date.now() / 1000) + 300);
    if (opts.aud) jwt.setAudience(opts.aud);
    return jwt.sign(opts.key ?? privateKey);
  };
  return { keys: { keys: [jwk] }, sign, otherKey };
}

describe('verifyApiKeyToken', () => {
  it('accepts a good token and returns its claims', async () => {
    const { keys, sign } = await setup();
    const token = await sign({ token_use: 'api_key', jti: 'j1', scopes: ['reports:read'], constraints: { desk: 1 } });
    const res = await verifyApiKeyToken(token, { issuer: ISSUER, keys, requiredScopes: ['reports:read'] });
    expect(res.valid).toBe(true);
    if (res.valid) expect(res.claims).toMatchObject({ sub: 'eak_1', scopes: ['reports:read'] });
  });

  it('refuses a bad signature, an expired token, a wrong issuer and an unknown audience', async () => {
    const { keys, sign, otherKey } = await setup();
    const claims = { token_use: 'api_key', jti: 'j', scopes: [], constraints: {} };
    expect((await verifyApiKeyToken(await sign(claims, { key: otherKey }), { issuer: ISSUER, keys })).valid).toBe(false);
    expect(await verifyApiKeyToken(await sign(claims, { exp: Math.floor(Date.now() / 1000) - 60 }), { issuer: ISSUER, keys })).toEqual({ valid: false, code: 'invalid_token' });
    expect(await verifyApiKeyToken(await sign(claims, { iss: 'https://evil.test' }), { issuer: ISSUER, keys })).toEqual({ valid: false, code: 'invalid_token' });
    expect(await verifyApiKeyToken(await sign(claims, { aud: 'https://other.test' }), { issuer: ISSUER, keys, audience: 'https://mine.test' })).toEqual({ valid: false, code: 'invalid_token' });
    expect(await verifyApiKeyToken('not-a-jwt', { issuer: ISSUER, keys })).toEqual({ valid: false, code: 'invalid_token' });
  });

  it('refuses another kind of token signed with the same key', async () => {
    const { keys, sign } = await setup();
    expect(await verifyApiKeyToken(await sign({ token_use: 'm2m', jti: 'j' }), { issuer: ISSUER, keys })).toEqual({ valid: false, code: 'wrong_token_type' });
    expect(await verifyApiKeyToken(await sign({ token_use: 'session' }), { issuer: ISSUER, keys })).toEqual({ valid: false, code: 'wrong_token_type' });
  });

  it('checks scopes, the deny-list and the holder proof', async () => {
    const { keys, sign } = await setup();
    const plain = await sign({ token_use: 'api_key', jti: 'j', scopes: ['a'], constraints: {} });
    expect(await verifyApiKeyToken(plain, { issuer: ISSUER, keys, requiredScopes: ['b'] })).toEqual({ valid: false, code: 'insufficient_scope' });
    expect(await verifyApiKeyToken(plain, { issuer: ISSUER, keys, isRevoked: async (id) => id === 'eak_1' })).toEqual({ valid: false, code: 'revoked' });
    const pop = await sign({ token_use: 'api_key', jti: 'j', scopes: [], constraints: {}, cnf: { jkt: 'thumb' } });
    expect(await verifyApiKeyToken(pop, { issuer: ISSUER, keys })).toEqual({ valid: false, code: 'proof_required' });
    expect(await verifyApiKeyToken(pop, { issuer: ISSUER, keys, holderKeyThumbprint: 'other' })).toEqual({ valid: false, code: 'proof_mismatch' });
    expect((await verifyApiKeyToken(pop, { issuer: ISSUER, keys, holderKeyThumbprint: 'thumb' })).valid).toBe(true);
  });

  it('reads keys from a cache and refetches nothing when a fixed set is given', async () => {
    const { keys, sign } = await setup();
    const fetchImpl = (async () => new Response(JSON.stringify(keys), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const cache = new JwksCache({ url: `${ISSUER}/.well-known/jwks.json`, fetchImpl });
    const token = await sign({ token_use: 'api_key', jti: 'j', scopes: [], constraints: {} });
    expect((await verifyApiKeyToken(token, { issuer: ISSUER, keys: cache })).valid).toBe(true);
    const down = new JwksCache({ url: `${ISSUER}/.well-known/jwks.json`, fetchImpl: (async () => { throw new Error('down'); }) as typeof fetch });
    expect(await verifyApiKeyToken(token, { issuer: ISSUER, keys: down })).toEqual({ valid: false, code: 'keys_unavailable' });
  });
});

describe('verifyMachineToken', () => {
  it('accepts a machine token, checks scopes in scope or scopes, and refuses an API-key token', async () => {
    const { keys, sign } = await setup();
    const m2m = await sign({ token_use: 'm2m', jti: 'j', sub: 'mch_1', scope: 'jobs:run jobs:read' });
    const ok = await verifyMachineToken(m2m, { issuer: ISSUER, keys, requiredScopes: ['jobs:run'] });
    expect(ok.valid).toBe(true);
    expect(await verifyMachineToken(m2m, { issuer: ISSUER, keys, requiredScopes: ['admin'] })).toEqual({ valid: false, code: 'insufficient_scope' });
    expect(await verifyMachineToken(await sign({ token_use: 'api_key', jti: 'j', scopes: [] }), { issuer: ISSUER, keys })).toEqual({ valid: false, code: 'wrong_token_type' });
  });

  it('refuses a token bound to an audience the verifier did not name', async () => {
    const { keys, sign } = await setup();
    const bound = await sign({ token_use: 'm2m', jti: 'j', sub: 'mch_1' }, { aud: 'https://svc.test' });
    expect(await verifyMachineToken(bound, { issuer: ISSUER, keys })).toEqual({ valid: false, code: 'invalid_token' });
    expect((await verifyMachineToken(bound, { issuer: ISSUER, keys, audience: 'https://svc.test' })).valid).toBe(true);
    expect((await verifyMachineToken(bound, { issuer: ISSUER, keys, anyAudience: true })).valid).toBe(true);
  });
});
