import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { atlasPlugin, getAuth } from './index';

const fapi = (body: unknown, status = 200) =>
  vi.fn(async (input: RequestInfo | URL) =>
    String(input).endsWith('/exchange')
      ? new Response(JSON.stringify(body), { status })
      : new Response(JSON.stringify({ keys: [] }), { status: 200 }),
  ) as unknown as typeof fetch;

async function build(fetchImpl: typeof fetch) {
  const app = Fastify();
  // Applied to the root instance (as fastify-plugin would), so the routes below get its hooks.
  const plugin = atlasPlugin({ jwksUrl: 'https://f.test/jwks', issuer: 'https://f.test', publishableKey: 'pk_test_x', fetchImpl, betterAuthBridge: true });
  await new Promise<void>((resolve) => plugin(app, {}, () => resolve()));
  app.get('/page', async (request) => ({ signedIn: getAuth(request).isSignedIn }));
  app.post('/page', async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe('@atlasauth/fastify betterAuthBridge', () => {
  it('exchanges on GET: 307 to the same URL with Atlas cookies set and Better Auth cookies cleared', async () => {
    const app = await build(fapi({ object: 'session_tokens', jwt: 'j', refresh_token: 'r' }));
    const res = await app.inject({ method: 'GET', url: '/page?z=1', headers: { cookie: '__Secure-better-auth.session_token=t' } });
    expect(res.statusCode).toBe(307);
    expect(res.headers.location).toBe('/page?z=1');
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    expect(cookies.some((c) => c.startsWith('__session=j;'))).toBe(true);
    expect(cookies.some((c) => c.startsWith('__Secure-better-auth.session_token=;') && c.includes('Secure'))).toBe(true);
    await app.close();
  });

  it('leaves POST and a bridge that could not judge alone', async () => {
    const app = await build(fapi({ errors: [{ meta: { bridge_outcome: 'closed' } }] }, 403));
    expect((await app.inject({ method: 'POST', url: '/page', headers: { cookie: 'better-auth.session_token=t' } })).statusCode).toBe(200);
    const get = await app.inject({ method: 'GET', url: '/page', headers: { cookie: 'better-auth.session_token=t' } });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ signedIn: false });
    await app.close();
  });
});
