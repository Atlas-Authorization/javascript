import { describe, expect, it } from 'vitest';
import { createMountHandler, createVerifyHandler } from './mount';

function capture(response: () => Response) {
  const calls: Array<{ url: string; init: RequestInit & { duplex?: string }; body: string | null }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = init.body ? await new Response(init.body as BodyInit).text() : null;
    calls.push({ url, init, body });
    return response();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const opts = { upstream: 'https://bright-fox-42-fapi.atlas.test', proxySecret: 'aps_secret', basePath: '/atlas' };

describe('createMountHandler', () => {
  it('forwards method, full path, query, body and the Atlas headers', async () => {
    const { calls, fetchImpl } = capture(() => new Response('ok'));
    const { POST } = createMountHandler({ ...opts, fetchImpl });
    const req = new Request('https://app.example.com/atlas/v1/client/sign_ins?_clerk=1', {
      method: 'POST',
      body: 'identifier=a%40b.test',
      headers: {
        host: 'app.example.com',
        cookie: '__client=abc',
        origin: 'https://app.example.com',
        connection: 'keep-alive',
        'proxy-authorization': 'x',
        'x-atlas-proxy-secret': 'forged',
        'x-atlas-forwarded-host': 'evil.test',
        'x-forwarded-for': '203.0.113.7, 10.0.0.1',
        'x-forwarded-proto': 'https',
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const [call] = calls;
    expect(call!.url).toBe('https://bright-fox-42-fapi.atlas.test/atlas/v1/client/sign_ins?_clerk=1');
    expect(call!.init.method).toBe('POST');
    expect(call!.init.redirect).toBe('manual');
    expect(call!.init.duplex).toBe('half');
    expect(call!.body).toBe('identifier=a%40b.test');
    const h = call!.init.headers as Headers;
    expect(h.get('x-atlas-forwarded-host')).toBe('app.example.com');
    expect(h.get('x-atlas-proxy-secret')).toBe('aps_secret');
    expect(h.get('x-atlas-client-ip')).toBe('203.0.113.7');
    expect(h.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(h.get('x-forwarded-proto')).toBe('https');
    expect(h.get('cookie')).toBe('__client=abc');
    expect(h.get('origin')).toBe('https://app.example.com');
    for (const name of ['host', 'connection', 'proxy-authorization']) expect(h.get(name)).toBeNull();
  });

  it('keeps every Set-Cookie, drops content-encoding/length, does not follow redirects', async () => {
    const { fetchImpl } = capture(() => {
      const headers = new Headers({ location: '/atlas/hosted/sign-in', 'content-encoding': 'gzip', 'content-length': '3', 'x-request-id': 'r1' });
      headers.append('set-cookie', '__session=a; Path=/');
      headers.append('set-cookie', '__atlas_rt=b; Path=/atlas; HttpOnly');
      return new Response(null, { status: 302, headers });
    });
    const { GET } = createMountHandler({ ...opts, fetchImpl });
    const res = await GET(new Request('https://app.example.com/atlas/oauth2/authorize'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/atlas/hosted/sign-in');
    expect(res.headers.getSetCookie()).toEqual(['__session=a; Path=/', '__atlas_rt=b; Path=/atlas; HttpOnly']);
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('content-length')).toBeNull();
    expect(res.headers.get('x-request-id')).toBe('r1');
  });

  it('404s outside the base path and fails loudly without config', async () => {
    const { calls, fetchImpl } = capture(() => new Response('ok'));
    const { GET } = createMountHandler({ ...opts, fetchImpl });
    expect((await GET(new Request('https://app.example.com/atlasx/v1'))).status).toBe(404);
    expect(calls).toHaveLength(0);
    await expect(createMountHandler({ basePath: '/atlas', fetchImpl }).GET(new Request('https://app.example.com/atlas/v1'))).rejects.toThrow(/ATLAS_UPSTREAM/);
  });

  it('HEAD and 204 carry no body', async () => {
    const { fetchImpl } = capture(() => new Response(null, { status: 204 }));
    const { OPTIONS } = createMountHandler({ ...opts, fetchImpl });
    expect((await OPTIONS(new Request('https://app.example.com/atlas/v1/client', { method: 'OPTIONS' }))).status).toBe(204);
  });
});

describe('createVerifyHandler', () => {
  const { GET } = createVerifyHandler({ verifyToken: 'tok123' });
  it('serves the token when it matches', async () => {
    const res = await GET(new Request('https://app.example.com/.well-known/atlas-verify/tok123'), { params: Promise.resolve({ token: 'tok123' }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await res.text()).toBe('tok123');
  });
  it('404s otherwise', async () => {
    expect((await GET(new Request('https://app.example.com/.well-known/atlas-verify/nope'), { params: { token: 'nope' } })).status).toBe(404);
    expect((await GET(new Request('https://app.example.com/.well-known/atlas-verify/nope'))).status).toBe(404);
    expect((await createVerifyHandler({}).GET(new Request('https://app.example.com/.well-known/atlas-verify/x'))).status).toBe(404);
  });
});
