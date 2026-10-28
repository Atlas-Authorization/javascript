import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { atlasMiddleware, getAuth, migrationBridge, type MigrationBridgeConfig } from './index';

const fapi = (body: unknown, status = 200) =>
  vi.fn(async (input: RequestInfo | URL) =>
    String(input).endsWith('/exchange')
      ? new Response(JSON.stringify(body), { status })
      : new Response(JSON.stringify({ keys: [] }), { status: 200 }),
  ) as unknown as typeof fetch;

const COGNITO: MigrationBridgeConfig = { source: 'cognito', presetVars: { region: 'us-east-1', user_pool_id: 'us-east-1_X', client_id: 'abc' } };

async function serve(fetchImpl: typeof fetch, config: MigrationBridgeConfig = COGNITO) {
  const app = express();
  app.use(atlasMiddleware({ jwksUrl: 'https://f.test/jwks', issuer: 'https://f.test', publishableKey: 'pk_test_x', fetchImpl, migrationBridge: config }));
  app.all('/page', (req, res) => res.json({ signedIn: getAuth(req).isSignedIn }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, close: () => new Promise((r) => server.close(r)) };
}

describe('@atlasauth/express migrationBridge', () => {
  it("exchanges the vendor's cookie at its source's path and clears the old cookies", async () => {
    const f = fapi({ object: 'session_tokens', jwt: 'j', refresh_token: 'r' });
    const s = await serve(f);
    const res = await fetch(`${s.url}/page?a=1`, {
      headers: { cookie: 'CognitoIdentityServiceProvider.abc.jane.idToken=idtok; CognitoIdentityServiceProvider.abc.LastAuthUser=jane' },
      redirect: 'manual',
    });
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('/page?a=1');
    const exchange = (f as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls.find((c) => String(c[0]).endsWith('/exchange'))!;
    expect(String(exchange[0])).toBe('https://f.test/v1/client/migrations/cognito/exchange');
    expect(JSON.parse(String(exchange[1].body)).token).toBe('idtok');
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith('__atlas_rt=r;') && c.includes('HttpOnly'))).toBe(true);
    expect(cookies.some((c) => c.startsWith('CognitoIdentityServiceProvider.abc.LastAuthUser=;') && c.includes('Max-Age=0'))).toBe(true);
    await s.close();
  });

  it('owed MFA → sign-in URL; POST and requests without the old cookie pass through', async () => {
    const s = await serve(fapi({ object: 'sign_in_attempt', id: 'sia_3', status: 'needs_second_factor' }), { source: 'custom', cookieNames: ['sid'], signInUrl: '/sign-in' });
    const res = await fetch(`${s.url}/page`, { headers: { cookie: 'sid=opaque' }, redirect: 'manual' });
    const loc = new URL(res.headers.get('location')!);
    expect(loc.pathname).toBe('/sign-in');
    expect(loc.searchParams.get('__atlas_attempt')).toBe('sia_3');
    expect((await fetch(`${s.url}/page`, { method: 'POST', headers: { cookie: 'sid=opaque' } })).status).toBe(200);
    expect(await (await fetch(`${s.url}/page`)).json()).toEqual({ signedIn: false });
    await s.close();
  });

  it('needs publishableKey on its own', () => {
    expect(() => migrationBridge({ jwksUrl: 'https://f.test/jwks', config: COGNITO })).toThrow(/publishableKey/);
  });
});
