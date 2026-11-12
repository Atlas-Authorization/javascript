import { describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { atlasMiddleware, getAuth, getCsrfToken, getInitialState, type HonoContextLike } from './index';

const ISSUER = 'https://fox.fapi.atlas.test';

async function setup() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'k', alg: 'RS256', use: 'sig' }] };
  const jwt = await new SignJWT({ sid: 'sess_1' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k' })
    .setSubject('user_1')
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime('60s')
    .sign(privateKey);
  const fetchImpl = (async (url: string) =>
    String(url).includes('revoked')
      ? new Response(JSON.stringify({ data: [{ sid: 'sess_1', revoked_at: Date.now() }], has_more: false, next_cursor: null, server_time: Date.now() }))
      : new Response(JSON.stringify(jwks))) as unknown as typeof fetch;
  return { jwt, fetchImpl };
}

function ctx(method: string, headers: Record<string, string>): HonoContextLike & { cookies: string[] } {
  const store = new Map<string, unknown>();
  const cookies: string[] = [];
  return {
    req: { method, url: 'https://app.test/api/x', header: (n: string) => headers[n.toLowerCase()] },
    get: (k) => store.get(k),
    set: (k, v) => void store.set(k, v),
    header: (_n, v) => void cookies.push(v),
    cookies,
  };
}

describe('hono csrf + revocation + initial state', () => {
  it('refuses a cookie-authenticated POST without the CSRF token, passes a GET and hands out the token', async () => {
    const { jwt, fetchImpl } = await setup();
    const mw = atlasMiddleware({ jwksUrl: `${ISSUER}/jwks`, issuer: ISSUER, fetchImpl, csrf: { secret: 'x'.repeat(32) } });
    const post = await mw(ctx('POST', { cookie: `__session=${jwt}` }), async () => undefined);
    expect((post as Response).status).toBe(403);
    const get = ctx('GET', { cookie: `__session=${jwt}` });
    expect(await mw(get, async () => undefined)).toBeUndefined();
    expect(getCsrfToken(get)).toMatch(/\./);
    expect(get.cookies[0]).toContain('__atlas_csrf=');
    expect((await getInitialState(get)).auth.userId).toBe('user_1');
  });

  it('treats a revoked session as signed out', async () => {
    const { jwt, fetchImpl } = await setup();
    const mw = atlasMiddleware({ jwksUrl: `${ISSUER}/jwks`, issuer: ISSUER, fetchImpl, secretKey: 'sk_test_1', revocation: true });
    const c = ctx('GET', { authorization: `Bearer ${jwt}` });
    await mw(c, async () => undefined);
    expect(getAuth(c).userId).toBeNull();
  });
});
