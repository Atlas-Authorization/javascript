import { describe, expect, it } from 'vitest';
import { createEntitlementCache, hasFeature, requireFeature } from './entitlements';
import type { Entitlements } from './client/entitlement-overrides';

const doc = (features: Array<{ key: string; limit?: number }>): Entitlements => ({
  object: 'entitlements',
  subject: { type: 'org', id: 'org_1' },
  plan: 'pro',
  planSource: 'plan',
  version: 0,
  entitlements: features.map((f) => ({ key: f.key, enabled: true, source: 'plan' as const, ...(f.limit === undefined ? {} : { limit: f.limit }) })),
});

function reader(answers: Array<Entitlements | Error>) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    client: {
      entitlements: {
        async get() {
          const a = answers[Math.min(calls++, answers.length - 1)]!;
          if (a instanceof Error) throw a;
          return a;
        },
      },
    },
  };
}

describe('hasFeature', () => {
  it('reads the token feature list and grants nothing when it is missing', () => {
    expect(hasFeature({ fea: ['sso', 'exports'] }, 'sso')).toBe(true);
    expect(hasFeature({ fea: ['sso'] }, 'exports')).toBe(false);
    expect(hasFeature({}, 'sso')).toBe(false);
    expect(hasFeature(null, 'sso')).toBe(false);
  });
});

describe('createEntitlementCache', () => {
  const org = { type: 'org' as const, id: 'org_1' };

  it('serves a subject from the cache within the TTL and asks again after it', async () => {
    let t = 0;
    const r = reader([doc([{ key: 'sso' }]), doc([{ key: 'sso' }, { key: 'exports', limit: 5 }])]);
    const cache = createEntitlementCache({ client: r.client, ttlSeconds: 60, now: () => t });
    expect(await cache.has(org, 'sso')).toBe(true);
    expect(await cache.has(org, 'exports')).toBe(false);
    expect(r.calls).toBe(1);
    t = 61_000;
    expect(await cache.has(org, 'exports')).toBe(true);
    expect(await cache.limit(org, 'exports')).toBe(5);
    expect(await cache.limit(org, 'sso')).toBeNull();
    expect(r.calls).toBe(2);
  });

  it('shares one read between concurrent callers and drops a subject on invalidate', async () => {
    const r = reader([doc([{ key: 'sso' }])]);
    const cache = createEntitlementCache({ client: r.client });
    await Promise.all([cache.get(org), cache.get(org), cache.get(org)]);
    expect(r.calls).toBe(1);
    cache.invalidate(org);
    await cache.get(org);
    expect(r.calls).toBe(2);
  });

  it('rejects when Atlas fails and nothing usable is cached, and serves a stale answer only when allowed', async () => {
    let t = 0;
    const strict = createEntitlementCache({ client: reader([new Error('down')]).client, now: () => t });
    await expect(strict.get(org)).rejects.toThrow('down');

    const r = reader([doc([{ key: 'sso' }]), new Error('down')]);
    const lenient = createEntitlementCache({ client: r.client, ttlSeconds: 10, staleIfErrorSeconds: 30, now: () => t });
    expect(await lenient.has(org, 'sso')).toBe(true);
    t = 15_000;
    expect(await lenient.has(org, 'sso')).toBe(true);
    t = 60_000;
    await expect(lenient.get(org)).rejects.toThrow('down');
  });

  it('holds at most maxEntries subjects', async () => {
    const r = reader([doc([{ key: 'sso' }])]);
    const cache = createEntitlementCache({ client: r.client, maxEntries: 2 });
    for (const id of ['a', 'b', 'c']) await cache.get({ type: 'user', id });
    await cache.get({ type: 'user', id: 'a' });
    expect(r.calls).toBe(4);
  });
});

describe('requireFeature', () => {
  const cache = () => createEntitlementCache({ client: reader([doc([{ key: 'exports' }])]).client });

  it('allows a subject whose plan includes the feature, preferring the active org', async () => {
    const gate = requireFeature({ cache: cache(), feature: 'exports' });
    expect(await gate({ claims: { sub: 'user_1', org_id: 'org_1' } })).toEqual({ allowed: true });
  });

  it('answers 403 feature_not_entitled for a feature the plan lacks', async () => {
    const out = await requireFeature({ cache: cache(), feature: 'sso' })({ claims: { sub: 'user_1' } });
    expect(out).toMatchObject({ allowed: false, status: 403, body: { error: { code: 'feature_not_entitled', feature: 'sso' } } });
  });

  it('answers 401 without a subject and honours the subject option', async () => {
    expect(await requireFeature({ cache: cache(), feature: 'exports' })({ claims: null })).toMatchObject({ allowed: false, status: 401 });
    expect(await requireFeature({ cache: cache(), feature: 'exports', subject: 'org' })({ claims: { sub: 'user_1' } })).toMatchObject({ status: 401 });
    const picked = await requireFeature({ cache: cache(), feature: 'exports', subject: () => ({ type: 'org', id: 'org_9' }) })({ claims: null });
    expect(picked).toEqual({ allowed: true });
  });

  it('never allows when the cache read fails', async () => {
    const failing = createEntitlementCache({ client: reader([new Error('down')]).client });
    await expect(requireFeature({ cache: failing, feature: 'exports' })({ claims: { sub: 'u' } })).rejects.toThrow('down');
  });
});
