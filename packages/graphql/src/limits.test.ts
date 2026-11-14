import { describe, expect, it, vi } from 'vitest';
import { AtlasGraphQLError } from './index';
import { withFeature, withGrantUsage, withRateLimit } from './limits';

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

describe('graphql feature gate', () => {
  const noFeature = async () => ({ allowed: false as const, status: 403, body: { error: { code: 'feature_not_entitled' } } });
  it('runs the resolver when the plan has the feature', async () => {
    expect(await withFeature(allow as never)(() => 'ok')({}, {}, ctx, null)).toBe('ok');
  });
  it('throws FORBIDDEN and skips the resolver when it does not', async () => {
    const resolver = vi.fn(() => 'ok');
    const err = await withFeature(noFeature as never)(resolver)({}, {}, ctx, null).catch((e) => e);
    expect(resolver).not.toHaveBeenCalled();
    expect(err.extensions.code).toBe('FORBIDDEN');
    expect(err.extensions.http.status).toBe(403);
  });
});
