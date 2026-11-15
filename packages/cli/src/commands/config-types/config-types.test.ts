import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigHttp } from '../../config-http';
import { configTypes, planConfigImport } from '../config';
import { registeredConfigTypes } from './index';
import { configJsonSchema } from './schema';
import { simpleResourceSpec } from './simple';

class Http implements ConfigHttp {
  calls: Array<{ method: string; path: string; body?: unknown }> = [];
  constructor(private lists: Record<string, unknown[]> = {}) {}
  async get<T>(path: string): Promise<T> {
    return { data: this.lists[path] ?? [] } as T;
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

const spec = simpleResourceSpec({ type: 'widgets', path: '/v1/widgets', fileKeys: ['name', 'url', 'secret'], writeOnly: ['secret'], sealed: ['token'] });

describe('simpleResourceSpec', () => {
  it('creates, updates and deletes through the collection route', async () => {
    const http = new Http();
    await spec.create(http, { name: 'a', url: 'https://x.test', secret: '${S}' });
    await spec.update!(http, { key: 'a', id: 'a', config: {} }, { name: 'a', url: 'https://y.test' });
    await spec.remove!(http, { key: 'a', id: 'a', config: {} });
    expect(http.calls).toEqual([
      { method: 'POST', path: '/v1/widgets', body: { name: 'a', url: 'https://x.test', secret: '${S}' } },
      { method: 'PATCH', path: '/v1/widgets/a', body: { url: 'https://y.test' } },
      { method: 'DELETE', path: '/v1/widgets/a' },
    ]);
  });

  it('is no-prune by default', () => {
    expect(spec.prune).toBe(false);
  });

  it('never exports a write-only, sealed or secret-named field', async () => {
    const http = new Http({ '/v1/widgets': [{ name: 'a', url: 'https://x.test', secret: 'LEAK', token: 'LEAK', api_key: 'LEAK' }] });
    const [entry] = await simpleResourceSpec({ type: 'widgets', path: '/v1/widgets', fileKeys: ['name', 'url', 'secret', 'token', 'api_key'], writeOnly: ['secret'], sealed: ['token'] }).fetchLive(http);
    expect(entry!.config).toEqual({ name: 'a', url: 'https://x.test' });
  });
});

describe('registry', () => {
  it('keeps today\'s order; registered types come last', () => {
    const types = configTypes();
    const extra = registeredConfigTypes().map((s) => s.type);
    expect(types.slice(0, 3)).toEqual(['email_provider', 'sms_provider', 'push_provider']);
    expect(types.slice(types.length - extra.length)).toEqual(extra);
  });

  it('publishes a JSON Schema section per type', () => {
    const schema = configJsonSchema([spec]) as { properties: Record<string, { oneOf: Array<{ type: string; properties?: Record<string, unknown> }> }> };
    const [plain, wrapped] = schema.properties.widgets!.oneOf;
    expect(plain!.type).toBe('array');
    // the `{ requires, items }` wrapper is accepted too
    expect(wrapped!.type).toBe('object');
    expect(Object.keys(wrapped!.properties!).sort()).toEqual(['items', 'requires']);
  });
});

describe('jwt_templates settings', () => {
  let dir = '';
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('detects drift in lifetime and never treats the signing secret as exported', async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-jwt-'));
    writeFileSync(join(dir, 'jwt_templates.json'), JSON.stringify([{ name: 't', claims: { a: 'b' }, settings: { lifetime_seconds: 900 } }]));
    const http = new Http({ '/v1/jwt_templates': [{ name: 't', claims: { a: 'b' }, settings: { lifetime_seconds: 600, audience: null, algorithm: 'RS256', has_signing_secret: false } }] });
    const plan = await planConfigImport(http, { dir, format: 'json', env: {}, prune: false });
    expect(plan.changes.map((c) => `${c.action} ${c.type}`)).toEqual(['update jwt_templates']);
    await plan.changes[0]!.apply();
    expect(http.calls[0]).toEqual({ method: 'PATCH', path: '/v1/jwt_templates/t', body: { claims: { a: 'b' }, settings: { lifetime_seconds: 900 } } });
  });
});

describe('user_traits_schema', () => {
  const spec = registeredConfigTypes().find((s) => s.type === 'user_traits_schema');
  if (!spec || spec.kind !== 'singleton') throw new Error('user_traits_schema is not registered');

  it('exports nothing for an instance that never configured one', async () => {
    const http = { get: async () => ({ version: 0, enforcement: 'off', schemas: {} }) } as unknown as ConfigHttp;
    expect(await spec.fetchLive(http)).toBeNull();
  });

  it('exports the schemas and enforcement without version or timestamps', async () => {
    const http = { get: async () => ({ object: 'user_traits_schema', version: 3, enforcement: 'warn', schemas: { public_metadata: { type: 'object' } }, updated_at: 1 }) } as unknown as ConfigHttp;
    expect(await spec.fetchLive(http)).toEqual({ enforcement: 'warn', schemas: { public_metadata: { type: 'object' } } });
  });

  it('applies with one PUT carrying only what the file sets', async () => {
    const http = new Http();
    await spec.apply(http, { enforcement: 'enforce' }, { forceHook: false });
    expect(http.calls).toEqual([{ method: 'PUT', path: '/v1/instance/user_traits_schema', body: { enforcement: 'enforce' } }]);
  });
});
