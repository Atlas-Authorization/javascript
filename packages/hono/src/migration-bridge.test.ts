import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { atlasMiddleware, getAuth, migrationBridge, type MigrationBridgeConfig } from './index';

const fapi = (body: unknown, status = 200) =>
  vi.fn(async (input: RequestInfo | URL) =>
    String(input).endsWith('/exchange')
      ? new Response(JSON.stringify(body), { status })
      : new Response(JSON.stringify({ keys: [] }), { status: 200 }),
  ) as unknown as typeof fetch;

function build(fetchImpl: typeof fetch, config: MigrationBridgeConfig) {
  const app = new Hono();
  app.use('*', atlasMiddleware({ jwksUrl: 'https://f.test/jwks', issuer: 'https://f.test', publishableKey: 'pk_test_x', fetchImpl, migrationBridge: config }) as never);
  app.get('/page', (c) => c.json({ signedIn: getAuth(c as never).isSignedIn }));
  return app;
}

describe('@atlasauth/hono migrationBridge', () => {
  it("exchanges the vendor's cookie and returns the redirect with Atlas cookies and the old ones cleared", async () => {
    const f = fapi({ object: 'session_tokens', jwt: 'j', refresh_token: 'r' });
    const app = build(f, { source: 'lucia' });
    const res = await app.request('https://app.example.com/page', { headers: { cookie: 'auth_session=opaque' } });
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://app.example.com/page');
    const call = (f as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls.find((c) => String(c[0]).endsWith('/exchange'))!;
    expect(String(call[0])).toBe('https://f.test/v1/client/migrations/lucia/exchange');
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith('__atlas_rt=r;'))).toBe(true);
    expect(cookies.some((c) => c.startsWith('auth_session=;'))).toBe(true);
  });

  it('owed MFA → sign-in with the attempt; no cookie → normal handling', async () => {
    const app = build(fapi({ object: 'sign_in_attempt', id: 'sia_4', status: 'needs_second_factor' }), { source: 'lucia', signInUrl: '/sign-in' });
    const res = await app.request('https://app.example.com/page', { headers: { cookie: 'auth_session=t' } });
    const loc = new URL(res.headers.get('location')!);
    expect(loc.pathname).toBe('/sign-in');
    expect(loc.searchParams.get('__atlas_attempt')).toBe('sia_4');
    const plain = await app.request('https://app.example.com/page');
    expect(await plain.json()).toEqual({ signedIn: false });
  });

  it('needs publishableKey on its own', () => {
    expect(() => migrationBridge({ jwksUrl: 'https://f.test/jwks', config: { source: 'lucia' } })).toThrow(/publishableKey/);
  });
});
