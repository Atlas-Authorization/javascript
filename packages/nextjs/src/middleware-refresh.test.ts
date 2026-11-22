import { describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { applySetCookies, atlasMiddleware, createAtlasDecider } from './middleware';
import { atlasProxy } from './proxy';

const ISSUER = 'https://fox.fapi.example.com';
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;

async function setup() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'k', alg: 'RS256', use: 'sig' }] };
  const mint = (expiresIn = 60) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ sid: 'sess_1' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k' })
      .setSubject('user_1')
      .setIssuer(ISSUER)
      .setIssuedAt(now - 600)
      .setExpirationTime(now + expiresIn)
      .sign(privateKey);
  };
  const calls: string[] = [];
  const fapi = (opts: { status?: number; jwt?: string | null; setCookie?: string[] } = {}) =>
    (async (url: string | URL) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('jwks')) return new Response(JSON.stringify(jwks));
      const h = new Headers();
      for (const c of opts.setCookie ?? []) h.append('set-cookie', c);
      return new Response(JSON.stringify(opts.jwt === null ? { session: null } : { jwt: opts.jwt ?? 'x' }), { status: opts.status ?? 200, headers: h });
    }) as unknown as typeof fetch;
  return { mint, fapi, calls };
}

const req = (pathname: string, headers: Record<string, string>, method = 'GET') => ({
  nextUrl: { pathname },
  method,
  url: `https://app.example.com${pathname}`,
  headers: Object.assign(new Headers(headers), {}),
});
const html = { accept: 'text/html,application/xhtml+xml' };

describe('applySetCookies', () => {
  it('replaces, adds and deletes cookies', () => {
    expect(applySetCookies('a=1; __session=old', ['__session=new; Path=/', 'b=2; HttpOnly'])).toBe('a=1; __session=new; b=2');
    expect(applySetCookies('a=1; b=2', ['a=; Max-Age=0', 'b=x; max-age=0'])).toBe('');
    expect(applySetCookies(null, ['k=v'])).toBe('k=v');
  });
});

describe('expired-session renewal in the decider', () => {
  async function build(extra: Record<string, unknown> = {}, fapiOpts: Parameters<Awaited<ReturnType<typeof setup>>['fapi']>[0] = {}) {
    const s = await setup();
    const fresh = await s.mint();
    const fetchImpl = s.fapi({ jwt: fresh, setCookie: [`__session=${fresh}; Path=/`], ...fapiOpts });
    const decide = createAtlasDecider({ jwksUrl: JWKS_URL, issuer: ISSUER, publishableKey: 'pk_test_x', fetchImpl, publicRoutes: ['/'], ...extra });
    return { ...s, fresh, decide };
  }

  it('renews on a page navigation and lets a protected route through', async () => {
    const { mint, fresh, decide } = await build();
    const expired = await mint(-120);
    const d = await decide(req('/dashboard', { ...html, cookie: `__session=${expired}; __atlas_rt=r; a=1` }));
    expect(d).toMatchObject({ kind: 'continue', auth: { userId: 'user_1' } });
    if (d.kind !== 'continue') throw new Error();
    expect(d.refreshed?.setCookie).toEqual([`__session=${fresh}; Path=/`]);
    expect(d.refreshed?.cookieHeader).toBe(`__session=${fresh}; __atlas_rt=r; a=1`);
  });

  it('renews when __session is missing entirely', async () => {
    const { decide } = await build();
    const d = await decide(req('/dashboard', { ...html, cookie: '__atlas_rt=r' }));
    expect(d).toMatchObject({ kind: 'continue', auth: { userId: 'user_1' } });
  });

  it('makes at most one attempt per request', async () => {
    const { decide, calls } = await build({}, { status: 401 });
    const r = req('/dashboard', { ...html, cookie: '__atlas_rt=r' });
    await decide(r);
    await decide(r);
    expect(calls.filter((c) => c.endsWith('/v1/client'))).toHaveLength(1);
  });

  it('does not renew API calls, non-GET requests, or when switched off', async () => {
    const { decide, calls } = await build();
    await decide(req('/api/x', { accept: 'application/json', cookie: '__atlas_rt=r' }));
    await decide(req('/dashboard', { ...html, cookie: '__atlas_rt=r' }, 'POST'));
    const off = await build({ refreshExpiredSession: false });
    await off.decide(req('/dashboard', { ...html, cookie: '__atlas_rt=r' }));
    expect(calls.filter((c) => c.endsWith('/v1/client'))).toHaveLength(0);
    expect(off.calls.filter((c) => c.endsWith('/v1/client'))).toHaveLength(0);
  });

  it('falls back to the normal flow when renewal fails or returns an unverifiable token', async () => {
    const dead = await build({}, { status: 401 });
    expect(await dead.decide(req('/dashboard', { ...html, cookie: '__atlas_rt=r' }))).toMatchObject({ kind: 'continue', auth: { userId: null } });
    const bad = await build({}, { jwt: 'not.a.jwt' });
    const d = await bad.decide(req('/dashboard', { ...html, cookie: '__atlas_rt=r' }));
    expect(d).toMatchObject({ kind: 'continue', auth: { userId: null } });
    if (d.kind === 'continue') expect(d.refreshed).toBeUndefined();
  });

  it('never renews a forged or malformed token', async () => {
    const { decide, calls } = await build();
    await decide(req('/dashboard', { ...html, cookie: '__session=garbage; __atlas_rt=r' }));
    expect(calls.filter((c) => c.endsWith('/v1/client'))).toHaveLength(0);
  });

  it('tags a 401 with the auth status', async () => {
    const { decide } = await build({ refreshExpiredSession: false });
    expect(await decide(req('/api/x', { accept: 'application/json', cookie: '__atlas_rt=r' }))).toMatchObject({ kind: 'unauthorized', status: 'session_expired' });
    expect(await decide(req('/api/x', {}))).toMatchObject({ kind: 'unauthorized', status: 'signed_out' });
    expect(await decide(req('/api/x', { authorization: 'Bearer a.b.c' }))).toMatchObject({ kind: 'unauthorized', status: 'token_invalid' });
  });
});

