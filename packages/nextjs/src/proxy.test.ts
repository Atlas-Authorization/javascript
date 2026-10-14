import { describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import {
  ATLAS_AUTH_HEADERS,
  atlasProxy,
  proxyAuth,
  readAtlasHeaders,
  withAtlasHeaders,
  type ProxyRequest,
} from './proxy';

const ISSUER = 'https://fox.fapi.atlas.test';
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;

async function keyring() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'kid-1', alg: 'RS256', use: 'sig' };
  return { privateKey, jwks: { keys: [jwk] } };
}

async function token(privateKey: unknown, claims: Record<string, unknown> = {}) {
  return new SignJWT({ sid: 'sess_1', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'kid-1' })
    .setSubject('user_1')
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime('60s')
    .sign(privateKey as never);
}

const serving = (jwks: unknown) =>
  (async () => new Response(JSON.stringify(jwks), { status: 200 })) as unknown as typeof fetch;

/** A NextRequest-shaped request built on the real Web `Headers`. */
const request = (path: string, headers: Record<string, string> = {}): ProxyRequest => {
  const url = new URL(`https://app.example.com${path}`);
  return { nextUrl: { pathname: url.pathname, search: url.search }, url: url.toString(), headers: new Headers(headers) };
};

/** What `NextResponse.next()` / `.rewrite()` / `.redirect()` put on the wire. */
const nextResponse = (init: { request?: Headers } = {}) => {
  const headers = new Headers({ 'x-middleware-next': '1' });
  if (init.request) {
    const names: string[] = [];
    init.request.forEach((value, key) => {
      names.push(key);
      headers.set(`x-middleware-request-${key}`, value);
    });
    headers.set('x-middleware-override-headers', names.join(','));
  }
  return new Response(null, { headers });
};
const rewriteResponse = (to: string) =>
  new Response(null, { headers: { 'x-middleware-rewrite': to } });
const redirectResponse = (to: string) => new Response(null, { status: 307, headers: { location: to } });

/** The downstream request headers Next would materialise from a response. */
function downstream(original: ProxyRequest, response: Response): Headers {
  const list = response.headers.get('x-middleware-override-headers');
  if (list === null) return new Headers(original.headers as Headers);
  const out = new Headers();
  for (const name of list.split(',').filter(Boolean)) {
    const value = response.headers.get(`x-middleware-request-${name}`);
    if (value !== null) out.set(name, value);
  }
  return out;
}

async function setup(extra: Record<string, unknown> = {}) {
  const { privateKey, jwks } = await keyring();
  const atlas = atlasProxy({
    jwksUrl: JWKS_URL,
    issuer: ISSUER,
    fetchImpl: serving(jwks),
    publicRoutes: ['/', '/sign-in(.*)'],
    ...extra,
  });
  return { atlas, privateKey };
}

