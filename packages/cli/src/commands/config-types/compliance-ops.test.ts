import { describe, expect, it } from 'vitest';
import type { ConfigHttp } from '../../config-http';
import type { CollectionSpec } from '../config';
import { registeredConfigTypes } from './index';
import { COMPLIANCE_OPS_CONFIG_TYPES } from './compliance-ops';

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

const spec = COMPLIANCE_OPS_CONFIG_TYPES[0] as CollectionSpec;

describe('erasure_connectors config type', () => {
  it('is registered and never pruned by default', () => {
    expect(registeredConfigTypes().map((s) => s.type)).toContain('erasure_connectors');
    expect(spec.prune).toBe(false);
  });

  it('reads connectors by key without server-only fields', async () => {
    const http = new Http([{ id: 'ercn_1', key: 'stripe', catalog_id: 'stripe', name: 'Stripe', mode: 'manual', ack_source: null, enabled: true, notes: null, created_at: 1, updated_at: 2 }]);
    const live = await spec.fetchLive(http);
    expect(live).toHaveLength(1);
    expect(spec.keyOf(live[0]! as never)).toBe('stripe');
    expect(live[0]).not.toHaveProperty('created_at');
  });
});
