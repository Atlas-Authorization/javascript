import { describe, expect, it } from 'vitest';
import { FapiClient } from './fapi';
import { captcha } from './captcha';

/** A FapiClient wired to a scripted fetch that records the calls it receives. */
function clientFor(
  routes: Record<string, { status?: number; body: unknown }>,
): { client: FapiClient; calls: { path: string; search: string; method: string; body: unknown }[] } {
  const calls: { path: string; search: string; method: string; body: unknown }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ path: url.pathname, search: url.search, method: init?.method ?? 'GET', body });
    const r = routes[url.pathname] ?? { status: 404, body: { errors: [{ code: 'NO_ROUTE', message: 'x' }] } };
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return {
    client: new FapiClient({ publishableKey: 'pk_test', baseUrl: 'https://api.test', fetchImpl }),
    calls,
  };
}

describe('captcha surface', () => {
  it('config() GETs /v1/client/captcha and returns the widget config', async () => {
    const { client, calls } = clientFor({
      '/v1/client/captcha': {
        body: {
          object: 'captcha_config',
          action: null,
          provider: 'turnstile',
          site_key: 'ts-site',
          widget_mode: 'managed',
          enabled: true,
        },
      },
    });
    const cfg = await captcha(client).config();
    expect(cfg?.provider).toBe('turnstile');
    expect(cfg?.site_key).toBe('ts-site');
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.path).toBe('/v1/client/captcha');
    expect(calls[0]!.search).toBe('');
  });

  it('config(action) passes the action as a query param', async () => {
    const { client, calls } = clientFor({
      '/v1/client/captcha': {
        body: { object: 'captcha_config', action: 'comment.create', provider: 'hcaptcha', site_key: 'hc', widget_mode: 'managed', enabled: true },
      },
    });
    const cfg = await captcha(client).config('comment.create');
    expect(cfg?.action).toBe('comment.create');
    expect(calls[0]!.search).toBe('?action=comment.create');
  });

  it('verify() POSTs the token (and action) to /v1/client/captcha/verify', async () => {
    const { client, calls } = clientFor({
      '/v1/client/captcha/verify': {
        body: { object: 'captcha_verification', success: true, action: 'comment.create', provider: 'hcaptcha', score: 0.9 },
      },
    });
    const result = await captcha(client).verify('tok-123', 'comment.create');
    expect(result?.success).toBe(true);
    expect(result?.score).toBe(0.9);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.path).toBe('/v1/client/captcha/verify');
    expect(calls[0]!.body).toEqual({ token: 'tok-123', action: 'comment.create' });
  });

  it('verify() omits action when none is given', async () => {
    const { client, calls } = clientFor({
      '/v1/client/captcha/verify': { body: { object: 'captcha_verification', success: false, action: null, provider: 'turnstile' } },
    });
    const result = await captcha(client).verify('tok');
    expect(result?.success).toBe(false);
    expect(calls[0]!.body).toEqual({ token: 'tok' });
  });

  it('config() returns null on an error response', async () => {
    const { client } = clientFor({ '/v1/client/captcha': { status: 500, body: { errors: [{ code: 'X', message: 'y' }] } } });
    expect(await captcha(client).config()).toBeNull();
  });

  it('protect() refuses when the resolved provider is not renderable', async () => {
    const { client } = clientFor({
      '/v1/client/captcha': { body: { object: 'captcha_config', action: null, provider: 'none', site_key: null, widget_mode: 'managed', enabled: false } },
    });
    const element = {} as unknown as HTMLElement;
    await expect(captcha(client).protect(element)).rejects.toThrow(/no renderable captcha provider/i);
  });
});
