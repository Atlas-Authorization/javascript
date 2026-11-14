import { describe, expect, it, vi } from 'vitest';

const state = { headers: {} as Record<string, string>, status: 200 };
vi.mock('h3', () => ({
  getRequestHeaders: () => ({ a: 'b' }),
  getRequestIP: () => '3.3.3.3',
  setResponseHeaders: (_e: unknown, h: Record<string, string>) => Object.assign(state.headers, h),
  setResponseStatus: (_e: unknown, s: number) => (state.status = s),
}));
vi.mock('./runtime/server/index', () => ({ getAtlasAuth: async () => ({ claims: { sub: 'u' } }) }));

const allow = vi.fn(async (_req: unknown) => ({ allowed: true as const, headers: { 'RateLimit-Remaining': '4' } }));
const deny = async () => ({ allowed: false as const, status: 429, headers: { 'Retry-After': '3' }, body: { error: 'slow' } });

describe('nitro limit handlers', () => {
  it('returns nothing and sets headers when allowed', async () => {
    const { atlasRateLimit } = await import('./runtime/server/limits');
    expect(await atlasRateLimit(allow as never)({} as never)).toBeUndefined();
    expect(state.headers).toEqual({ 'RateLimit-Remaining': '4' });
    expect(allow).toHaveBeenLastCalledWith({ claims: { sub: 'u' }, headers: { a: 'b' }, ip: '3.3.3.3' });
  });

  it('sets the status and returns the body on denial', async () => {
    const { atlasGrantUsage } = await import('./runtime/server/limits');
    expect(await atlasGrantUsage(deny as never)({} as never)).toEqual({ error: 'slow' });
    expect(state.status).toBe(429);
  });
});
