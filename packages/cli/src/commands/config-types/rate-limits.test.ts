import { describe, expect, it } from 'vitest';
import type { ConfigHttp } from '../../config-http';
import { registeredConfigTypes } from './index';
import type { CollectionSpec } from '../config';
import { RATE_LIMIT_CONFIG_TYPES } from './rate-limits';

class Http implements ConfigHttp {
  calls: Array<{ method: string; path: string; body?: unknown }> = [];
  constructor(private rows: unknown[] = []) {}
  async get<T>(path: string): Promise<T> {
    this.calls.push({ method: 'GET', path });
    return { data: this.rows } as T;
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

const spec = RATE_LIMIT_CONFIG_TYPES[0] as CollectionSpec;

describe('rate_limit_policies config type', () => {
  it('is registered and never pruned by default', () => {
    expect(registeredConfigTypes().map((s) => s.type)).toContain('rate_limit_policies');
    expect(spec.prune).toBe(false);
  });

  it('reads policies by name, addressed by id, without server-only fields', async () => {
    const http = new Http([{ id: 'rlpol_1', name: 'api', subject: 'key', limit: 600, window_seconds: 60, burst: null, plan_overrides: { pro: { limit: 6000 } }, is_default: true, enabled: true, version: 4, created_at: 1 }]);
    const [live] = await spec.fetchLive(http);
    expect(live).toEqual({
      key: 'api',
      id: 'rlpol_1',
      config: { name: 'api', subject: 'key', limit: 600, window_seconds: 60, plan_overrides: { pro: { limit: 6000 } }, is_default: true, enabled: true },
    });
  });

  it('creates, updates by id and deletes through the collection route', async () => {
    const http = new Http();
    await spec.create(http, { name: 'api', subject: 'key', limit: 600, window_seconds: 60 });
    await spec.update!(http, { key: 'api', id: 'rlpol_1', config: {} }, { name: 'api', subject: 'key', limit: 900 });
    await spec.remove!(http, { key: 'api', id: 'rlpol_1', config: {} });
    expect(http.calls).toEqual([
      { method: 'POST', path: '/v1/rate_limit_policies', body: { name: 'api', subject: 'key', limit: 600, window_seconds: 60 } },
      { method: 'PATCH', path: '/v1/rate_limit_policies/rlpol_1', body: { subject: 'key', limit: 900 } },
      { method: 'DELETE', path: '/v1/rate_limit_policies/rlpol_1' },
    ]);
  });
});
