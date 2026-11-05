import { describe, expect, it, vi } from 'vitest';
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
        'x-forwarded-for': '10.0.0.1, 203.0.113.7',
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

  it('takes X-Forwarded-Proto from the nearest proxy, http or https only', async () => {
    const proto = async (value: string) => {
      const { calls, fetchImpl } = capture(() => new Response('ok'));
      const { GET } = createMountHandler({ ...opts, fetchImpl });
      await GET(new Request('https://app.example.com/atlas/v1/client', { headers: { 'x-forwarded-proto': value } }));
      return (calls[0]!.init.headers as Headers).get('x-forwarded-proto');
    };
    expect(await proto('http, https')).toBe('https');
    expect(await proto('https, http')).toBe('http');
    expect(await proto('javascript')).toBe('https');
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

  it('404s outside the base path', async () => {
    const { calls, fetchImpl } = capture(() => new Response('ok'));
    const { GET } = createMountHandler({ ...opts, fetchImpl });
    expect((await GET(new Request('https://app.example.com/atlasx/v1'))).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('answers 503 without config and logs it once', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { calls, fetchImpl } = capture(() => new Response('ok'));
      const { GET } = createMountHandler({ basePath: '/atlas', fetchImpl });
      const res = await GET(new Request('https://app.example.com/atlas/v1'));
      expect(res.status).toBe(503);
      expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
      expect((await createMountHandler({ upstream: opts.upstream, fetchImpl }).GET(new Request('https://app.example.com/atlas/v1'))).status).toBe(503);
      expect(calls).toHaveLength(0);
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0]![0])).toMatch(/ATLAS_UPSTREAM/);
    } finally {
      error.mockRestore();
    }
  });

  describe('client IP', () => {
    async function forwardedIp(xff: string | undefined, extra: Parameters<typeof createMountHandler>[0] = {}, headers: Record<string, string> = {}) {
      const { calls, fetchImpl } = capture(() => new Response('ok'));
      const { GET } = createMountHandler({ ...opts, ...extra, fetchImpl });
      await GET(new Request('https://app.example.com/atlas/v1/client', { headers: { ...(xff === undefined ? {} : { 'x-forwarded-for': xff }), ...headers } }));
      const h = calls[0]!.init.headers as Headers;
      expect(h.get('x-forwarded-for')).toBe(h.get('x-atlas-client-ip'));
      return h.get('x-atlas-client-ip');
    }

    it('never forwards a spoofed leftmost X-Forwarded-For or X-Real-IP; uses the rightmost entry', async () => {
      expect(await forwardedIp('6.6.6.6, 198.51.100.4', {}, { 'x-real-ip': '6.6.6.6' })).toBe('198.51.100.4');
      expect(await forwardedIp('198.51.100.4')).toBe('198.51.100.4');
      expect(await forwardedIp(undefined, {}, { 'x-real-ip': '6.6.6.6' })).toBeNull();
    });

    it('honours trustedProxyHops', async () => {
      expect(await forwardedIp('6.6.6.6, 198.51.100.4, 10.0.0.2', { trustedProxyHops: 2 })).toBe('198.51.100.4');
      expect(await forwardedIp('198.51.100.4', { trustedProxyHops: 2 })).toBeNull();
      expect(await forwardedIp('6.6.6.6, 198.51.100.4', { trustedProxyHops: 0 })).toBeNull();
    });

    it('prefers a custom clientIp', async () => {
      expect(await forwardedIp('6.6.6.6', { clientIp: () => '2001:db8::1' })).toBe('2001:db8::1');
      expect(await forwardedIp('6.6.6.6', { clientIp: () => undefined })).toBeNull();
    });

    it('strips ports and brackets and drops anything that is not an IP', async () => {
      expect(await forwardedIp('6.6.6.6, 198.51.100.4:5123')).toBe('198.51.100.4');
      expect(await forwardedIp('6.6.6.6, [2001:db8::2]:443')).toBe('2001:db8::2');
      for (const junk of ['not-an-ip', '999.1.1.1', '1.2.3', '<script>', '6.6.6.6, ', 'gggg::1']) expect(await forwardedIp(junk)).toBeNull();
      expect(await forwardedIp('6.6.6.6', { clientIp: () => 'garbage' })).toBeNull();
    });
  });

  describe('what reaches upstream', () => {
    const upstreamHeaders = async (headers: Record<string, string>, options: Parameters<typeof createMountHandler>[0] = {}) => {
      const { calls, fetchImpl } = capture(() => new Response('ok'));
      const { GET } = createMountHandler({ ...opts, ...options, fetchImpl });
      await GET(new Request('https://app.example.com/atlas/v1/client', { headers }));
      return calls[0]!.init.headers as Headers;
    };

    it('forwards only Atlas cookies by default', async () => {
      const h = await upstreamHeaders({ cookie: 'app_session=x; __session=y' });
      expect(h.get('cookie')).toBe('__session=y');
    });

    it('does not forward look-alike cookies from other vendors', async () => {
      const h = await upstreamHeaders({ cookie: '__session_abc=1; __session__0=2; __client_uat=3; __Secure-__session=4; __client=5' });
      expect(h.get('cookie')).toBe('__client=5');
    });

    it('keeps a multi-cookie header well-formed, values with = intact', async () => {
      const h = await upstreamHeaders({ cookie: ' __session=a.b=c ;app_session=x;__atlas_rt=d;; __client=e;' });
      expect(h.get('cookie')).toBe('__session=a.b=c; __atlas_rt=d; __client=e');
    });

    it('sends no Cookie header when no cookie is allowed', async () => {
      expect((await upstreamHeaders({ cookie: 'app_session=x; other=y' })).has('cookie')).toBe(false);
    });

    it('forwardCookies replaces the default', async () => {
      const h = await upstreamHeaders({ cookie: 'app_session=x; __session=y' }, { forwardCookies: (name) => name === 'app_session' });
      expect(h.get('cookie')).toBe('app_session=x');
    });

    it('drops an internal header but keeps what the browser SDK and hosted pages need', async () => {
      const kept: Record<string, string> = {
        accept: 'application/json',
        'accept-language': 'fr',
        'access-control-request-method': 'POST',
        authorization: 'Bearer t',
        'content-type': 'application/json',
        'if-none-match': '"etag"',
        origin: 'https://app.example.com',
        referer: 'https://app.example.com/a',
        'sec-ch-ua-platform': '"macOS"',
        'sec-fetch-dest': 'webidentity',
        'user-agent': 'browser',
        'atlas-attestation': 'att',
        dpop: 'proof',
        'x-atlas-sdk': '@atlasauth/js/1.0.0',
        'x-publishable-key': 'pk_test_x',
        'x-refresh-token': 'rt',
      };
      const h = await upstreamHeaders({ ...kept, 'x-origin-verify': 'internal', 'x-my-app': 'y' });
      for (const [name, value] of Object.entries(kept)) expect(h.get(name)).toBe(value);
      expect(h.get('x-origin-verify')).toBeNull();
      expect(h.get('x-my-app')).toBeNull();
    });

    it('forwardHeaders replaces the default', async () => {
      const h = await upstreamHeaders({ 'x-my-app': 'y', accept: 'text/html' }, { forwardHeaders: (name) => name === 'x-my-app' });
      expect(h.get('x-my-app')).toBe('y');
      expect(h.get('accept')).toBeNull();
    });

    it('forwardHeaders can turn off the Cookie header', async () => {
      const h = await upstreamHeaders({ cookie: '__session=y' }, { forwardHeaders: (name) => name !== 'cookie' && name !== 'accept' });
      expect(h.has('cookie')).toBe(false);
    });

    it('never passes a trusted or hop-by-hop header, even when the hook says yes', async () => {
      const h = await upstreamHeaders(
        {
          'x-atlas-proxy-secret': 'forged',
          'x-atlas-client-ip': '6.6.6.6',
          'x-atlas-forwarded-host': 'evil.test',
          'x-atlas-edge-secret': 'forged',
          'x-atlas-mtls-secret': 'forged',
          'x-forwarded-client-cert': 'forged',
          'x-client-cert': 'forged',
          'ssl-client-cert': 'forged',
          'cf-connecting-ip': '6.6.6.6',
          'true-client-ip': '6.6.6.6',
          'x-real-ip': '6.6.6.6',
          forwarded: 'for=6.6.6.6',
          connection: 'keep-alive',
          'proxy-authorization': 'x',
        },
        { forwardHeaders: () => true, proxySecret: 'aps_secret' },
      );
      expect(h.get('x-atlas-proxy-secret')).toBe('aps_secret');
      expect(h.get('x-atlas-forwarded-host')).toBe('app.example.com');
      expect(h.get('x-atlas-client-ip')).toBeNull();
      for (const name of ['x-atlas-edge-secret', 'x-atlas-mtls-secret', 'x-forwarded-client-cert', 'x-client-cert', 'ssl-client-cert', 'cf-connecting-ip', 'true-client-ip', 'x-real-ip', 'forwarded', 'connection', 'proxy-authorization']) {
        expect(h.get(name)).toBeNull();
      }
    });

    it('a hook can drop X-Atlas-SDK', async () => {
      const h = await upstreamHeaders({ 'x-atlas-sdk': '@atlasauth/js/1.0.0' }, { forwardHeaders: () => false });
      expect(h.get('x-atlas-sdk')).toBeNull();
    });

    it('the client IP does not depend on the header hooks', async () => {
      const h = await upstreamHeaders({ 'x-forwarded-for': '10.0.0.1, 203.0.113.7' }, { forwardHeaders: () => false });
      expect(h.get('x-atlas-client-ip')).toBe('203.0.113.7');
    });
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
