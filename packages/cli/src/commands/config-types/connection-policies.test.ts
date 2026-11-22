import { describe, expect, it } from 'vitest';
import type { ConfigHttp } from '../../config-http';
import type { CollectionSpec } from '../config';
import { registeredConfigTypes } from './index';
import { CONNECTION_POLICY_CONFIG_TYPES } from './connection-policies';

class Http implements ConfigHttp {
  calls: Array<{ method: string; path: string; body?: unknown }> = [];
  constructor(private answers: Record<string, unknown> = {}) {}
  async get<T>(path: string): Promise<T> {
    this.calls.push({ method: 'GET', path });
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

const spec = CONNECTION_POLICY_CONFIG_TYPES[0] as CollectionSpec;

describe('connection_provider_policies', () => {
  it('is registered, keyed by provider, never pruned by a bare --prune, and its secrets are write-only', () => {
    expect(registeredConfigTypes().map((s) => s.type)).toContain('connection_provider_policies');
    expect(spec.keyOf({ provider: 'etsy' })).toBe('etsy');
    expect(spec.prune).toBe(false);
    expect(spec.writeOnly).toEqual(['webhook_secret', 'dev_id']);
  });

  it('reads the list without any secret and writes only the keys the file sets', async () => {
    const http = new Http({ '/v1/connection_providers/policies': { data: [{ provider: 'etsy', unique_external_id: true, has_webhook_secret: true, has_dev_id: false }] } });
    expect(await spec.fetchLive(http)).toEqual([{ key: 'etsy', id: 'etsy', config: { provider: 'etsy', unique_external_id: true } }]);
    await spec.create(http, { provider: 'ebay', dev_id: 'dev-1' });
    await spec.update!(http, { key: 'etsy', id: 'etsy', config: {} }, { provider: 'etsy', unique_external_id: false, webhook_secret: null });
    await spec.remove!(http, { key: 'etsy', id: 'etsy', config: {} });
    expect(http.calls.slice(1)).toEqual([
      { method: 'PUT', path: '/v1/connection_providers/ebay/policy', body: { dev_id: 'dev-1' } },
      { method: 'PUT', path: '/v1/connection_providers/etsy/policy', body: { unique_external_id: false, webhook_secret: null } },
      { method: 'DELETE', path: '/v1/connection_providers/etsy/policy' },
    ]);
  });

  it('validates the provider key, the flag and where dev_id applies', () => {
    expect(spec.validate!({ provider: 'etsy', unique_external_id: true })).toEqual([]);
    expect(spec.validate!({ provider: 'Etsy!' })).toHaveLength(1);
    expect(spec.validate!({ provider: 'etsy', unique_external_id: 'yes' })).toHaveLength(1);
    expect(spec.validate!({ provider: 'etsy', dev_id: 'x' })).toHaveLength(1);
    expect(spec.validate!({ provider: 'ebay', dev_id: 'x' })).toEqual([]);
  });
});
