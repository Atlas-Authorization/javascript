import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { atlasMiddleware, getAuth } from './index';

const fapi = (body: unknown, status = 200) =>
  vi.fn(async (input: RequestInfo | URL) =>
    String(input).endsWith('/exchange')
      ? new Response(JSON.stringify(body), { status })
      : new Response(JSON.stringify({ keys: [] }), { status: 200 }),
  ) as unknown as typeof fetch;

async function serve(fetchImpl: typeof fetch, bridge: true | { signInUrl?: string } = true) {
  const app = express();
  app.use(atlasMiddleware({ jwksUrl: 'https://f.test/jwks', issuer: 'https://f.test', publishableKey: 'pk_test_x', fetchImpl, betterAuthBridge: bridge }));
  app.all('/page', (req, res) => res.json({ signedIn: getAuth(req).isSignedIn }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, close: () => new Promise((r) => server.close(r)) };
}

describe('@atlasauth/express betterAuthBridge', () => {
  it('redirects to the same URL with the Atlas cookies and the Better Auth cookies cleared', async () => {
    const s = await serve(fapi({ object: 'session_tokens', jwt: 'j', refresh_token: 'r' }));
    const res = await fetch(`${s.url}/page?a=1`, { headers: { cookie: 'better-auth.session_token=tok.sig' }, redirect: 'manual' });
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('/page?a=1');
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith('__atlas_rt=r;') && c.includes('HttpOnly'))).toBe(true);
    expect(cookies.some((c) => c.startsWith('better-auth.session_token=;') && c.includes('Max-Age=0'))).toBe(true);
    await s.close();
  });

  it('owed MFA → sign-in URL with the attempt; POST and cookie-less requests pass through', async () => {
    const f = fapi({ object: 'sign_in_attempt', id: 'sia_2', status: 'needs_second_factor' });
    const s = await serve(f, { signInUrl: '/sign-in' });
    const res = await fetch(`${s.url}/page`, { headers: { cookie: 'better-auth.session_token=t' }, redirect: 'manual' });
    expect(new URL(res.headers.get('location')!).searchParams.get('__atlas_attempt')).toBe('sia_2');
    const post = await fetch(`${s.url}/page`, { method: 'POST', headers: { cookie: 'better-auth.session_token=t' } });
    expect(post.status).toBe(200);
    const plain = await fetch(`${s.url}/page`);
    expect(await plain.json()).toEqual({ signedIn: false });
    await s.close();
  });
});
