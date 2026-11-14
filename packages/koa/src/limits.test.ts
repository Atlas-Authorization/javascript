import { describe, expect, it, vi } from 'vitest';
import { atlasGrantUsage, atlasRateLimit } from './limits';

const allow = vi.fn(async (_req: unknown) => ({ allowed: true as const, headers: { 'RateLimit-Remaining': '4' } }));
const deny = async () => ({ allowed: false as const, status: 429, headers: { 'Retry-After': '3' }, body: { error: 'slow' } });
const mk = (state: Record<string, unknown> = {}) => {
  const headers: Record<string, string> = {};
  return { headers, ctx: { headers: { Host: 'x' }, state, status: 404, body: null, ip: '1.1.1.1', set: (h: Record<string, string>) => Object.assign(headers, h) } as never };
};

describe('koa limits', () => {
  it('continues and sets headers when allowed', async () => {
    const { ctx, headers } = mk({ atlas: { claims: { sub: 'u' } } });
    const next = vi.fn(async () => undefined);
    await atlasRateLimit(allow as never)(ctx, next);
    expect(next).toHaveBeenCalled();
    expect(headers).toEqual({ 'RateLimit-Remaining': '4' });
    expect(allow).toHaveBeenLastCalledWith({ claims: { sub: 'u' }, headers: { host: 'x' }, ip: '1.1.1.1' });
  });

  it('sets status and body on denial and does not call next', async () => {
    const { ctx } = mk();
    const next = vi.fn(async () => undefined);
    await atlasGrantUsage(deny as never)(ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect((ctx as { status: number }).status).toBe(429);
    expect((ctx as { body: unknown }).body).toEqual({ error: 'slow' });
  });
});
