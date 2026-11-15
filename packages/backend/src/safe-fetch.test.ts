import { describe, expect, it } from 'vitest';
import { safeFetch, SafeFetchError } from './web-bot-auth';

const ok = () => Promise.resolve(new Response('{}', { status: 200 }));
const resolveTo = (map: Record<string, string[]>) => async (h: string) => map[h] ?? ['93.184.216.34'];

describe('safeFetch', () => {
  it.each([
    ['10.x', 'https://10.1.2.3/d'],
    ['127.x', 'https://127.0.0.1/d'],
    ['169.254.x', 'https://169.254.169.254/latest'],
    ['::1', 'https://[::1]/d'],
    ['IPv4-mapped IPv6', 'https://[::ffff:127.0.0.1]/d'],
    ['CGNAT', 'https://100.64.0.1/d'],
    ['unique-local', 'https://[fd00::1]/d'],
    ['unspecified', 'https://0.0.0.0/d'],
  ])('refuses %s literal', async (_n, url) => {
    await expect(safeFetch(url)).rejects.toMatchObject({ code: 'ssrf_refused' });
  });

  it('refuses a hostname that resolves to a private address', async () => {
    await expect(safeFetch('https://bot.example.com/d', {}, { resolve: resolveTo({ 'bot.example.com': ['10.0.0.5'] }) })).rejects.toBeInstanceOf(SafeFetchError);
  });

  it('refuses when any resolved address is private', async () => {
    await expect(safeFetch('https://bot.example.com/d', {}, { fetch: ok, resolve: resolveTo({ 'bot.example.com': ['93.184.216.34', '127.0.0.1'] }) })).rejects.toMatchObject({ code: 'ssrf_refused' });
  });

  it('refuses http unless allowed, and plain-http private hosts either way', async () => {
    await expect(safeFetch('http://example.com/d', {}, { fetch: ok })).rejects.toMatchObject({ code: 'ssrf_refused' });
    await expect(safeFetch('http://127.0.0.1/d', {}, { fetch: ok, allowHttp: true })).rejects.toMatchObject({ code: 'ssrf_refused' });
  });

  it('calls a supplied fetch only after the guard passes', async () => {
    let calls = 0;
    const f = (() => (calls++, ok())) as typeof fetch;
    await expect(safeFetch('https://127.0.0.1/d', {}, { fetch: f })).rejects.toBeInstanceOf(SafeFetchError);
    expect(calls).toBe(0);
    const res = await safeFetch('https://example.com/d', {}, { fetch: f, resolve: resolveTo({}) });
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });

  it('re-checks a redirect to a private host', async () => {
    const f = (() => Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest' } }))) as typeof fetch;
    await expect(safeFetch('https://example.com/d', {}, { fetch: f, resolve: resolveTo({}) })).rejects.toMatchObject({ code: 'ssrf_refused' });
  });

  it('follows a public redirect and caps hops', async () => {
    let n = 0;
    const f = (() => Promise.resolve(++n === 1 ? new Response(null, { status: 301, headers: { location: '/next' } }) : new Response('x'))) as typeof fetch;
    expect((await safeFetch('https://example.com/d', {}, { fetch: f, resolve: resolveTo({}) })).status).toBe(200);
    const loop = (() => Promise.resolve(new Response(null, { status: 302, headers: { location: '/again' } }))) as typeof fetch;
    await expect(safeFetch('https://example.com/d', {}, { fetch: loop, resolve: resolveTo({}), maxRedirects: 2 })).rejects.toMatchObject({ reason: 'too_many_redirects' });
  });
});
