import { describe, expect, it } from 'vitest';
import type { ConfigHttp } from '../../config-http';
import { authzEnterpriseSpecs } from './authz-enterprise';

class Http implements ConfigHttp {
  calls: Array<{ method: string; path: string; body?: unknown }> = [];
  constructor(private answers: Record<string, unknown> = {}) {}
  async get<T>(path: string): Promise<T> {
    return (this.answers[path] ?? { data: [] }) as T;
  }
  async post<T>(path: string, body: unknown): Promise<T> {
    this.calls.push({ method: 'POST', path, body });
    return {} as T;
  }
  async put<T>(path: string, body: unknown): Promise<T> {
    this.calls.push({ method: 'PUT', path, body });
    return {} as T;
  }
  async patch<T>(path: string, body: unknown): Promise<T> {
    this.calls.push({ method: 'PATCH', path, body });
    return {} as T;
  }
  async delete(path: string): Promise<void> {
    this.calls.push({ method: 'DELETE', path });
  }
}

const byType = (t: string) => authzEnterpriseSpecs.find((s) => s.type === t)!;
const live = (id: string) => ({ key: id, id, config: {} });

describe('group 2 config types', () => {
  it('registers every type once, and every collection is no-prune', () => {
    const types = authzEnterpriseSpecs.map((s) => s.type);
    expect(new Set(types).size).toBe(types.length);
    for (const s of authzEnterpriseSpecs) if (s.kind === 'collection') expect(s.prune).toBe(false);
  });

  it('app_roles: the key is create-only, update is addressed by id', async () => {
    const http = new Http();
    const s = byType('app_roles');
    if (s.kind !== 'collection') throw new Error('collection');
    await s.create(http, { key: 'support', name: 'Support', permissions: ['a'] });
    await s.update!(http, live('role_1'), { key: 'support', name: 'Support 2', permissions: ['a'] });
    expect(http.calls).toEqual([
      { method: 'POST', path: '/v1/app_roles', body: { key: 'support', name: 'Support', permissions: ['a'] } },
      { method: 'PATCH', path: '/v1/app_roles/role_1', body: { name: 'Support 2', permissions: ['a'] } },
    ]);
  });

  it('billing_coupons: active is not sent on create, only the mutable keys on update', async () => {
    const http = new Http();
    const s = byType('billing_coupons');
    if (s.kind !== 'collection') throw new Error('collection');
    await s.create(http, { code: 'WELCOME', name: 'Welcome', percent_off: 10, active: true });
    await s.update!(http, live('cpn_1'), { code: 'WELCOME', name: 'Welcome', percent_off: 10, active: false });
    expect(http.calls[0]!.body).toEqual({ code: 'WELCOME', name: 'Welcome', percent_off: 10 });
    expect(http.calls[1]).toEqual({ method: 'PATCH', path: '/v1/billing/coupons/cpn_1', body: { active: false, name: 'Welcome' } });
  });

  it('iga_bundles: entitlement_ids go out as entitlements', async () => {
    const http = new Http();
    const s = byType('iga_bundles');
    if (s.kind !== 'collection') throw new Error('collection');
    await s.create(http, { key: 'starter', name: 'Starter', entitlement_ids: ['e1'] });
    expect(http.calls[0]!.body).toEqual({ key: 'starter', name: 'Starter', entitlements: ['e1'] });
  });

  it('scim_provisioning_targets: the bearer is never exported', async () => {
    const s = byType('scim_provisioning_targets');
    if (s.kind !== 'collection') throw new Error('collection');
    const http = new Http({ '/v1/scim_provisioning_targets': { data: [{ id: 't1', name: 'okta', base_url: 'https://x.test', has_bearer_token: true, bearer_token: 'LEAK', enabled: true }] } });
    const [entry] = await s.fetchLive(http);
    expect(entry!.config).toEqual({ name: 'okta', base_url: 'https://x.test', enabled: true });
  });

  it('billing_providers: PUT per provider, secrets sealed and not drift', async () => {
    const s = byType('billing_providers');
    if (s.kind !== 'collection') throw new Error('collection');
    const http = new Http({ '/v1/billing/providers': { data: [{ provider: 'stripe', environment: 'test', config: { publishable_key: 'pk' }, secrets_set: { secret_key: true } }] } });
    const [entry] = await s.fetchLive(http);
    expect(entry!.config).toEqual({ provider: 'stripe', environment: 'test', config: { publishable_key: 'pk' } });
    const desired = { provider: 'stripe', environment: 'test', config: { publishable_key: 'pk', secret_key: '${STRIPE_KEY}' } };
    expect(s.align!(entry!.config, desired)).toEqual(desired);
    await s.update!(http, entry!, desired);
    expect(http.calls[0]).toEqual({ method: 'PUT', path: '/v1/billing/providers/stripe', body: { environment: 'test', config: desired.config } });
    await s.remove!(http, entry!);
    expect(http.calls[1]).toEqual({ method: 'DELETE', path: '/v1/billing/providers/stripe' });
  });

  it('abac_schema is absent when no schema is set, present otherwise', async () => {
    const s = byType('abac_schema');
    if (s.kind !== 'singleton') throw new Error('singleton');
    expect(await s.fetchLive(new Http({ '/v1/abac_schema': { schema: null, version: 0 } }))).toBeNull();
    expect(await s.fetchLive(new Http({ '/v1/abac_schema': { schema: { a: 1 }, version: 2 } }))).toEqual({ schema: { a: 1 } });
    const http = new Http();
    await s.apply(http, { schema: { a: 1 } }, { forceHook: false });
    expect(http.calls).toEqual([{ method: 'PUT', path: '/v1/abac_schema', body: { schema: { a: 1 } } }]);
  });

  it('settings singletons send only the file keys they know', async () => {
    const s = byType('fga_settings');
    if (s.kind !== 'singleton') throw new Error('singleton');
    const http = new Http({ '/v1/fga/settings': { object: 'fga.settings', cache_ttl_ms: 5, default_consistency: 'UNSPECIFIED', changelog_retention_days: null } });
    expect(await s.fetchLive(http)).toEqual({ cache_ttl_ms: 5, default_consistency: 'UNSPECIFIED', changelog_retention_days: null });
    await s.apply(http, { cache_ttl_ms: 10, bogus: 1 }, { forceHook: false });
    expect(http.calls).toEqual([{ method: 'PUT', path: '/v1/fga/settings', body: { cache_ttl_ms: 10 } }]);
  });
});
