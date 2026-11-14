import { describe, expect, it, vi } from 'vitest';
import { AtlasGraphQLError } from './index';
import { withGrantUsage, withRateLimit } from './limits';

const allow = vi.fn(async (_req: unknown) => ({ allowed: true as const }));
const deny = async () => ({ allowed: false as const, status: 429, headers: { 'Retry-After': '3' } });
const ctx = { atlas: { claims: { sub: 'u' } }, req: { headers: { a: 'b' }, ip: '7.7.7.7' } } as never;

describe('graphql limits', () => {
  it('runs the resolver when allowed', async () => {
    const resolver = vi.fn(() => 'ok');
    expect(await withRateLimit(allow as never)(resolver)({}, {}, ctx, null)).toBe('ok');
    expect(allow).toHaveBeenLastCalledWith({ claims: { sub: 'u' }, headers: { a: 'b' }, ip: '7.7.7.7' });
  });

  it('throws RATE_LIMITED with the status and headers and skips the resolver', async () => {
    const resolver = vi.fn(() => 'ok');
    const err = await withGrantUsage(deny as never)(resolver)({}, {}, ctx, null).catch((e) => e);
    expect(resolver).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(AtlasGraphQLError);
    expect(err.extensions).toEqual({ code: 'RATE_LIMITED', http: { status: 429, headers: { 'Retry-After': '3' } } });
  });

  it('keeps the existing error defaults', () => {
    expect(new AtlasGraphQLError('FORBIDDEN', 'x').extensions.http).toEqual({ status: 403 });
  });
});
