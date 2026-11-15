import { describe, expect, it } from 'vitest';
import type { ConfigHttp } from '../../config-http';
import type { CollectionSpec, SingletonSpec } from '../config';
import { registeredConfigTypes } from './index';
import { SURFACE_CONFIG_TYPES } from './surface-config';

type Call = { method: string; path: string; body?: unknown };
function http(answers: Record<string, unknown>) {
  const calls: Call[] = [];
  const h: ConfigHttp = {
    get: async (p) => (calls.push({ method: 'GET', path: p }), answers[p] as never),
    post: async (p, b) => (calls.push({ method: 'POST', path: p, body: b }), {} as never),
    put: async (p, b) => (calls.push({ method: 'PUT', path: p, body: b }), {} as never),
    patch: async (p, b) => (calls.push({ method: 'PATCH', path: p, body: b }), {} as never),
    delete: async (p) => void calls.push({ method: 'DELETE', path: p }),
  };
  return { h, calls };
}
const by = (t: string) => SURFACE_CONFIG_TYPES.find((s) => s.type === t)!;
const POLICIES = { data: [{ id: 'pol_1', key: 'tos', audience: 'orgs' }, { id: 'pol_2', key: 'privacy', audience: 'everyone' }] };

describe('surface config types', () => {
  it('are registered and none is pruned by a bare --prune', () => {
    const types = registeredConfigTypes().map((s) => s.type);
    for (const t of ['policy_audiences', 'oauth_publisher_clients', 'region']) expect(types).toContain(t);
    expect((by('policy_audiences') as CollectionSpec).prune).toBe(false);
    expect((by('oauth_publisher_clients') as CollectionSpec).prune).toBe(false);
  });

  it('policy_audiences exports only narrowed policies, keyed by policy key, with sorted organizations', async () => {
    const { h } = http({ '/v1/policies': POLICIES, '/v1/policies/pol_1/audience': { audience: 'orgs', organization_ids: ['org_b', 'org_a'] } });
    expect(await (by('policy_audiences') as CollectionSpec).fetchLive(h)).toEqual([
      { key: 'tos', id: 'pol_1', config: { policy: 'tos', audience: 'orgs', organization_ids: ['org_a', 'org_b'] } },
    ]);
  });

  it('policy_audiences creates through the policy id, and pruning returns the policy to everyone', async () => {
    const spec = by('policy_audiences') as CollectionSpec;
    const { h, calls } = http({ '/v1/policies': POLICIES });
    await spec.create(h, { policy: 'privacy', audience: 'orgs', organization_ids: ['org_a'] });
    expect(calls.at(-1)).toEqual({ method: 'PUT', path: '/v1/policies/pol_2/audience', body: { audience: 'orgs', organization_ids: ['org_a'] } });
    await spec.remove!(h, { key: 'tos', id: 'pol_1', config: {} });
    expect(calls.at(-1)).toEqual({ method: 'PUT', path: '/v1/policies/pol_1/audience', body: { audience: 'everyone' } });
    await expect(spec.create(h, { policy: 'nope', audience: 'orgs' })).rejects.toThrow(/no policy with key 'nope'/);
  });

  it('oauth_publisher_clients flattens attached apps, attaches by domain and detaches by id', async () => {
    const spec = by('oauth_publisher_clients') as CollectionSpec;
    const { h, calls } = http({ '/v1/oauth_publishers': { data: [{ id: 'opub_1', domain: 'acme.example', client_ids: ['app_1', 'app_2'] }] } });
    const live = await spec.fetchLive(h);
    expect(live.map((e) => e.key)).toEqual(['acme.example/app_1', 'acme.example/app_2']);
    await spec.create(h, { publisher: 'acme.example', client_id: 'app_3', allow_subject_change: true });
    expect(calls.at(-1)).toEqual({ method: 'PUT', path: '/v1/oauth_publishers/opub_1/clients/app_3', body: { allow_subject_change: true } });
    await spec.remove!(h, live[0]!);
    expect(calls.at(-1)).toEqual({ method: 'DELETE', path: '/v1/oauth_publishers/opub_1/clients/app_1' });
    await expect(spec.create(h, { publisher: 'other.example', client_id: 'x' })).rejects.toThrow(/no publisher/);
  });

  it('region reads the two settable keys and writes only them', async () => {
    const spec = by('region') as SingletonSpec;
    const { h, calls } = http({ '/v1/region': { pinned: true, region: 'us', failover_region: 'eu', fapi_isolation: 'enforce', regions: [] } });
    expect(await spec.fetchLive(h)).toEqual({ failover_region: 'eu', fapi_isolation: 'enforce' });
    await spec.apply(h, { failover_region: 'eu', fapi_isolation: 'off', pin: true } as never, { forceHook: false });
    expect(calls.at(-1)).toEqual({ method: 'PUT', path: '/v1/region', body: { failover_region: 'eu', fapi_isolation: 'off' } });
  });
});