describe('atlasProxy', () => {
  it('returns null for a signed-in user so the rest of the chain runs', async () => {
    const { atlas, privateKey } = await setup();
    const req = request('/dashboard', { cookie: `__session=${await token(privateKey)}` });
    expect(await atlas(req)).toBeNull();
    expect(proxyAuth(req).userId).toBe('user_1');
  });

  it('returns null for a public page when signed out', async () => {
    const { atlas } = await setup();
    const req = request('/');
    expect(await atlas(req)).toBeNull();
    expect(proxyAuth(req).userId).toBeNull();
  });

  it('returns null for static assets', async () => {
    const { atlas } = await setup();
    expect(await atlas(request('/_next/static/chunk.js'))).toBeNull();
  });

  it('redirects a signed-out user away from a protected page', async () => {
    const { atlas } = await setup();
    const res = await atlas(request('/dashboard'));
    expect(res?.status).toBe(307);
    expect(res?.headers.get('location')).toBe(
      'https://app.example.com/sign-in?redirect_url=%2Fdashboard',
    );
  });

  it('honours the durable signed-in hint instead of bouncing', async () => {
    const { atlas } = await setup();
    expect(await atlas(request('/dashboard', { cookie: '__atlas_uat=1700000000' }))).toBeNull();
  });

  it('answers an API route with a JSON 401', async () => {
    const { atlas } = await setup();
    const res = await atlas(request('/api/orders'));
    expect(res?.status).toBe(401);
    expect(res?.headers.get('content-type')).toBe('application/json');
    expect(await res?.json()).toEqual({ errors: [{ code: 'UNAUTHENTICATED' }] });
  });

  it('bounces to the handshake with the HttpOnly PKCE verifier as a Set-Cookie', async () => {
    const { atlas } = await setup({ handshake: true, publishableKey: 'pk_test_x' });
    const res = await atlas(request('/dashboard'));
    expect(res?.status).toBe(307);
    const location = new URL(res!.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(`${ISSUER}/v1/client/handshake`);
    expect(location.searchParams.get('code_challenge')).toBeTruthy();
    const cookie = res!.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^__atlas_hv=[^;]+; Path=\/; Max-Age=300; HttpOnly; Secure; SameSite=Lax$/);
  });

  it('sets the first-party session cookies when a satellite return redeems', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ jwt: 'JWT_V', refresh_token: 'RT_V' }), { status: 200 }),
    ) as unknown as typeof fetch;
    const atlas = atlasProxy({
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      fetchImpl,
      handshake: true,
      publishableKey: 'pk_test_x',
    });
    const res = await atlas(
      request('/dashboard?__atlas_hs=ok&__atlas_hu=user_1&__atlas_hn=nonce_1', {
        cookie: '__atlas_hv=verifier_1',
      }),
    );
    expect(res?.status).toBe(307);
    expect(res?.headers.get('location')).toBe('https://app.example.com/dashboard');
    const cookies = res!.headers.getSetCookie();
    expect(cookies).toHaveLength(3);
    expect(cookies[2]).toBe('__atlas_hv=; Path=/; Max-Age=0');
  });
});

describe('withAtlasHeaders', () => {
  it('forwards the verified session as x-atlas-* request headers', async () => {
    const { atlas, privateKey } = await setup();
    const req = request('/dashboard', {
      cookie: `__session=${await token(privateKey, { org_id: 'org_1', org_role: 'admin' })}`,
      'accept-language': 'de',
    });
    expect(await atlas(req)).toBeNull();
    const res = withAtlasHeaders(req, nextResponse());
    const forwarded = downstream(req, res);
    expect(forwarded.get(ATLAS_AUTH_HEADERS.status)).toBe('signed-in');
    expect(forwarded.get(ATLAS_AUTH_HEADERS.userId)).toBe('user_1');
    expect(forwarded.get(ATLAS_AUTH_HEADERS.sessionId)).toBe('sess_1');
    expect(forwarded.get(ATLAS_AUTH_HEADERS.orgId)).toBe('org_1');
    expect(forwarded.get(ATLAS_AUTH_HEADERS.orgRole)).toBe('admin');
    // The original request headers survive the override.
    expect(forwarded.get('accept-language')).toBe('de');
    expect(readAtlasHeaders(forwarded)).toEqual({
      signedIn: true,
      userId: 'user_1',
      sessionId: 'sess_1',
      orgId: 'org_1',
      orgRole: 'admin',
    });
  });

  it('drops x-atlas-* headers a client tried to forge', async () => {
    const { atlas } = await setup();
    const req = request('/', { 'x-atlas-user-id': 'user_victim', 'x-atlas-auth-status': 'signed-in' });
    expect(await atlas(req)).toBeNull();
    const forwarded = downstream(req, withAtlasHeaders(req, nextResponse()));
    expect(forwarded.get(ATLAS_AUTH_HEADERS.userId)).toBeNull();
    expect(forwarded.get(ATLAS_AUTH_HEADERS.status)).toBe('signed-out');
    expect(readAtlasHeaders(forwarded).signedIn).toBe(false);
  });

  it('merges with a request-header override an earlier step already set', async () => {
    const { atlas, privateKey } = await setup();
    const req = request('/dashboard', {
      cookie: `__session=${await token(privateKey)}`,
      'x-atlas-user-id': 'forged',
    });
    await atlas(req);
    // An earlier step copied ALL request headers (incl. the forged one) and added its own.
    const theirs = new Headers(req.headers as Headers);
    theirs.set('x-next-intl-locale', 'en');
    const res = withAtlasHeaders(req, nextResponse({ request: theirs }));
    const forwarded = downstream(req, res);
    expect(forwarded.get('x-next-intl-locale')).toBe('en');
    expect(forwarded.get(ATLAS_AUTH_HEADERS.userId)).toBe('user_1');
    expect(res.headers.get('x-middleware-override-headers')!.split(',').filter((n) => n === 'x-atlas-user-id')).toHaveLength(1);
  });

  it('applies to a rewrite as well', async () => {
    const { atlas, privateKey } = await setup();
    const req = request('/dashboard', { cookie: `__session=${await token(privateKey)}` });
    await atlas(req);
    const res = withAtlasHeaders(req, rewriteResponse('https://app.example.com/en/dashboard'));
    expect(downstream(req, res).get(ATLAS_AUTH_HEADERS.userId)).toBe('user_1');
  });

  it('leaves a redirect untouched', async () => {
    const req = request('/dashboard');
    const res = withAtlasHeaders(req, redirectResponse('/en/dashboard'));
    expect(res.headers.get('x-middleware-override-headers')).toBeNull();
  });

  it('treats a request the proxy never saw as signed out', () => {
    const req = request('/');
    const forwarded = downstream(req, withAtlasHeaders(req, nextResponse()));
    expect(forwarded.get(ATLAS_AUTH_HEADERS.status)).toBe('signed-out');
  });
});

