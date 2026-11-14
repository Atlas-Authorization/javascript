import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AtlasGrantUsageGuard, AtlasLimitsModule, AtlasRateLimitGuard, ATLAS_GRANT_USAGE, ATLAS_RATE_LIMIT } from './limits';
import { grantUsageGate, rateLimitGate } from './limits';

const allow = vi.fn(async (_req: unknown) => ({ allowed: true as const, headers: { 'RateLimit-Remaining': '4' } }));
const deny = async () => ({ allowed: false as const, status: 429, headers: { 'Retry-After': '3' }, body: { error: 'slow' } });

function context(request: Record<string, unknown>) {
  const headers: Record<string, string> = {};
  return { headers, ctx: { switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ setHeader: (k: string, v: string) => (headers[k] = v) }) }) } as never };
}

describe('nest limit guards', () => {
  it('allows, sets headers and reads the token claims', async () => {
    const { ctx, headers } = context({ headers: { a: 'b' }, ip: '3.3.3.3', atlas: { claims: { sub: 'u' } } });
    expect(await new AtlasRateLimitGuard(rateLimitGate(allow as never)).canActivate(ctx)).toBe(true);
    expect(headers).toEqual({ 'RateLimit-Remaining': '4' });
    expect(allow).toHaveBeenLastCalledWith({ claims: { sub: 'u' }, headers: { a: 'b' }, ip: '3.3.3.3' });
  });

  it('throws an HttpException with the denial status and body', async () => {
    const { ctx, headers } = context({ headers: {} });
    const err = await new AtlasGrantUsageGuard(grantUsageGate(deny as never)).canActivate(ctx).catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(429);
    expect(err.getResponse()).toEqual({ error: 'slow' });
    expect(headers['Retry-After']).toBe('3');
  });

  it('the module provides one token per configured gate', () => {
    const mod = AtlasLimitsModule.register({ rateLimit: allow as never });
    expect(mod.exports).toEqual([ATLAS_RATE_LIMIT]);
    expect(AtlasLimitsModule.register({ grantUsage: allow as never }).exports).toEqual([ATLAS_GRANT_USAGE]);
  });
});
