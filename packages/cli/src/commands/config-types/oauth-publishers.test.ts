import { describe, expect, it } from 'vitest';
import type { ConfigHttp } from '../../config-http';
import { registeredConfigTypes } from './index';
import type { CollectionSpec } from '../config';
import { OAUTH_PUBLISHER_CONFIG_TYPES } from './oauth-publishers';

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

const spec = OAUTH_PUBLISHER_CONFIG_TYPES[0] as CollectionSpec;

describe('oauth_publishers config type', () => {
  it('is registered and never pruned by default', () => {
    expect(registeredConfigTypes().map((s) => s.type)).toContain('oauth_publishers');
    expect(spec.prune).toBe(false);
  });

  it('reads publishers by domain, addressed by id, without verification state or the app list', async () => {
    const http = new Http([{ id: 'opub_1', name: 'Acme', domain: 'acme.example', verified: true, record_value: 'atlas-publisher-verification=x', shared_sector: true, skip_consent: false, client_ids: ['app_1'], created_at: 1 }]);
    const [live] = await spec.fetchLive(http);
    expect(live).toEqual({ key: 'acme.example', id: 'opub_1', config: { domain: 'acme.example', name: 'Acme', shared_sector: true, skip_consent: false } });
  });

  it('creates without shared_sector, updates by id and deletes through the collection route', async () => {
    const http = new Http();
    await spec.create(http, { domain: 'acme.example', name: 'Acme', shared_sector: true, skip_consent: true });
    expect(http.calls[0]).toEqual({ method: 'POST', path: '/v1/oauth_publishers', body: { domain: 'acme.example', name: 'Acme', skip_consent: true } });
    await spec.update!(http, { key: 'acme.example', id: 'opub_1', config: {} }, { domain: 'acme.example', name: 'Acme 2', shared_sector: true });
    expect(http.calls[1]).toMatchObject({ method: 'PATCH', path: '/v1/oauth_publishers/opub_1' });
    expect((http.calls[1]!.body as Record<string, unknown>).name).toBe('Acme 2');
    await spec.remove!(http, { key: 'acme.example', id: 'opub_1', config: {} });
    expect(http.calls[2]).toEqual({ method: 'DELETE', path: '/v1/oauth_publishers/opub_1' });
  });
});
