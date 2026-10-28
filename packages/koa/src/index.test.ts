import { describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { atlasMiddleware, getAuth, requireAuth, type KoaContextLike } from './index';

const ISSUER = 'https://t.fapi.atlas.test';

async function setup() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'k', alg: 'RS256', use: 'sig' }] };
  const options = {
    jwksUrl: `${ISSUER}/.well-known/jwks.json`,
    issuer: ISSUER,
    fetchImpl: (async () => new Response(JSON.stringify(jwks))) as unknown as typeof fetch,
  };
  const token = await new SignJWT({ sid: 's1', org_id: 'org_1', org_role: 'member' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k' })
    .setSubject('user_1')
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime('60s')
    .sign(privateKey);
  return { options, token };
}

const ctx = (headers: Record<string, string> = {}): KoaContextLike => ({ headers, state: {}, status: 404, body: null });

describe('koa adapter', () => {
  it('attaches the verified user and lets the request through', async () => {
    const { options, token } = await setup();
    const c = ctx({ authorization: `Bearer ${token}` });
    let nexted = false;
    await atlasMiddleware(options)(c, async () => void (nexted = true));
    expect(nexted).toBe(true);
    expect(getAuth(c).userId).toBe('user_1');
  });

  it('requireAuth answers 401 when signed out and does not call next', async () => {
    const { options } = await setup();
    const c = ctx();
    await atlasMiddleware(options)(c, async () => {});
    let nexted = false;
    await requireAuth()(c, async () => void (nexted = true));
    expect(c.status).toBe(401);
    expect(nexted).toBe(false);
  });

  it('requireAuth answers 403 when the condition fails and passes when it holds', async () => {
    const { options, token } = await setup();
    const c = ctx({ authorization: `Bearer ${token}` });
    await atlasMiddleware(options)(c, async () => {});
    await requireAuth({ role: 'admin' })(c, async () => {});
    expect(c.status).toBe(403);
    let nexted = false;
    await requireAuth({ role: 'member' })(c, async () => void (nexted = true));
    expect(nexted).toBe(true);
  });

  it('getAuth is signed out when the middleware has not run', () => {
    expect(getAuth(ctx()).isSignedIn).toBe(false);
  });
});
