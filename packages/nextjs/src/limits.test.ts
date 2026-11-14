import { describe, expect, it, vi } from 'vitest';
import { atlasGrantUsageMiddleware, atlasRateLimitMiddleware, withGrantUsage, withRateLimit } from './limits';

const allow = vi.fn(async (_req: unknown) => ({ allowed: true as const, headers: { 'RateLimit-Remaining': '4' } }));
const deny = async () => ({ allowed: false as const, status: 429, headers: { 'Retry-After': '3' }, body: { error: 'slow' } });
const req = () => new Request('https://x.test/api', { headers: { 'x-forwarded-for': '8.8.8.8', authorization: 'Bearer t' } });

describe('next limits', () => {
  it('wraps a route handler and adds the headers', async () => {
    const handler = vi.fn(async () => new Response('ok'));
    const res = await withRateLimit(allow as never, handler)(req());
    expect(await res.text()).toBe('ok');
    expect(res.headers.get('RateLimit-Remaining')).toBe('4');
    expect(allow).toHaveBeenLastCalledWith({ claims: null, headers: expect.objectContaining({ authorization: 'Bearer t' }), ip: '8.8.8.8' });
  });

  it('does not run the handler on a denial', async () => {
    const handler = vi.fn(async () => new Response('ok'));
    const res = await withGrantUsage(deny as never, handler, { claims: () => ({ sub: 'm' }) })(req());
    expect(handler).not.toHaveBeenCalled();
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3');
    expect(await res.json()).toEqual({ error: 'slow' });
  });

  it('middleware helpers return undefined to continue, a Response to stop', async () => {
    expect(await atlasRateLimitMiddleware(allow as never)(req())).toBeUndefined();
    expect((await atlasGrantUsageMiddleware(deny as never, { claims: () => ({}) })(req()))?.status).toBe(429);
  });
});
