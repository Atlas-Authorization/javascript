import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { atlasRevocationFeed, atlasVerifier, identityHeaders, isPublicPath, readCredential, startAuthProxy, type ProxyIdentity, type ProxyVerifier } from './proxy';

let upstream: Server | undefined;
let closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers) await c();
  closers = [];
  await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
  upstream = undefined;
});

/** An app that echoes the path and the headers it was given. */
async function app(): Promise<{ url: string; seen: Array<{ path: string; headers: IncomingHttpHeaders }> }> {
  const seen: Array<{ path: string; headers: IncomingHttpHeaders }> = [];
  upstream = createServer((req, res) => {
    seen.push({ path: req.url ?? '', headers: req.headers });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('hello');
  });
  await new Promise<void>((r) => upstream!.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(upstream!.address() as AddressInfo).port}`, seen };
}

const USER: ProxyIdentity = { method: 'session', userId: 'user_1', sessionId: 'sess_1', organizationId: 'org_1', organizationRole: 'org:admin' };

async function proxyFor(verify: ProxyVerifier, extra: Partial<Parameters<typeof startAuthProxy>[0]> = {}) {
  const a = await app();
  const p = await startAuthProxy({ target: a.url, verify, ...extra });
  closers.push(p.close);
  return { ...a, proxy: p };
}

describe('atlas proxy: credential handling', () => {
  it('reads a bearer token, then the session cookie, never a query string', () => {
    expect(readCredential({ authorization: 'Bearer abc.def.ghi' }, false)).toEqual({ kind: 'session', token: 'abc.def.ghi' });
    expect(readCredential({ cookie: 'a=1; __session=tok%2E1; b=2' }, false)).toEqual({ kind: 'session', token: 'tok.1' });
    expect(readCredential({ authorization: 'Bearer ak_live_x' }, true)).toEqual({ kind: 'api_key', token: 'ak_live_x' });
    expect(readCredential({ authorization: 'Bearer ak_live_x' }, false)?.kind).toBe('session');
    expect(readCredential({}, true)).toBeUndefined();
    expect(readCredential({ authorization: 'Basic abc' }, true)).toBeUndefined();
  });

  it('matches public paths on a segment boundary', () => {
    expect(isPublicPath('/health', ['/health'])).toBe(true);
    expect(isPublicPath('/health/live', ['/health'])).toBe(true);
    expect(isPublicPath('/healthz', ['/health'])).toBe(false);
    expect(isPublicPath('/static/app.js', ['/static/'])).toBe(true);
  });

  it('refuses identity values that could split a header', () => {
    expect(() => identityHeaders({ method: 'session', userId: 'a\r\nx-atlas-user-id: evil' })).toThrow();
    expect(identityHeaders(USER)).toMatchObject({ 'x-atlas-user-id': 'user_1', 'x-atlas-org-role': 'org:admin' });
  });
});

describe('atlas proxy: forwarding', () => {
  it('refuses a request with no credential and never reaches the app', async () => {
    const { proxy, seen } = await proxyFor(async () => USER);
    const res = await fetch(`${proxy.url}/private`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(seen).toHaveLength(0);
  });

  it('refuses an invalid credential, and fails closed (503) when Atlas cannot answer', async () => {
    const bad = await proxyFor(async () => null);
    expect((await fetch(`${bad.proxy.url}/x`, { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    expect(bad.seen).toHaveLength(0);
    const down = await proxyFor(async () => { throw new Error('HTTP 502'); });
    expect((await fetch(`${down.proxy.url}/x`, { headers: { authorization: 'Bearer t' } })).status).toBe(503);
    expect(down.seen).toHaveLength(0);
  });

  it('forwards a valid session with identity headers, and strips any x-atlas-* header the client sent', async () => {
    const { proxy, seen } = await proxyFor(async () => USER);
    const res = await fetch(`${proxy.url}/orders?x=1`, { headers: { authorization: 'Bearer good', 'x-atlas-user-id': 'user_admin', 'x-atlas-org-id': 'forged' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
    expect(seen[0]!.path).toBe('/orders?x=1');
    expect(seen[0]!.headers['x-atlas-user-id']).toBe('user_1');
    expect(seen[0]!.headers['x-atlas-org-id']).toBe('org_1');
    expect(seen[0]!.headers['x-atlas-auth-method']).toBe('session');
    expect(seen[0]!.headers.authorization).toBe('Bearer good');
  });

  it('lets a public path through with no credential, still stripping forged identity headers', async () => {
    const { proxy, seen } = await proxyFor(async () => null, { publicPaths: ['/health'] });
    const res = await fetch(`${proxy.url}/health`, { headers: { 'x-atlas-user-id': 'forged' } });
    expect(res.status).toBe(200);
    expect(seen[0]!.headers['x-atlas-user-id']).toBeUndefined();
  });

  it('can hide the credentials from the app', async () => {
    const { proxy, seen } = await proxyFor(async () => USER, { stripCredentials: true });
    await fetch(`${proxy.url}/`, { headers: { cookie: '__session=tok; theme=dark' } });
    expect(seen[0]!.headers.cookie).toBe('theme=dark');
    await fetch(`${proxy.url}/`, { headers: { authorization: 'Bearer good' } });
    expect(seen[1]!.headers.authorization).toBeUndefined();
  });

  it('caches a positive answer for the TTL, then asks again; 0 turns the cache off', async () => {
    let calls = 0;
    let clock = 1_000;
    const verify: ProxyVerifier = async () => { calls++; return USER; };
    const { proxy } = await proxyFor(verify, { cacheSeconds: 10, now: () => clock });
    const get = () => fetch(`${proxy.url}/`, { headers: { authorization: 'Bearer same' } });
    await get(); await get();
    expect(calls).toBe(1);
    clock += 11_000;
    await get();
    expect(calls).toBe(2);
    const off = await proxyFor(verify, { cacheSeconds: 0 });
    calls = 0;
    await fetch(`${off.proxy.url}/`, { headers: { authorization: 'Bearer same' } });
    await fetch(`${off.proxy.url}/`, { headers: { authorization: 'Bearer same' } });
    expect(calls).toBe(2);
  });

  it('answers 502 when the app is down', async () => {
    const p = await startAuthProxy({ target: 'http://127.0.0.1:1', verify: async () => USER });
    closers.push(p.close);
    expect((await fetch(`${p.url}/`, { headers: { authorization: 'Bearer t' } })).status).toBe(502);
  });
});

describe('atlas proxy: session revocation feed', () => {
  it('drops a cached session as soon as the feed lists it, without waiting for the cache TTL', async () => {
    let verifies = 0;
    const listed: string[] = [];
    const cursors: Array<string | undefined> = [];
    const feed = async (cursor: string | undefined) => {
      cursors.push(cursor);
      return { data: listed.splice(0).map((sid) => ({ sid })), has_more: false, next_after: '1:cursor' };
    };
    const { proxy, seen } = await proxyFor(async () => { verifies++; return USER; }, { cacheSeconds: 300, revocations: feed, revocationIntervalMs: 3_600_000 });
    const get = () => fetch(`${proxy.url}/`, { headers: { authorization: 'Bearer same' } });
    expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(200);
    expect(verifies).toBe(1);
    listed.push('sess_1');
    expect(await proxy.pollRevocations()).toBe(true);
    expect((await get()).status).toBe(401);
    expect(seen).toHaveLength(2);
    // Even a fresh verify that returns the revoked session is refused, and the cursor moved on.
    expect((await fetch(`${proxy.url}/`, { headers: { authorization: 'Bearer other' } })).status).toBe(401);
    expect(cursors.slice(-1)[0]).toBe('1:cursor');
  });

  it('keeps working on the cache TTL when the feed cannot be read', async () => {
    const feed = async () => { throw new Error('HTTP 503'); };
    const { proxy } = await proxyFor(async () => USER, { cacheSeconds: 300, revocations: feed, revocationIntervalMs: 3_600_000 });
    expect(await proxy.pollRevocations()).toBe(false);
    expect((await fetch(`${proxy.url}/`, { headers: { authorization: 'Bearer t' } })).status).toBe(200);
  });

  it('reads the Backend API feed with the secret key and the cursor', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ data: [{ sid: 'sess_9' }], has_more: false, next_after: '5:sess_9' }), { status: 200 }));
    const page = await atlasRevocationFeed('https://api.example.com', 'sk_test', f as unknown as typeof fetch)('5:sess_8');
    expect(page.data[0]!.sid).toBe('sess_9');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/sessions/revocations?limit=1000&after=5%3Asess_8');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk_test');
    await expect(atlasRevocationFeed('https://api.example.com', 'sk', (async () => new Response('', { status: 500 })) as unknown as typeof fetch)(undefined)).rejects.toThrow();
  });
});

describe('atlas proxy: the Atlas verifier', () => {
  const reply = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('maps a verified session and an API key to identities, and invalid ones to null', async () => {
    const session = atlasVerifier('https://api.example.com', 'sk_test', reply({ verified: true, user_id: 'u', session_id: 's', organization_id: 'o', organization_role: 'r' }));
    expect(await session({ kind: 'session', token: 't' })).toMatchObject({ method: 'session', userId: 'u', organizationId: 'o' });
    expect(await atlasVerifier('https://api.example.com', 'sk', reply({ verified: false }))({ kind: 'session', token: 't' })).toBeNull();
    const key = atlasVerifier('https://api.example.com', 'sk', reply({ valid: true, id: 'key_1', subject_type: 'user', subject_id: 'u', effective_scopes: ['read'], expires_at: 5 }));
    expect(await key({ kind: 'api_key', token: 'ak_x' })).toMatchObject({ method: 'api_key', keyId: 'key_1', userId: 'u', scopes: ['read'], expiresAt: 5 });
    expect(await atlasVerifier('https://api.example.com', 'sk', reply({ valid: false }))({ kind: 'api_key', token: 'ak_x' })).toBeNull();
  });

  it('throws (so the proxy fails closed) on an outage, and explains a refused secret key', async () => {
    await expect(atlasVerifier('https://api.example.com', 'sk', reply({}, 503))({ kind: 'session', token: 't' })).rejects.toThrow(/503/);
    await expect(atlasVerifier('https://api.example.com', 'sk', reply({}, 403))({ kind: 'session', token: 't' })).rejects.toThrow(/sessions:read/);
  });
});
