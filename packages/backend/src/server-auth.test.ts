import { describe, expect, it } from 'vitest';
import { createServerCsrfGate, fetchPublicInitialState } from './server-auth';
import { CSRF_COOKIE } from './csrf';

const h = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });
const gate = createServerCsrfGate({ secret: 'x'.repeat(32) });

describe('server csrf gate', () => {
  it('skips signed-out, bearer and mount requests', async () => {
    expect((await gate({ method: 'POST', path: '/a', headers: h({}), sessionId: null })).action).toBe('skip');
    expect((await gate({ method: 'POST', path: '/a', headers: h({ authorization: 'Bearer t' }), sessionId: 's' })).action).toBe('skip');
    expect((await gate({ method: 'POST', path: '/atlas/v1/x', headers: h({}), sessionId: 's' })).action).toBe('skip');
  });
  it('refuses unsafe cookie requests without a token, allows with the echoed one', async () => {
    const get = await gate({ method: 'GET', path: '/a', headers: h({}), sessionId: 's' });
    expect(get.action).toBe('allow');
    const token = (get as { token: string }).token;
    expect((await gate({ method: 'POST', path: '/a', headers: h({}), sessionId: 's' })).action).toBe('refuse');
    const withToken = (sessionId: string) =>
      gate({ method: 'POST', path: '/a', headers: h({ cookie: `${CSRF_COOKIE}=${token}`, 'x-atlas-csrf': token }), sessionId });
    expect((await withToken('s')).action).toBe('allow');
    expect((await withToken('other')).action).toBe('refuse');
  });
});

describe('fetchPublicInitialState', () => {
  it('returns what it can and caches', async () => {
    let calls = 0;
    const fetchImpl = (async (url: string) => {
      calls++;
      return url.endsWith('/v1/appearance') ? new Response('{"a":1}') : new Response('no', { status: 500 });
    }) as unknown as typeof fetch;
    const o = { publishableKey: 'pk', frontendApi: 'https://t.example/', fetchImpl };
    expect(await fetchPublicInitialState(o)).toEqual({ appearance: { a: 1 } });
    await fetchPublicInitialState(o);
    expect(calls).toBe(3);
  });
});
