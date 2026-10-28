import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { atlasMiddleware, getAuth } from './index';

const fapi = (body: unknown, status = 200) =>
  vi.fn(async (input: RequestInfo | URL) =>
    String(input).endsWith('/exchange')
      ? new Response(JSON.stringify(body), { status })
      : new Response(JSON.stringify({ keys: [] }), { status: 200 }),
  ) as unknown as typeof fetch;

function build(fetchImpl: typeof fetch, signInUrl?: string) {
  const app = new Hono();
  app.use(
    '*',
    atlasMiddleware({
      jwksUrl: 'https://f.test/jwks',
      issuer: 'https://f.test',
      publishableKey: 'pk_test_x',
      fetchImpl,
      betterAuthBridge: signInUrl ? { signInUrl } : true,
    }) as never,
  );
  app.get('/page', (c) => c.json({ signedIn: getAuth(c as never).isSignedIn }));
  return app;
}

describe('@atlasauth/hono betterAuthBridge', () => {
  it('returns the redirect with Atlas cookies and the Better Auth cookies cleared', async () => {
    const app = build(fapi({ object: 'session_tokens', jwt: 'j', refresh_token: 'r' }));
    const res = await app.request('https://app.example.com/page', { headers: { cookie: 'better-auth.session_token=t' } });
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://app.example.com/page');
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith('__atlas_rt=r;'))).toBe(true);
    expect(cookies.some((c) => c.startsWith('better-auth.session_data=;'))).toBe(true);
  });

  it('owed MFA → sign-in with the attempt; no cookie → normal handling', async () => {
    const app = build(fapi({ object: 'sign_in_attempt', id: 'sia_3', status: 'needs_mfa_enrollment' }), '/sign-in');
    const res = await app.request('https://app.example.com/page', { headers: { cookie: 'better-auth.session_token=t' } });
    const loc = new URL(res.headers.get('location')!);
    expect(loc.pathname).toBe('/sign-in');
    expect(loc.searchParams.get('__atlas_status')).toBe('needs_mfa_enrollment');
    const plain = await app.request('https://app.example.com/page');
    expect(await plain.json()).toEqual({ signedIn: false });
  });
});
