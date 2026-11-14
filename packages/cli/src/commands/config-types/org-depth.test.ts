import { describe, expect, it } from 'vitest';
import type { ConfigHttp } from '../../config-http';
import type { CollectionSpec } from '../config';
import { registeredConfigTypes } from './index';
import { ORG_DEPTH_CONFIG_TYPES } from './org-depth';

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

const [roleSets, templates] = ORG_DEPTH_CONFIG_TYPES as [CollectionSpec, CollectionSpec];

describe('org_role_sets and org_templates config types', () => {
  it('are registered, role sets before templates, and never pruned by default', () => {
    const types = registeredConfigTypes().map((s) => s.type);
    expect(types).toContain('org_role_sets');
    expect(types.indexOf('org_role_sets')).toBeLessThan(types.indexOf('org_templates'));
    expect(roleSets.prune).toBe(false);
    expect(templates.prune).toBe(false);
  });

  it('reads role sets by key without server-only fields', async () => {
    const http = new Http([{ id: 'orgrs_1', key: 'standard', name: 'Standard', description: null, role_keys: ['org:member'], default_role_key: 'org:member', created_at: 1, updated_at: 2 }]);
    const [live] = await roleSets.fetchLive(http);
    expect(live!.key).toBe('standard');
    expect(live!.id).toBe('orgrs_1');
    expect(live!.config).toMatchObject({ key: 'standard', name: 'Standard', role_keys: ['org:member'], default_role_key: 'org:member' });
    expect(live!.config).not.toHaveProperty('created_at');
  });

  it('creates and updates a role set without sending its fixed key on update', async () => {
    const http = new Http();
    await roleSets.create(http, { key: 'standard', name: 'Standard', role_keys: ['org:member'] });
    await roleSets.update!(http, { key: 'standard', id: 'orgrs_1', config: {} }, { key: 'standard', name: 'Std', role_keys: ['org:member'] });
    expect(http.calls[0]).toEqual({ method: 'POST', path: '/v1/org_role_sets', body: { key: 'standard', name: 'Standard', role_keys: ['org:member'] } });
    expect(http.calls[1]!.path).toBe('/v1/org_role_sets/orgrs_1');
    expect(http.calls[1]!.body).not.toHaveProperty('key');
  });

  it('addresses a template by id', async () => {
    const http = new Http();
    await templates.update!(http, { key: 'starter', id: 'orgtpl_1', config: {} }, { key: 'starter', name: 'Starter', seat_warn_percent: 90 });
    expect(http.calls[0]!.path).toBe('/v1/org_templates/orgtpl_1');
  });
});