/**
 * The documented composition: Atlas first (with locale-prefixed routes), then
 * next-intl. `createMiddleware(routing)` from next-intl is a plain
 * `(request) => NextResponse`, mocked here with its three behaviours: redirect a
 * path with no locale, rewrite/continue a prefixed one.
 */
describe('composing with next-intl', () => {
  const locales = ['en', 'de'];
  const intl = vi.fn((req: ProxyRequest) => {
    const first = req.nextUrl.pathname.split('/')[1] ?? '';
    if (!locales.includes(first)) {
      return redirectResponse(`https://app.example.com/en${req.nextUrl.pathname === '/' ? '' : req.nextUrl.pathname}`);
    }
    const headers = new Headers(req.headers as Headers);
    headers.set('x-next-intl-locale', first);
    return nextResponse({ request: headers });
  });

  async function chain() {
    const { atlas, privateKey } = await setup({
      locales,
      defaultLocale: 'en',
      signInUrl: '/:locale/sign-in',
      publicRoutes: ['/', '/:locale', '/:locale/sign-in(.*)', '/:locale/pricing'],
      protectedRoutes: ['/:locale/dashboard(.*)'],
    });
    const proxy = async (req: ProxyRequest) => (await atlas(req)) ?? withAtlasHeaders(req, intl(req));
    return { proxy, privateKey };
  }

  it('lets next-intl redirect a locale-less public path', async () => {
    const { proxy } = await chain();
    const res = await proxy(request('/'));
    expect(res.headers.get('location')).toBe('https://app.example.com/en');
  });

  it('serves a locale-prefixed public page to a signed-out visitor', async () => {
    const { proxy } = await chain();
    const req = request('/de/pricing');
    const res = await proxy(req);
    const forwarded = downstream(req, res);
    expect(forwarded.get('x-next-intl-locale')).toBe('de');
    expect(forwarded.get(ATLAS_AUTH_HEADERS.status)).toBe('signed-out');
  });

  it('sends a signed-out visitor on /de/dashboard to /de/sign-in, before next-intl runs', async () => {
    const { proxy } = await chain();
    intl.mockClear();
    const res = await proxy(request('/de/dashboard/settings'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      'https://app.example.com/de/sign-in?redirect_url=%2Fde%2Fdashboard%2Fsettings',
    );
    expect(intl).not.toHaveBeenCalled();
  });

  it('does not treat an unknown first segment as a locale', async () => {
    const { proxy } = await chain();
    // `/admin/sign-in` must not match `/:locale/sign-in(.*)` — it stays protected.
    const res = await proxy(request('/admin/sign-in'));
    expect(res.headers.get('location')).toBe(
      'https://app.example.com/en/sign-in?redirect_url=%2Fadmin%2Fsign-in',
    );
  });

  it('runs next-intl with the session forwarded for a signed-in user', async () => {
    const { proxy, privateKey } = await chain();
    const req = request('/en/dashboard', { cookie: `__session=${await token(privateKey)}` });
    const res = await proxy(req);
    const forwarded = downstream(req, res);
    expect(forwarded.get('x-next-intl-locale')).toBe('en');
    expect(forwarded.get(ATLAS_AUTH_HEADERS.userId)).toBe('user_1');
  });
});
