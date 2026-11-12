import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryConfigStore } from '../config';
import type { ConfigHttp } from '../config-http';
import type { ManagementClient, RunContext } from '../context';
import { captureIO } from '../io';
import { run } from '../run';

type Call = { method: string; path: string; body?: unknown };
class Api implements ConfigHttp {
  calls: Call[] = [];
  instance: Record<string, unknown> = { id: 'ins_1', frontend_api_host: 'acme-fapi.example.net', allowed_origins: [], auth_config: {} };
  siwa = false;
  webhooks: Array<Record<string, unknown>> = [];
  clients: Array<Record<string, unknown>> = [];
  redirects: Array<Record<string, unknown>> = [];
  async get<T>(path: string): Promise<T> {
    this.calls.push({ method: 'GET', path });
    if (path === '/v1/instance') return this.instance as T;
    if (path === '/v1/instance/sign_in_with_atlas') return { enabled: this.siwa } as T;
    if (path === '/v1/webhook_endpoints') return { data: this.webhooks } as T;
    if (path === '/v1/oauth_clients') return { data: this.clients } as T;
    if (path === '/v1/redirect_urls') return { data: this.redirects } as T;
    return { data: [] } as T;
  }
  async post<T>(path: string, body: unknown): Promise<T> {
    this.calls.push({ method: 'POST', path, body });
    if (path === '/v1/webhook_endpoints') return { id: 'we_new', secret: 'whsec_minted0123456789012345678901234567' } as T;
    if (path.endsWith('/reveal_secret')) return { secret: 'whsec_revealed01234567890123456789012345' } as T;
    return {} as T;
  }
  async put<T>(path: string, body: unknown): Promise<T> { this.calls.push({ method: 'PUT', path, body }); return {} as T; }
  async patch<T>(path: string, body: unknown): Promise<T> { this.calls.push({ method: 'PATCH', path, body }); return {} as T; }
  async delete(path: string): Promise<void> { this.calls.push({ method: 'DELETE', path }); }
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

describe('sign_in_with_atlas in atlas.yaml', () => {
  it('plan --check exits 2 on drift and apply PATCHes it', async () => {
    const api = new Api();
    const p = write('atlas.yaml', 'sign_in_with_atlas:\n  enabled: true\n');
    expect(await run(['plan', p, '--check'], ctx(captureIO(), api))).toBe(2);
    expect(await run(['apply', p, '--yes'], ctx(captureIO(), api))).toBe(0);
    expect(api.calls.some((c) => c.method === 'PATCH' && c.path === '/v1/instance/sign_in_with_atlas')).toBe(true);
  });
  it('apply --help lists it in the apply order', async () => {
    const io = captureIO();
    await run(['apply', '--help'], ctx(io, new Api()));
    expect(io.stdout()).toContain('sign_in_with_atlas');
    expect(io.stdout()).toMatch(/sign_in_with_atlas, signing_key_policy,/);
  });
});
