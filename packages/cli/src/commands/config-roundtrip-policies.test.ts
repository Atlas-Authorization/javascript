import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryConfigStore } from '../config';
import type { ConfigHttp } from '../config-http';
import type { ManagementClient, RunContext } from '../context';
import { captureIO } from '../io';
import { run } from '../run';

type Call = { method: string; path: string; body?: unknown };
/** A tiny server that remembers what was written, so a second plan sees the first apply. */
class Api implements ConfigHttp {
  calls: Call[] = [];
  policy: Record<string, unknown> = {};
  privacy: Record<string, unknown> | null = null;
  async get<T>(path: string): Promise<T> {
    if (path === '/v1/instance') return { id: 'ins_1', frontend_api_host: 'acme-fapi.example.net', allowed_origins: [], auth_config: {} } as T;
    if (path === '/v1/organizations') return { data: [{ id: 'org_1' }] } as T;
    if (path === '/v1/instance/privacy_orchestrator') return (this.privacy ?? { configured: false }) as T;
    return { data: [] } as T;
  }
  async post<T>(): Promise<T> { return {} as T; }
  async put<T>(path: string, body: unknown): Promise<T> {
    if (path.includes('dry_run=true')) return {} as T;
    this.calls.push({ method: 'PUT', path, body });
    if (path === '/v1/instance/privacy_orchestrator') {
      const { api_key, ...rest } = body as Record<string, unknown>;
      this.privacy = { configured: true, ...rest, api_key_set: api_key !== undefined };
    }
    return {} as T;
  }
  async patch<T>(path: string, body: unknown): Promise<T> {
    if (path.includes('dry_run=true')) return {} as T;
    if (path === '/v1/organizations/org_1/policy') {
      this.policy = { ...this.policy, ...(body as object) };
      if (Object.keys(body as object).length) this.calls.push({ method: 'PATCH', path, body });
      return { policy: this.policy } as T;
    }
    return {} as T;
  }
  async delete(): Promise<void> {}
}
const ctx = (io: ReturnType<typeof captureIO>, api: ConfigHttp): RunContext => ({
  io, env: {},
  config: new MemoryConfigStore({ active_profile: 'default', profiles: { default: { api_url: 'https://api.test', secret_key: 'sk_test_123456' } } }),
  prompt: { text: async () => '', secret: async () => '' },
  readFile: (p) => readFileSync(p, 'utf8'),
  makeClient: () => ({}) as unknown as ManagementClient,
  makeHttp: () => api,
});
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'atlas-sp27-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const write = (name: string, text: string) => { const p = join(dir, name); writeFileSync(p, text); return p; };



describe('config round trip: organization_policies and privacy_orchestrator', () => {
  it('organization_policies applies, then plans clean (exit 0)', async () => {
    const api = new Api();
    const p = write('atlas.yaml', 'organization_policies:\n  - organization_id: org_1\n    requireMfa: true\n    maxSessions: 3\n');
    expect(await run(['plan', p, '--check'], ctx(captureIO(), api))).toBe(2);
    expect(await run(['apply', p, '--yes'], ctx(captureIO(), api))).toBe(0);
    expect(api.calls).toContainEqual({ method: 'PATCH', path: '/v1/organizations/org_1/policy', body: { requireMfa: true, maxSessions: 3 } });
    expect(await run(['plan', p, '--check'], ctx(captureIO(), api))).toBe(0);
  });
  it('privacy_orchestrator applies, then plans clean with the write-only api_key', async () => {
    const api = new Api();
    const p = write('atlas.yaml', 'privacy_orchestrator:\n  provider: cookiemunch\n  enabled: true\n  site_id: dv-site\n  api_key: cm_secret_value_123\n');
    expect(await run(['plan', p, '--check'], ctx(captureIO(), api))).toBe(2);
    expect(await run(['apply', p, '--yes'], ctx(captureIO(), api))).toBe(0);
    expect(api.calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ provider: 'cookiemunch', enabled: true, site_id: 'dv-site', api_key: 'cm_secret_value_123' });
    expect(await run(['plan', p, '--check'], ctx(captureIO(), api))).toBe(0);
  });
});