describe('atlasMiddleware and atlasProxy with a renewed session', () => {
  it('middleware: next() carries the new cookie, the response sets it, 401s carry the header', async () => {
    const s = await setup();
    const fresh = await s.mint();
    const options = { jwksUrl: JWKS_URL, issuer: ISSUER, fetchImpl: s.fapi({ jwt: fresh, setCookie: [`__session=${fresh}; Path=/`] }), publicRoutes: ['/'] };
    const middleware = atlasMiddleware(options);
    const nextRes = { headers: new Headers() };
    let init: { request?: { headers: Headers } } | undefined;
    const response = {
      next: (i?: { request?: { headers: Headers } }) => ((init = i), nextRes),
      redirect: () => ({}),
      json: vi.fn(() => ({})),
    };
    await middleware(req('/dashboard', { ...html, cookie: '__atlas_rt=r', 'x-other': '1' }), response);
    expect(init?.request?.headers.get('cookie')).toBe(`__atlas_rt=r; __session=${fresh}`);
    expect(init?.request?.headers.get('x-other')).toBe('1');
    expect(nextRes.headers.get('set-cookie')).toContain(`__session=${fresh}`);

    const off = atlasMiddleware({ ...options, refreshExpiredSession: false });
    await off(req('/api/x', { cookie: '__atlas_rt=r' }), response);
    expect(response.json).toHaveBeenCalledWith(expect.anything(), { status: 401, headers: { 'x-atlas-auth-status': 'session-expired' } });
  });

  it('proxy: returns a continue response with Set-Cookie and the cookie override', async () => {
    const s = await setup();
    const fresh = await s.mint();
    const proxy = atlasProxy({ jwksUrl: JWKS_URL, issuer: ISSUER, fetchImpl: s.fapi({ jwt: fresh, setCookie: [`__session=${fresh}; Path=/`] }), publicRoutes: ['/'] });
    const res = await proxy(req('/dashboard', { ...html, cookie: '__atlas_rt=r' }) as never);
    expect(res?.headers.get('x-middleware-next')).toBe('1');
    expect(res?.headers.get('set-cookie')).toContain(`__session=${fresh}`);
    expect(res?.headers.get('x-middleware-request-cookie')).toBe(`__atlas_rt=r; __session=${fresh}`);
    expect(res?.headers.get('x-middleware-override-headers')).toContain('cookie');
    expect(res?.headers.get('x-middleware-request-x-atlas-user-id')).toBe('user_1');

    const api = await proxy(req('/api/x', { cookie: '' }) as never);
    expect(api?.status).toBe(401);
    expect(api?.headers.get('x-atlas-auth-status')).toBe('signed-out');
  });
});
