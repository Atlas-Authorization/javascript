import { describe, expect, it } from 'vitest';
import { JwksCache, checkJwksCacheTuning } from './jwks-cache';

const keys = { keys: [{ kid: 'a' }] };

function cacheWith(tuning: { maxStaleMs?: number; onServeStale?: (i: { staleForMs: number; error: string | null }) => void }) {
  let now = 0;
  let down = false;
  const cache = new JwksCache({
    url: 'https://auth.example.com/jwks',
    now: () => now,
    ttlMs: 1000,
    refetchIntervalMs: 10,
    fetchImpl: (async () => {
      if (down) throw new Error('down');
      return new Response(JSON.stringify(keys));
    }) as typeof fetch,
    ...tuning,
  });
  return { cache, advance: (ms: number) => (now += ms), setDown: (d: boolean) => (down = d) };
}

describe('JWKS cache stale tuning', () => {
  it('serves stale keys past the TTL while Atlas is down and reports it', async () => {
    const seen: number[] = [];
    const { cache, advance, setDown } = cacheWith({ maxStaleMs: 60_000, onServeStale: (i) => seen.push(i.staleForMs) });
    await cache.get('a');
    setDown(true);
    advance(5000);
    expect(await cache.get('a')).toEqual(keys);
    expect(seen.length).toBe(1);
  });

  it('maxStaleMs 0 fails closed the moment a refetch fails past the TTL', async () => {
    const { cache, advance, setDown } = cacheWith({ maxStaleMs: 0 });
    await cache.get('a');
    setDown(true);
    advance(1500);
    expect(await cache.get('a')).toBeNull();
  });

  it('a throwing stale hook never breaks verification, and bad tuning is refused', async () => {
    const { cache, advance, setDown } = cacheWith({ onServeStale: () => { throw new Error('boom'); } });
    await cache.get('a');
    setDown(true);
    advance(5000);
    expect(await cache.get('a')).toEqual(keys);
    expect(() => checkJwksCacheTuning({ maxStaleMs: -1 })).toThrow();
    expect(() => checkJwksCacheTuning({ ttlMs: 0 })).toThrow();
    expect(checkJwksCacheTuning({ maxStaleMs: 0 })).toEqual({ maxStaleMs: 0 });
  });
});
