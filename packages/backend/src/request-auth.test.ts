import { describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { AtlasBackend } from './verify';
import { ForbiddenError } from '@atlasauth/authz';
import { authenticateHeaders, sessionTokenFromHeaders } from './request-auth';

const ISSUER = 'https://t.fapi.atlas.test';

async function setup() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'k', alg: 'RS256', use: 'sig' }] };
  const backend = new AtlasBackend({
    jwksUrl: `${ISSUER}/.well-known/jwks.json`,
    issuer: ISSUER,
    fetchImpl: (async () => new Response(JSON.stringify(jwks))) as unknown as typeof fetch,
  });
  const token = await new SignJWT({ sid: 's1', org_id: 'org_1' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k' })
    .setSubject('user_1')
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime('60s')
    .sign(privateKey);
  return { backend, token };
}

describe('request auth', () => {
  it('reads bearer before cookie', () => {
    expect(sessionTokenFromHeaders({ authorization: 'Bearer a', cookie: '__session=b' })).toBe('a');
    expect(sessionTokenFromHeaders({ cookie: 'x=1; __session=b=' })).toBe('b=');
    expect(sessionTokenFromHeaders({})).toBeNull();
  });

  it('verifies a good token', async () => {
    const { backend, token } = await setup();
    const auth = await authenticateHeaders(backend, { authorization: `Bearer ${token}` });
    expect(auth.userId).toBe('user_1');
    expect(auth.orgId).toBe('org_1');
    expect(auth.isSignedIn).toBe(true);
  });

  it('fails closed on garbage and signed out', async () => {
    const { backend } = await setup();
    const auth = await authenticateHeaders(backend, { cookie: '__session=garbage' });
    expect(auth.isSignedIn).toBe(false);
    expect(auth.has()).toBe(false);
    expect(() => auth.protect()).toThrow(ForbiddenError);
  });
});
