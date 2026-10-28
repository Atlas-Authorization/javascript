import { describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { AtlasGraphQLError, createAtlasContext, guard, requireUser } from './index';

const ISSUER = 'https://t.fapi.atlas.test';

async function setup() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'k', alg: 'RS256', use: 'sig' }] };
  const make = createAtlasContext({
    jwksUrl: `${ISSUER}/.well-known/jwks.json`,
    issuer: ISSUER,
    fetchImpl: (async () => new Response(JSON.stringify(jwks))) as unknown as typeof fetch,
  });
  const token = await new SignJWT({ sid: 's1', org_id: 'org_1', org_role: 'member' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k' })
    .setSubject('user_1')
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime('60s')
    .sign(privateKey);
  return { make, token };
}

describe('graphql helpers', () => {
  it('puts the verified session on the context', async () => {
    const { make, token } = await setup();
    const ctx = await make({ authorization: `Bearer ${token}` });
    expect(requireUser(ctx).userId).toBe('user_1');
  });

  it('signed out: requireUser throws UNAUTHENTICATED, public access still works', async () => {
    const { make } = await setup();
    const ctx = await make({});
    expect(ctx.atlas.isSignedIn).toBe(false);
    try {
      requireUser(ctx);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AtlasGraphQLError);
      expect((e as AtlasGraphQLError).extensions).toEqual({ code: 'UNAUTHENTICATED', http: { status: 401 } });
    }
  });

  it('guard enforces a condition with FORBIDDEN', async () => {
    const { make, token } = await setup();
    const ctx = await make({ authorization: `Bearer ${token}` });
    const resolver = guard((_p: null, _a: null, c: typeof ctx) => c.atlas.userId, { role: 'admin' });
    expect(() => resolver(null, null, ctx, undefined)).toThrow(AtlasGraphQLError);
    const ok = guard((_p: null, _a: null, c: typeof ctx) => c.atlas.userId, { role: 'member' });
    expect(ok(null, null, ctx, undefined)).toBe('user_1');
  });
});
