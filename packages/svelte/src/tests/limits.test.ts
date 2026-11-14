import { describe, expect, it, vi } from 'vitest';
import { atlasGrantUsage, atlasRateLimit } from '../lib/limits';

const allow = vi.fn(async (_req: unknown) => ({ allowed: true as const, headers: { 'RateLimit-Remaining': '4' } }));
const deny = async () => ({ allowed: false as const, status: 403, body: { error: 'usage' } });
const event = (auth?: unknown) => ({ request: new Request('https://x.test/', { headers: { a: 'b' } }), locals: { auth } as never, getClientAddress: () => '5.5.5.5' });

describe('svelte limit hooks', () => {
  it('resolves and adds headers when allowed', async () => {
    const res = await atlasRateLimit(allow as never)({ event: event({ claims: { sub: 'u' } }), resolve: async () => new Response('ok') });
    expect(res.headers.get('RateLimit-Remaining')).toBe('4');
    expect(allow).toHaveBeenLastCalledWith({ claims: { sub: 'u' }, headers: { a: 'b' }, ip: '5.5.5.5' });
  });

  it('answers a denial without resolving', async () => {
    const resolve = vi.fn(async () => new Response('ok'));
    const res = await atlasGrantUsage(deny as never)({ event: event(), resolve });
    expect(resolve).not.toHaveBeenCalled();
    expect(res.status).toBe(403);
  });
});
