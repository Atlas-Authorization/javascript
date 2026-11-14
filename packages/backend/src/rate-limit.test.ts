import { describe, expect, it, vi } from 'vitest';
import { createMemoryRateLimitStore, createRateLimiter, createRedisRateLimitStore, rateLimitRequest, RATE_LIMIT_LUA } from './rate-limit';

const keyPolicy = { name: 'per-key', subject: 'key' as const, limit: 2, windowSeconds: 10 };

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('createRateLimiter', () => {
  it('allows up to the limit then denies, and resets after the window', async () => {
    const c = clock();
    const rl = createRateLimiter({ policies: [keyPolicy], now: c.now });
    const s = { keyId: 'k1' };
    expect((await rl.check({ subject: s })).remaining).toBe(1);
    expect((await rl.check({ subject: s })).allowed).toBe(true);
    const denied = await rl.check({ subject: s });
    expect(denied).toMatchObject({ allowed: false, remaining: 0, policy: 'per-key', limit: 2 });
    expect(denied.resetMs).toBe(10_000);
    c.advance(10_001);
    expect((await rl.check({ subject: s })).allowed).toBe(true);
  });

  it('isolates subjects and honours cost and burst', async () => {
    const rl = createRateLimiter({ policies: [{ ...keyPolicy, burst: 1 }], now: clock().now });
    expect((await rl.check({ subject: { keyId: 'a' }, cost: 3 })).allowed).toBe(true);
    expect((await rl.check({ subject: { keyId: 'a' } })).allowed).toBe(false);
    expect((await rl.check({ subject: { keyId: 'b' } })).allowed).toBe(true);
    await expect(rl.check({ subject: { keyId: 'a' }, cost: 0 })).rejects.toThrow(RangeError);
  });

  it('allows with policy null when nothing applies', async () => {
    const rl = createRateLimiter({ policies: [keyPolicy] });
    expect(await rl.check({ subject: { userId: 'u' } })).toMatchObject({ allowed: true, policy: null });
  });

  it('a denial on any applicable policy denies', async () => {
    const rl = createRateLimiter({
      policies: [keyPolicy, { name: 'per-ip', subject: 'ip', limit: 1, windowSeconds: 60 }],
      now: clock().now,
    });
    const s = { keyId: 'k', ip: '1.1.1.1' };
    expect((await rl.check({ subject: s })).allowed).toBe(true);
    expect(await rl.check({ subject: s })).toMatchObject({ allowed: false, policy: 'per-ip' });
  });

  it('fails open by default and closed on request when the store throws', async () => {
    const store = { incr: vi.fn().mockRejectedValue(new Error('down')) };
    const hook = vi.fn();
    expect((await createRateLimiter({ policies: [keyPolicy], store, onStoreError: (e) => (hook(e), undefined) }).check({ subject: { keyId: 'k' } })).allowed).toBe(true);
    expect(hook).toHaveBeenCalledOnce();
    expect((await createRateLimiter({ policies: [keyPolicy], store, onStoreError: 'closed' }).check({ subject: { keyId: 'k' } })).allowed).toBe(false);
    expect((await createRateLimiter({ policies: [keyPolicy], store, onStoreError: () => 'closed' }).check({ subject: { keyId: 'k' } })).allowed).toBe(false);
  });

  it('resolves policies through the client, caches them, and refetches after the ttl', async () => {
    const c = clock();
    const resolve = vi.fn().mockResolvedValue({ name: 'plan-pro', limit: 1, window_seconds: 60, version: 3 });
    const rl = createRateLimiter({ client: { rateLimitPolicies: { resolve } }, policyTtlMs: 5000, now: c.now });
    expect((await rl.check({ subject: { keyId: 'k' } })).policy).toBe('plan-pro');
    expect((await rl.check({ subject: { keyId: 'k' } })).allowed).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({ key_id: 'k' });
    c.advance(5001);
    resolve.mockResolvedValue({ rate_limit: { max: 100, window_seconds: 60 }, version: 4 });
    expect((await rl.check({ subject: { keyId: 'k' } })).limit).toBe(100);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('keeps the last policy when the resolve call fails', async () => {
    const c = clock();
    const resolve = vi.fn().mockResolvedValueOnce({ name: 'p', limit: 1, window_seconds: 60 }).mockRejectedValue(new Error('net'));
    const rl = createRateLimiter({ client: { rateLimitPolicies: { resolve } }, policyTtlMs: 10, now: c.now });
    await rl.check({ subject: { keyId: 'k' } });
    c.advance(100);
    expect((await rl.check({ subject: { keyId: 'k' } })).allowed).toBe(false);
  });

  it("requires a redis client for store 'redis'", () => {
    expect(() => createRateLimiter({ store: 'redis' })).toThrow(/redis/);
  });
});

describe('stores', () => {
  it('memory store counts and expires', async () => {
    const c = clock();
    const s = createMemoryRateLimitStore(c.now);
    expect(await s.incr('a', 2, 1000)).toEqual({ count: 2, ttlMs: 1000 });
    c.advance(400);
    expect(await s.incr('a', 1, 1000)).toEqual({ count: 3, ttlMs: 600 });
    c.advance(700);
    expect((await s.incr('a', 1, 1000)).count).toBe(1);
  });

  it('redis store sends one eval with the script and parses the reply', async () => {
    const ev = vi.fn().mockResolvedValue([4, 2500]);
    const r = await createRedisRateLimitStore({ eval: ev }).incr('k', 2, 9000);
    expect(ev).toHaveBeenCalledWith(RATE_LIMIT_LUA, 1, 'k', 2, 9000);
    expect(r).toEqual({ count: 4, ttlMs: 2500 });
    await expect(createRedisRateLimitStore({ eval: async () => 'x' }).incr('k', 1, 1)).rejects.toThrow();
  });
});

describe('rateLimitRequest', () => {
  it('returns RateLimit headers when allowed and 429 + Retry-After when denied', async () => {
    const rl = createRateLimiter({ policies: [{ ...keyPolicy, limit: 1 }], now: clock().now });
    const guard = rateLimitRequest(rl, (req: { k: string }) => ({ keyId: req.k }));
    const ok = await guard({ k: 'x' });
    expect(ok).toEqual({
      allowed: true,
      headers: { 'RateLimit-Limit': '1', 'RateLimit-Remaining': '0', 'RateLimit-Reset': '10', 'RateLimit-Policy': '1;w=10' },
    });
    const no = await guard({ k: 'x' });
    expect(no).toMatchObject({ allowed: false, status: 429, headers: { 'Retry-After': '10' }, body: { error: { code: 'rate_limited' } } });
  });

  it('supports a cost from subjectFrom and emits no headers without a policy', async () => {
    const rl = createRateLimiter({ policies: [keyPolicy] });
    const g = rateLimitRequest(rl, () => ({ subject: { keyId: 'c' }, cost: 5 }));
    expect((await g({})).allowed).toBe(false);
    expect(await rateLimitRequest(rl, () => ({}))({})).toEqual({ allowed: true, headers: {} });
  });
});
