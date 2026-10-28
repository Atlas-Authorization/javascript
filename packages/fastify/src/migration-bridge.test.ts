import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { atlasPlugin, getAuth, migrationBridgeHook, type MigrationBridgeConfig } from './index';

const fapi = (body: unknown, status = 200) =>
  vi.fn(async (input: RequestInfo | URL) =>
    String(input).endsWith('/exchange')
      ? new Response(JSON.stringify(body), { status })
      : new Response(JSON.stringify({ keys: [] }), { status: 200 }),
  ) as unknown as typeof fetch;

async function build(fetchImpl: typeof fetch, config: MigrationBridgeConfig) {
  const app = Fastify();
  const plugin = atlasPlugin({ jwksUrl: 'https://f.test/jwks', issuer: 'https://f.test', publishableKey: 'pk_test_x', fetchImpl, migrationBridge: config });
  await new Promise<void>((resolve) => plugin(app, {}, () => resolve()));
  app.get('/page', async (request) => ({ signedIn: getAuth(request).isSignedIn }));
  app.post('/page', async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe('@atlasauth/fastify migrationBridge', () => {
  it("exchanges the vendor's (chunked Supabase) cookie on GET: 307 with Atlas cookies, old ones cleared", async () => {
    const f = fapi({ object: 'session_tokens', jwt: 'j', refresh_token: 'r' });
    const app = await build(f, { source: 'supabase', presetVars: { project_ref: 'abcdefgh' } });
    const value = encodeURIComponent(JSON.stringify({ access_token: 'sb_at' }));
    const res = await app.inject({ method: 'GET', url: '/page?z=1', headers: { cookie: `sb-abcdefgh-auth-token=${value}` } });
    expect(res.statusCode).toBe(307);
    expect(res.headers.location).toBe('/page?z=1');
    const call = (f as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls.find((c) => String(c[0]).endsWith('/exchange'))!;
    expect(String(call[0])).toBe('https://f.test/v1/client/migrations/supabase/exchange');
    expect(JSON.parse(String(call[1].body)).token).toBe('sb_at');
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    expect(cookies.some((c) => c.startsWith('__session=j;'))).toBe(true);
    expect(cookies.some((c) => c.startsWith('sb-abcdefgh-auth-token=;') && c.includes('Max-Age=0'))).toBe(true);
    await app.close();
  });

  it('leaves POST and a bridge that could not judge alone', async () => {
    const app = await build(fapi({ errors: [{ meta: { bridge_outcome: 'closed' } }] }, 403), { source: 'custom', cookieNames: ['sid'] });
    expect((await app.inject({ method: 'POST', url: '/page', headers: { cookie: 'sid=t' } })).statusCode).toBe(200);
    const get = await app.inject({ method: 'GET', url: '/page', headers: { cookie: 'sid=t' } });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ signedIn: false });
    await app.close();
  });

  it('needs publishableKey on its own', () => {
    expect(() => migrationBridgeHook({ jwksUrl: 'https://f.test/jwks', config: { source: 'auth0' } })).toThrow(/publishableKey/);
  });
});
