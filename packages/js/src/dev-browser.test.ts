// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { devBrowserToken, forgetDevBrowserToken, resetSharedExchanges, setPersistence, withDevBrowser } from './dev-browser';

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
  resetSharedExchanges();
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
    await prod(`${BASE}/v1/client/tickets/exchange`, { method: 'POST', body: '{}' });
    expect(f.seen[0]!.body).toEqual({});
    expect(devBrowserToken(PROD)).toBeNull();

    const once = withDevBrowser(DEV, f.impl);
    expect(withDevBrowser(DEV, once)).toBe(once);
  });
});

describe('persistence modes', () => {
  const exchange = () =>
    fakeFetch(() => ({ status: 200, body: { object: 'session', id: 'sess_1', jwt: 'j', refresh_token: 'rt_p' } }));
  const run = async () => {
    await withDevBrowser(DEV, exchange().impl)(`${BASE}/v1/client/tickets/exchange`, {
      method: 'POST',
      body: JSON.stringify({ attempt_id: 'a', ticket: 't' }),
    });
  };
  afterEach(() => {
    resetSharedExchanges();
    setPersistence(undefined);
    localStorage.clear();
    sessionStorage.clear();
  });

  it('local (default) writes localStorage only', async () => {
    await run();
    expect(localStorage.length).toBeGreaterThan(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('session writes sessionStorage only', async () => {
    setPersistence('session');
    await run();
    expect(sessionStorage.length).toBeGreaterThan(0);
    expect(localStorage.length).toBe(0);
    expect(devBrowserToken(DEV)).toBe('rt_p');
  });

  it('memory writes nothing to the browser but still presents the token', async () => {
    setPersistence('memory');
    await run();
    expect(localStorage.length + sessionStorage.length).toBe(0);
    expect(devBrowserToken(DEV)).toBe('rt_p');
    forgetDevBrowserToken(DEV);
    expect(devBrowserToken(DEV)).toBeNull();
  });
});

describe('one ticket exchange per ticket (StrictMode double effects)', () => {
  const body = JSON.stringify({ attempt_id: 'sia_dup', ticket: 'tkt_dup' });

  for (const key of [DEV, PROD]) {
    it(`two exchanges of the same ticket send one request and both succeed (${key.slice(0, 7)})`, async () => {
      const f = fakeFetch(() => ({ status: 200, body: { object: 'session', id: 'sess_1', jwt: 'j' } }));
      const doFetch = withDevBrowser(key, f.impl);
      const url = `${BASE}/v1/client/tickets/exchange`;
      const [a, b] = await Promise.all([doFetch(url, { method: 'POST', body }), doFetch(url, { method: 'POST', body })]);
      expect(f.seen.filter((s) => s.url.endsWith('/tickets/exchange'))).toHaveLength(1);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      // Each caller reads its own body.
      expect((await a.json()).id).toBe('sess_1');
      expect((await b.json()).id).toBe('sess_1');
      // A remount right after the first finished still reuses it.
      const c = await doFetch(url, { method: 'POST', body });
      expect((await c.json()).id).toBe('sess_1');
      expect(f.seen.filter((s) => s.url.endsWith('/tickets/exchange'))).toHaveLength(1);
    });
  }

  it('a re-wrap of the same fetch shares; a different fetch (another client, a fresh test mock) never does', async () => {
    const ok = () => fakeFetch(() => ({ status: 200, body: { object: 'session', id: 'sess_1', jwt: 'j' } }));
    const url = `${BASE}/v1/client/tickets/exchange`;
    const f = ok();
    await withDevBrowser(PROD, f.impl)(url, { method: 'POST', body });
    await withDevBrowser(PROD, f.impl)(url, { method: 'POST', body });
    expect(f.seen).toHaveLength(1);
    const g = ok();
    await withDevBrowser(PROD, g.impl)(url, { method: 'POST', body });
    expect(g.seen).toHaveLength(1);
  });

  it('a different ticket is its own request, and a failed exchange is not reused', async () => {
    let status = 400;
    const f = fakeFetch(() => ({ status, body: { errors: [{ code: 'VERIFICATION_EXPIRED' }] } }));
    const doFetch = withDevBrowser(PROD, f.impl);
    const url = `${BASE}/v1/client/tickets/exchange`;
    expect((await doFetch(url, { method: 'POST', body })).status).toBe(400);
    status = 200;
    expect((await doFetch(url, { method: 'POST', body })).status).toBe(200);
    await doFetch(url, { method: 'POST', body: JSON.stringify({ attempt_id: 'sia_other', ticket: 'tkt_other' }) });
    expect(f.seen).toHaveLength(3);
  });
});
