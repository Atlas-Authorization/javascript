import { describe, expect, it, vi } from 'vitest';
import { atlasGrantUsage, atlasRateLimit } from './limits';

const allow = vi.fn(async (_req: unknown) => ({ allowed: true as const, headers: { 'RateLimit-Remaining': '4' } }));
const deny = async () => ({ allowed: false as const, status: 403, body: { error: 'usage' } });
const context = (atlas?: unknown) => ({ request: new Request('https://x.test/', { headers: { a: 'b' } }), locals: { atlas }, clientAddress: '4.4.4.4' }) as never;

describe('astro limits', () => {
  it('uses locals.atlas claims, calls next and sets headers on the response', async () => {
    const res = await atlasRateLimit(allow as never)(context({ claims: { sub: 'u' }, userId: 'u', has: () => true }), async () => new Response('ok'));
    expect(res.headers.get('RateLimit-Remaining')).toBe('4');
    expect(allow).toHaveBeenLastCalledWith({ claims: { sub: 'u' }, headers: { a: 'b' }, ip: '4.4.4.4' });
  });

  it('answers a denial without calling next', async () => {
    const next = vi.fn(async () => new Response('ok'));
    const res = await atlasGrantUsage(deny as never)(context(), next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(403);
  });
});
