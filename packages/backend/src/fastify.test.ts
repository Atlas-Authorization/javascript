import { describe, expect, it, vi } from 'vitest';
import { createTestIssuer } from './testing';
import { atlasFastify, type FastifyLikeInstance, type FastifyLikeReply, type FastifyLikeRequest } from './fastify';
import { AtlasConfigError } from './mount';

/** A recording stand-in for a Fastify instance: no fastify dependency needed. */
function fakeApp() {
  const decorated: Record<string, unknown> = {};
  const routes: Record<string, (req: FastifyLikeRequest, reply: FastifyLikeReply) => unknown> = {};
  const parsers: string[] = [];
  const app: FastifyLikeInstance = {
    decorate: (n, v) => void (decorated[n] = v),
    decorateRequest: () => undefined,
    register: (plugin) => void plugin(app, {}, () => undefined),
    addContentTypeParser: (t) => void parsers.push(t),
    post: (url, handler) => void (routes[url] = handler),
  };
  return { app, decorated, routes, parsers };
}

function reply() {
  const r = { status: 200, headers: {} as Record<string, unknown>, payload: undefined as unknown } as { status: number; headers: Record<string, unknown>; payload: unknown } & FastifyLikeReply;
  r.code = (s) => ((r.status = s), r);
  r.header = (n, v) => ((r.headers[n] = v), r);
  r.send = (p) => ((r.payload = p), r);
  return r;
}

const req = (headers: Record<string, string>, extra: Partial<FastifyLikeRequest> = {}): FastifyLikeRequest => ({ headers, method: 'POST', url: '/x', ...extra });

describe('atlasFastify', () => {
  it('authenticate accepts a bearer token or the __session cookie, and refuses otherwise', async () => {
    const issuer = await createTestIssuer();
    const { app, decorated } = fakeApp();
    atlasFastify(app, { backend: { issuer: issuer.issuer, jwks: issuer.jwks } }, (e) => expect(e).toBeUndefined());
    const authenticate = decorated.authenticate as (r: FastifyLikeRequest, p: FastifyLikeReply) => Promise<unknown>;
    const token = await issuer.mintSession({ sub: 'user_1' });

    const viaBearer = req({ authorization: `Bearer ${token}` });
    await authenticate(viaBearer, reply());
    expect(viaBearer.atlasAuth?.claims.sub).toBe('user_1');

    const viaCookie = req({ cookie: `a=b; __session=${token}` });
    await authenticate(viaCookie, reply());
    expect(viaCookie.atlasAuth?.claims.sub).toBe('user_1');

    const anon = reply();
    await authenticate(req({}), anon);
    expect(anon.status).toBe(401);
    expect(anon.payload).toMatchObject({ error: 'unauthorized' });
  });

  it('exchange verifies online and hands the session to onExchange', async () => {
    const issuer = await createTestIssuer();
    const seen: string[] = [];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ verified: true }), { status: 200 })) as unknown as typeof fetch;
    const { app, routes } = fakeApp();
    atlasFastify(
      app,
      {
        backend: { issuer: issuer.issuer, jwks: issuer.jwks, secretKey: 'sk_test_x', fetchImpl },
        exchange: { path: '/auth/exchange', onExchange: (s) => (seen.push(s.claims.sub), { ok: true }) },
      },
      () => undefined,
    );
    const token = await issuer.mintSession({ sub: 'user_9' });
    expect(await routes['/auth/exchange']!(req({ authorization: `Bearer ${token}` }), reply())).toEqual({ ok: true });
    expect(seen).toEqual(['user_9']);
    expect(String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toBe('https://api.atlasauth.net/v1/tokens/verify');

    const bad = reply();
    await routes['/auth/exchange']!(req({}, { body: {} }), bad);
    expect(bad.status).toBe(401);
  });

  it('exchange without a secret key rejects with the typed config error', async () => {
    const issuer = await createTestIssuer();
    const { app, routes } = fakeApp();
    atlasFastify(app, { backend: { issuer: issuer.issuer, jwks: issuer.jwks, secretKey: undefined }, exchange: { onExchange: () => ({}) } }, () => undefined);
    const token = await issuer.mintSession({ sub: 'user_1' });
    await expect(Promise.resolve(routes['/atlas/exchange']!(req({ authorization: `Bearer ${token}` }), reply()))).rejects.toBeInstanceOf(AtlasConfigError);
  });

  it('webhook route is registered with a raw-body parser in its own scope; unsigned deliveries get 400', async () => {
    const issuer = await createTestIssuer();
    const { app, routes, parsers } = fakeApp();
    atlasFastify(app, { backend: { issuer: issuer.issuer, jwks: issuer.jwks }, webhook: { path: '/hooks', secret: 'whsec_x', onEvent: () => undefined } }, () => undefined);
    expect(parsers).toEqual(['application/json']);
    const r = reply();
    await routes['/hooks']!(req({ host: 'api.example.com', 'content-type': 'application/json' }, { body: Buffer.from('{}') }), r);
    expect(r.status).toBe(400);
  });
});
