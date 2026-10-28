import { describe, expect, it, vi } from 'vitest';
import { atlasMiddleware, createAtlasDecider } from './middleware';
import { atlasProxy } from './proxy';

const ISSUER = 'https://fapi.atlas.test';
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;

/** Fake FAPI: JWKS (empty — no __session here) + the exchange answer. */
function fapi(answer: { status: number; body: unknown }) {
  const exchanges: Array<Record<string, unknown>> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/exchange')) {
      exchanges.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }
    return new Response(JSON.stringify({ keys: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, exchanges };
}

const req = (path: string, cookie: string, method = 'GET') => ({
  method,
  url: `https://app.example.com${path}`,
  nextUrl: { pathname: path.split('?')[0]! },
  headers: { get: (n: string) => (n.toLowerCase() === 'cookie' ? cookie : null) },
});

const base = { jwksUrl: JWKS_URL, issuer: ISSUER, publishableKey: 'pk_test_x', publicRoutes: ['/(.*)'] };

describe('betterAuthBridge (Next.js middleware)', () => {
  it('exchanges the Better Auth cookie and re-enters on the same URL with Atlas cookies', async () => {
    const { fetchImpl, exchanges } = fapi({ status: 200, body: { object: 'session_tokens', jwt: 'jwt1', refresh_token: 'rt1' } });
    const decide = createAtlasDecider({ ...base, fetchImpl, betterAuthBridge: { cookieDomain: '.example.com' } });
    const out = await decide(req('/app?x=1', '__Secure-better-auth.session_token=tok.sig'));
    expect(exchanges).toEqual([{ token: 'tok.sig', delivery: 'body' }]);
    expect(out.kind).toBe('redirect');
    if (out.kind !== 'redirect') return;
    expect(out.location).toBe('https://app.example.com/app?x=1');
    expect(out.cookies.find((c) => c.name === '__session')?.value).toBe('jwt1');
    expect(out.cookies.find((c) => c.name === '__Secure-better-auth.session_token')?.options).toMatchObject({ maxAge: 0, domain: '.example.com' });
  });

  it('skips non-GET requests and requests already carrying an Atlas session', async () => {
    const { fetchImpl, exchanges } = fapi({ status: 200, body: {} });
    const decide = createAtlasDecider({ ...base, fetchImpl, betterAuthBridge: true });
    await decide(req('/api/x', 'better-auth.session_token=t', 'POST'));
    await decide(req('/', 'better-auth.session_token=t; __atlas_rt=r'));
    expect(exchanges).toHaveLength(0);
  });

  it('owed MFA → the sign-in URL carrying the attempt', async () => {
    const { fetchImpl } = fapi({ status: 200, body: { object: 'sign_in_attempt', id: 'sia_1', status: 'needs_second_factor' } });
    const decide = createAtlasDecider({ ...base, fetchImpl, betterAuthBridge: { signInUrl: '/sign-in' } });
    const out = await decide(req('/app', 'better-auth.session_token=t'));
    expect(out.kind === 'redirect' && out.location).toBe(
      'https://app.example.com/sign-in?__atlas_attempt=sia_1&__atlas_status=needs_second_factor',
    );
  });

  it('a final refusal clears the Better Auth cookie once; a closed bridge keeps it and continues', async () => {
    const reused = fapi({ status: 400, body: { errors: [{ meta: { bridge_outcome: 'reused' } }] } });
    const out = await createAtlasDecider({ ...base, fetchImpl: reused.fetchImpl, betterAuthBridge: true })(req('/', 'better-auth.session_token=t'));
    expect(out.kind).toBe('redirect');
    if (out.kind === 'redirect') expect(out.cookies.every((c) => c.options.maxAge === 0)).toBe(true);

    const closed = fapi({ status: 403, body: { errors: [{ meta: { bridge_outcome: 'closed' } }] } });
    const kept = await createAtlasDecider({ ...base, fetchImpl: closed.fetchImpl, betterAuthBridge: true })(req('/', 'better-auth.session_token=t'));
    expect(kept.kind).toBe('continue');
  });

  it('requires a publishable key', () => {
    expect(() => createAtlasDecider({ jwksUrl: JWKS_URL, issuer: ISSUER, betterAuthBridge: true })).toThrow(/publishableKey/);
  });

  it('atlasMiddleware sets the cookies on the redirect; atlasProxy serializes them with Domain', async () => {
    const { fetchImpl } = fapi({ status: 200, body: { object: 'session_tokens', jwt: 'j', refresh_token: 'r' } });
    const set: string[] = [];
    const mw = atlasMiddleware({ ...base, fetchImpl, betterAuthBridge: true });
    await mw(req('/', 'better-auth.session_token=t'), {
      next: () => ({}),
      json: () => ({}),
      redirect: () => ({ cookies: { set: (name: string) => set.push(name) } }),
    });
    expect(set).toContain('__session');
    expect(set).toContain('better-auth.session_token');

    const proxy = atlasProxy({ ...base, fetchImpl, betterAuthBridge: { cookieDomain: '.example.com' } });
    const res = await proxy({ ...req('/', 'better-auth.session_token=t'), headers: { get: (n: string) => (n === 'cookie' ? 'better-auth.session_token=t' : null), forEach: () => {} } });
    expect(res?.status).toBe(307);
    expect(res?.headers.get('set-cookie')).toContain('Domain=.example.com');
  });

  it('with secretKey the middleware exchanges through the Backend API', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      return String(input).includes('/exchange')
        ? new Response(JSON.stringify({ object: 'session_tokens', jwt: 'j', refresh_token: 'r' }), { status: 200 })
        : new Response(JSON.stringify({ keys: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const decide = createAtlasDecider({ ...base, fetchImpl, betterAuthBridge: { secretKey: 'sk_test_q', bapiBaseUrl: 'https://api.example' } });
    const out = await decide(req('/', 'better-auth.session_token=t'));
    expect(out.kind).toBe('redirect');
    expect(urls).toContain('https://api.example/v1/migrations/better_auth/exchange');
  });
});
