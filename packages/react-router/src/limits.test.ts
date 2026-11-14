import { describe, expect, it, vi } from 'vitest';
import { atlasGrantUsage, atlasRateLimit, atlasRequireFeature } from './limits';

const allow = vi.fn(async (_req: unknown) => ({ allowed: true as const, headers: { 'RateLimit-Remaining': '4' } }));
const deny = async () => ({ allowed: false as const, status: 429, headers: { 'Retry-After': '3' }, body: { error: 'slow' } });
const args = { request: new Request('https://x.test/', { headers: { 'x-forwarded-for': '6.6.6.6' } }) };

describe('loader limits', () => {
  it('returns the headers to merge when allowed', async () => {
    expect(await atlasRateLimit(allow as never)(args)).toEqual({ 'RateLimit-Remaining': '4' });
    expect(allow).toHaveBeenLastCalledWith({ claims: null, headers: expect.any(Object), ip: '6.6.6.6' });
  });

  it('throws a Response on a denial', async () => {
    const thrown = await atlasGrantUsage(deny as never, { claims: () => ({ sub: 'm' }) })(args).catch((e) => e);
    expect(thrown).toBeInstanceOf(Response);
    expect(thrown.status).toBe(429);
    expect(thrown.headers.get('retry-after')).toBe('3');
    expect(await thrown.json()).toEqual({ error: 'slow' });
  });
});

describe('feature guard', () => {
  it('returns normally when entitled', async () => {
    expect(await atlasRequireFeature(allow as never, { claims: () => ({ sub: 'u' }) })(args)).toEqual({ 'RateLimit-Remaining': '4' });
  });
  it('throws a 403 Response with the feature_not_entitled body when not', async () => {
    const no = async () => ({ allowed: false as const, status: 403, headers: {}, body: { error: { code: 'feature_not_entitled' } } });
    const thrown = await atlasRequireFeature(no as never, { claims: () => ({ sub: 'u' }) })(args).catch((e) => e);
    expect(thrown).toBeInstanceOf(Response);
    expect(thrown.status).toBe(403);
    expect(await thrown.json()).toEqual({ error: { code: 'feature_not_entitled' } });
  });
});
