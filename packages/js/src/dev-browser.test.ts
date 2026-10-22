// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { devBrowserToken, forgetDevBrowserToken, withDevBrowser } from './dev-browser';

/**
 * The dev browser: a development instance's session survives on localhost
 * where the browser blocks the instance's cookie as third-party.
 */

const DEV = 'pk_test_devbrowser';
const PROD = 'pk_live_devbrowser';
const BASE = 'https://fapi.example';

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function fakeFetch(answer: (url: string, method: string) => { status: number; body: unknown }) {
  const seen: Seen[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    seen.push({ url, method, headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    const a = answer(new URL(url).pathname, method);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { impl, seen };
}

afterEach(() => {
  forgetDevBrowserToken(DEV);
  forgetDevBrowserToken(PROD);
});

describe('withDevBrowser', () => {
  it('keeps the refresh token from the ticket exchange, presents it on boot and refresh, and keeps the rotated one', async () => {
    const f = fakeFetch((path) => {
      if (path === '/v1/client/tickets/exchange') return { status: 200, body: { object: 'session', id: 'sess_1', jwt: 'j', refresh_token: 'rt_1' } };
      if (path === '/v1/client/sessions/sess_1/tokens') return { status: 200, body: { jwt: 'j2', session_id: 'sess_1', refresh_token: 'rt_2' } };
      return { status: 200, body: { session: { id: 'sess_1' }, user: { id: 'user_1' } } };
    });
    const doFetch = withDevBrowser(DEV, f.impl);
    await doFetch(`${BASE}/v1/client/tickets/exchange`, { method: 'POST', body: JSON.stringify({ attempt_id: 'sia_1', ticket: 't' }) });
    expect(f.seen[0]!.body).toEqual({ attempt_id: 'sia_1', ticket: 't', return_refresh_token: true });
    expect(devBrowserToken(DEV)).toBe('rt_1');

    await doFetch(`${BASE}/v1/client`);
    expect(f.seen[1]!.headers.get('x-refresh-token')).toBe('rt_1');

    await doFetch(`${BASE}/v1/client/sessions/sess_1/tokens`, { method: 'POST' });
    expect(f.seen[2]!.headers.get('x-refresh-token')).toBe('rt_1');
    expect(devBrowserToken(DEV)).toBe('rt_2');

    // Other requests carry nothing extra.
    await doFetch(`${BASE}/v1/client/sign_ins`, { method: 'POST', body: '{}' });
    expect(f.seen[3]!.headers.get('x-refresh-token')).toBeNull();
  });

  it('forgets the token when the boot finds no session, a refresh is refused, or this session signs out', async () => {
    let boot: unknown = { session: null, user: null };
    let refreshStatus = 401;
    const f = fakeFetch((path) => {
      if (path === '/v1/client/tickets/exchange') return { status: 200, body: { id: 'sess_1', jwt: 'j', refresh_token: 'rt_1' } };
      if (path.endsWith('/tokens')) return { status: refreshStatus, body: {} };
      if (path.endsWith('/revoke')) return { status: 200, body: {} };
      return { status: 200, body: boot };
    });
    const doFetch = withDevBrowser(DEV, f.impl);
    const signIn = () => doFetch(`${BASE}/v1/client/tickets/exchange`, { method: 'POST', body: '{}' });

    await signIn();
    await doFetch(`${BASE}/v1/client`);
    expect(devBrowserToken(DEV)).toBeNull();

    await signIn();
    await doFetch(`${BASE}/v1/client/sessions/sess_1/tokens`, { method: 'POST' });
    expect(devBrowserToken(DEV)).toBeNull();

    // Revoking another device keeps this browser signed in; revoking our own forgets it.
    refreshStatus = 200;
    boot = { session: { id: 'sess_1' } };
    await signIn();
    await doFetch(`${BASE}/v1/client/sessions/sess_other/revoke`, { method: 'POST' });
    expect(devBrowserToken(DEV)).toBe('rt_1');
    await doFetch(`${BASE}/v1/client/sessions/sess_1/revoke`, { method: 'POST' });
    expect(devBrowserToken(DEV)).toBeNull();
  });

  it('does nothing for a production key, and wraps a fetch only once', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { id: 'sess_1', refresh_token: 'rt_live' } }));
    const prod = withDevBrowser(PROD, f.impl);
    expect(prod).toBe(f.impl);
    await prod(`${BASE}/v1/client/tickets/exchange`, { method: 'POST', body: '{}' });
    expect(f.seen[0]!.body).toEqual({});
    expect(devBrowserToken(PROD)).toBeNull();

    const once = withDevBrowser(DEV, f.impl);
    expect(withDevBrowser(DEV, once)).toBe(once);
  });
});
