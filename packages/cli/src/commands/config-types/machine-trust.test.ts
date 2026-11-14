import { describe, expect, it } from 'vitest';
import type { ConfigHttp } from '../../config-http';
import { registeredConfigTypes } from './index';
import type { CollectionSpec } from '../config';
import { MACHINE_TRUST_CONFIG_TYPES } from './machine-trust';

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

const spec = MACHINE_TRUST_CONFIG_TYPES[0] as CollectionSpec;

describe('machine_trust_policies config type', () => {
  it('is registered and never pruned by default', () => {
    expect(registeredConfigTypes().map((s) => s.type)).toContain('machine_trust_policies');
    expect(spec.prune).toBe(false);
  });

  it('names an entry by machine and name, addressed by id, without server-only fields', async () => {
    const http = new Http([{ id: 'mtp_1', machine_id: 'mch_1', name: 'deploy', kind: 'github_actions', issuer: 'https://token.actions.githubusercontent.com', audience: 'https://id', subject_pattern: 'repo:acme/*', claim_conditions: [], max_ttl_seconds: 600, enabled: true, last_used_at: 5, created_at: 1 }]);
    const [live] = await spec.fetchLive(http);
    expect(live!.key).toBe('mch_1/deploy');
    expect(live!.id).toBe('mtp_1');
    expect(live!.config).toMatchObject({ machine_id: 'mch_1', name: 'deploy', kind: 'github_actions', subject_pattern: 'repo:acme/*' });
    expect(live!.config).not.toHaveProperty('last_used_at');
  });

  it('creates with kind, updates without it, and deletes by id', async () => {
    const http = new Http();
    const config = { machine_id: 'mch_1', name: 'deploy', kind: 'github_actions', audience: 'https://id', subject_pattern: 'repo:acme/*' };
    await spec.create(http, config);
    await spec.update!(http, { key: 'mch_1/deploy', id: 'mtp_1', config: {} }, { ...config, max_ttl_seconds: 300 });
    await spec.remove!(http, { key: 'mch_1/deploy', id: 'mtp_1', config: {} });
    expect(http.calls[0]).toMatchObject({ method: 'POST', path: '/v1/machine_trust_policies', body: config });
    expect(http.calls[1]).toEqual({ method: 'PATCH', path: '/v1/machine_trust_policies/mtp_1', body: { audience: 'https://id', subject_pattern: 'repo:acme/*', max_ttl_seconds: 300 } });
    expect(http.calls[2]).toEqual({ method: 'DELETE', path: '/v1/machine_trust_policies/mtp_1' });
  });

  it('warns that a platform kind cannot change in place', () => {
    const warnings = spec.warnings?.({ machine_id: 'mch_1', name: 'deploy', kind: 'gcp' }, { machine_id: 'mch_1', name: 'deploy', kind: 'github_actions' });
    expect(warnings?.[0]).toMatch(/kind cannot be changed/);
  });
});
