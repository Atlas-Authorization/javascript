import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { atlasMountPlugin } from './mount';

function app(extra: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; headers: Headers; body: string | null }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = init.body ? await new Response(init.body as BodyInit).text() : null;
    calls.push({ url, headers: init.headers as Headers, body });
    return new Response('ok', { status: 201, headers: [['set-cookie', 'a=1'], ['set-cookie', 'b=2']] });
  }) as unknown as typeof fetch;
  const f = Fastify();
  f.register(atlasMountPlugin({ upstream: 'https://x-fapi.atlas.test', proxySecret: 'aps', fetchImpl, verifyToken: 'tok', ...extra }));
  return { f, calls };
}

describe('atlasMountPlugin', () => {
  it('proxies the mount with the prefix, raw body, every Set-Cookie and the proxy secret', async () => {
    const { f, calls } = app();
    const res = await f.inject({
      method: 'POST',
      url: '/atlas/v1/client/sign_ins?x=1',
      payload: '{"a":1}',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '6.6.6.6, 203.0.113.7', host: 'app.example.com' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    expect(calls[0]!.url).toBe('https://x-fapi.atlas.test/atlas/v1/client/sign_ins?x=1');
    expect(calls[0]!.body).toBe('{"a":1}');
    expect(calls[0]!.headers.get('x-atlas-proxy-secret')).toBe('aps');
    expect(calls[0]!.headers.get('x-atlas-client-ip')).toBe('203.0.113.7');
    expect(calls[0]!.headers.get('x-atlas-sdk')).toMatch(/^@atlasauth\/fastify\//);
  });

  it('does not take a spoofed leftmost X-Forwarded-For as the client IP', async () => {
    const { f, calls } = app();
    await f.inject({ method: 'GET', url: '/atlas/v1/x', headers: { 'x-forwarded-for': '6.6.6.6' } });
    // one entry, one hop: that entry IS the nearest proxy's; a spoof needs a second entry to the left
    await f.inject({ method: 'GET', url: '/atlas/v1/x', headers: { 'x-forwarded-for': '6.6.6.6, 7.7.7.7' } });
    expect(calls[1]!.headers.get('x-atlas-client-ip')).toBe('7.7.7.7');
  });

  it('answers 503 without config and 404 outside the base path', async () => {
    const f = Fastify();
    f.register(atlasMountPlugin({ upstream: '', proxySecret: '' }));
    expect((await f.inject({ method: 'GET', url: '/atlas/v1' })).statusCode).toBe(503);
    expect((await f.inject({ method: 'GET', url: '/other' })).statusCode).toBe(404);
  });

  it('serves the verification file and a signed-less webhook is refused', async () => {
    const { f } = app({ webhook: { path: '/hooks/atlas', secret: 'whsec', onEvent: () => {} } });
    const v = await f.inject({ method: 'GET', url: '/.well-known/atlas-verify/tok' });
    expect(v.statusCode).toBe(200);
    expect(v.body).toBe('tok');
    expect((await f.inject({ method: 'GET', url: '/.well-known/atlas-verify/nope' })).statusCode).toBe(404);
    expect((await f.inject({ method: 'POST', url: '/hooks/atlas', payload: '{}', headers: { 'content-type': 'application/json' } })).statusCode).toBe(400);
  });
});
