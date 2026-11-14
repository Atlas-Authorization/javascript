import { describe, expect, it, vi } from 'vitest';
import { atlasGrantUsage, atlasRateLimit } from './limits';

const allow = vi.fn(async (_req: unknown) => ({ allowed: true as const, headers: { 'RateLimit-Remaining': '4' } }));
const deny = async () => ({ allowed: false as const, status: 429, headers: { 'Retry-After': '3' }, body: { error: 'slow' } });

function ctx(store: Record<string, unknown> = {}) {
  const set: Record<string, string> = {};
  return {
    set,
    c: {
      req: { header: () => undefined, raw: new Request('https://x.test/', { headers: { 'X-Forwarded-For': '5.6.7.8, 10.0.0.1', Authorization: 'Bearer t' } }) },
      header: (k: string, v: string) => (set[k] = v),
      get: (k: string) => store[k],
      set: () => undefined,
    } as never,
  };
}

describe('hono limits', () => {
  it('calls next, sets headers and passes claims, headers and forwarded ip', async () => {
    const { c, set } = ctx({ atlas: { claims: { sub: 'u1' } } });
    const next = vi.fn(async () => undefined);
    const res = await atlasRateLimit(allow as never)(c, next);
    expect(res).toBeUndefined();
    expect(next).toHaveBeenCalled();
    expect(set).toEqual({ 'RateLimit-Remaining': '4' });
    expect(allow).toHaveBeenLastCalledWith({ claims: { sub: 'u1' }, headers: expect.objectContaining({ authorization: 'Bearer t' }), ip: '5.6.7.8' });
  });

  it('returns a Response for a denial and skips next', async () => {
    const next = vi.fn(async () => undefined);
    const res = (await atlasGrantUsage(deny as never)(ctx().c, next)) as Response;
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3');
    expect(await res.json()).toEqual({ error: 'slow' });
  });
});
