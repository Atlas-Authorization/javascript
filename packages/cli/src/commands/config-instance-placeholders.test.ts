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

describe('${instance.*} placeholders', () => {
  const doc = 'redirect_urls:\n  - url: ${instance.frontend_api_url}/cb\n  - url: https://${instance.fapi_host}/x\n';
  it('resolves from the instance and is not drift once applied', async () => {
    const api = new Api();
    const p = write('atlas.yaml', doc);
    const io = captureIO();
    expect(await run(['apply', p, '--yes'], ctx(io, api))).toBe(0);
    const urls = api.calls.filter((c) => c.path === '/v1/redirect_urls' && c.method === 'POST').map((c) => (c.body as { url: string }).url);
    expect(urls).toEqual(['https://acme-fapi.example.net/cb', 'https://acme-fapi.example.net/x']);
    api.redirects = urls.map((url, i) => ({ id: `r${i}`, url }));
    expect(await run(['plan', p, '--check'], ctx(captureIO(), api))).toBe(0);
    expect(api.calls.filter((c) => c.method === 'GET' && c.path === '/v1/instance').length).toBeGreaterThan(0);
  });
  it('does not read the instance when no placeholder is used', async () => {
    const api = new Api();
    await run(['plan', write('a.yaml', 'redirect_urls:\n  - url: https://a.example.com/cb\n')], ctx(captureIO(), api));
    expect(api.calls.some((c) => c.path === '/v1/instance')).toBe(false);
  });
  it('rejects an unknown name and lists the allowed ones', async () => {
    const io = captureIO();
    expect(await run(['plan', write('b.yaml', 'redirect_urls:\n  - url: ${instance.nope}\n')], ctx(io, new Api()))).toBe(1);
    expect(io.stderr()).toContain('${instance.fapi_host}');
    expect(io.stderr()).toContain('${instance.nope}');
  });
});
