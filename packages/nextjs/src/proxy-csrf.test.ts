import { describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { csrfToken } from '@atlasauth/backend';
import { ATLAS_AUTH_HEADERS, atlasProxy, proxyCsrfToken, withAtlasHeaders, type ProxyRequest } from './proxy';

const ISSUER = 'https://fox.fapi.atlas.test';
const SECRET = 'csrf-test-secret-0123456789';

async function setup() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'kid-1', alg: 'RS256', use: 'sig' }] };
  const atlas = atlasProxy({
    jwksUrl: `${ISSUER}/.well-known/jwks.json`,
    issuer: ISSUER,
    fetchImpl: (async () => new Response(JSON.stringify(jwks))) as unknown as typeof fetch,
    publicRoutes: ['/'],
    csrf: { secret: SECRET, mountBasePath: '/atlas' },
  });
  const session = await new SignJWT({ sid: 'sess_1' })
    .setProtectedHeader({ alg: 'RS256', kid: 'kid-1' })
    .setSubject('user_1').setIssuer(ISSUER).setIssuedAt().setExpirationTime('60s')
    .sign(privateKey);
  return { atlas, session };
}

/** A NextRequest-shaped request on a real Fetch Request (so form bodies can be cloned). */
function request(path: string, method: string, headers: Record<string, string>, body?: string): ProxyRequest {
  const r = new Request(`https://app.example.com${path}`, { method, headers, body });
  return Object.assign(r, { nextUrl: { pathname: new URL(r.url).pathname, search: '' } });
}

describe('atlasProxy({ csrf })', () => {
  it('a cross-site POST without the token is 403 and gets a fresh cookie', async () => {
    const { atlas, session } = await setup();
    const res = await atlas(request('/api/transfer', 'POST', { cookie: `__session=${session}`, origin: 'https://evil.test' }));
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({ errors: [{ code: 'CSRF_TOKEN_INVALID' }] });
    expect(res?.headers.get('set-cookie')).toMatch(/^__atlas_csrf=[^;]+; Path=\/; SameSite=Lax; Secure$/);
  });

  it('a same-site POST with the token in the header passes', async () => {
    const { atlas, session } = await setup();
    const t = csrfToken({ sid: 'sess_1', secret: SECRET });
    const req = request('/api/transfer', 'POST', { cookie: `__session=${session}; __atlas_csrf=${encodeURIComponent(t)}`, 'x-atlas-csrf': t });
    expect(await atlas(req)).toBeNull();
    expect(proxyCsrfToken(req)).toBe(t);
  });

  it('a form POST with the atlas_csrf field passes', async () => {
    const { atlas, session } = await setup();
    const t = csrfToken({ sid: 'sess_1', secret: SECRET });
    const req = request('/settings', 'POST', { cookie: `__session=${session}; __atlas_csrf=${encodeURIComponent(t)}`, 'content-type': 'application/x-www-form-urlencoded' }, `atlas_csrf=${encodeURIComponent(t)}`);
    expect(await atlas(req)).toBeNull();
  });

  it('a token minted for another session is 403', async () => {
    const { atlas, session } = await setup();
    const t = csrfToken({ sid: 'sess_other', secret: SECRET });
    const res = await atlas(request('/api/transfer', 'POST', { cookie: `__session=${session}; __atlas_csrf=${encodeURIComponent(t)}`, 'x-atlas-csrf': t }));
    expect(res?.status).toBe(403);
  });

  it('exempts bearer requests, the mount base path and safe methods; GET sets the cookie and forwards the token', async () => {
    const { atlas, session } = await setup();
    expect(await atlas(request('/api/x', 'POST', { authorization: `Bearer ${session}` }))).toBeNull();
    expect(await atlas(request('/atlas/v1/client/sign_ins', 'POST', { cookie: `__session=${session}` }))).toBeNull();
    const get = request('/dashboard', 'GET', { cookie: `__session=${session}` });
    expect(await atlas(get)).toBeNull();
    const res = withAtlasHeaders(get, new Response(null, { headers: { 'x-middleware-next': '1' } }));
    const token = proxyCsrfToken(get)!;
    expect(res.headers.get('set-cookie')).toContain(`__atlas_csrf=${encodeURIComponent(token)}`);
    expect(res.headers.get(`x-middleware-request-${ATLAS_AUTH_HEADERS.csrfToken}`)).toBe(token);
  });

  it('leaves signed-out requests alone', async () => {
    const { atlas } = await setup();
    expect(await atlas(request('/', 'POST', {}))).toBeNull();
  });
});
