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

describe('atlas apply --secrets-out', () => {
  const file = 'webhook_endpoints:\n  - url: https://app.example.com/hook\n    enabled_events: [user.created]\n';
  it('writes a minted secret to one 0600 file, merging existing lines, never printing it', async () => {
    const api = new Api();
    const out = join(dir, 'sub', 'dir', '.env');
    const io = captureIO();
    expect(await run(['apply', write('atlas.yaml', file), '--yes', '--secrets-out', out], ctx(io, api))).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('ATLAS_WEBHOOK_SECRET=whsec_minted');
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(io.stdout() + io.stderr()).not.toContain('whsec_minted');
    expect(io.stdout()).toContain('ATLAS_WEBHOOK_SECRET');
    writeFileSync(out, '# mine\nOTHER=1\nATLAS_WEBHOOK_SECRET=old\n');
    api.webhooks = [];
    await run(['apply', write('atlas.yaml', file), '--yes', '--secrets-out', out], ctx(captureIO(), api));
    expect(readFileSync(out, 'utf8')).toBe('# mine\nOTHER=1\nATLAS_WEBHOOK_SECRET=whsec_minted0123456789012345678901234567\n');
  });
  it('reveals (no rotation) an existing endpoint secret once, and skips it when the file has one', async () => {
    const api = new Api();
    api.webhooks = [{ id: 'we_1', url: 'https://app.example.com/hook', enabled_events: ['user.created'], active: true }];
    const out = join(dir, '.env');
    const p = write('atlas.yaml', file);
    await run(['apply', p, '--yes', '--secrets-out', out], ctx(captureIO(), api));
    expect(readFileSync(out, 'utf8')).toContain('ATLAS_WEBHOOK_SECRET=whsec_revealed');
    expect(api.calls.some((c) => c.path.endsWith('/rotate_secret'))).toBe(false);
    const reveals = () => api.calls.filter((c) => c.path.endsWith('/reveal_secret')).length;
    expect(reveals()).toBe(1);
    await run(['apply', p, '--yes', '--secrets-out', out], ctx(captureIO(), api));
    expect(reveals()).toBe(1);
  });
  it('prints the rotate command for an existing OAuth client instead of rotating', async () => {
    const api = new Api();
    api.clients = [{ id: 'oc_1', client_id: 'client_abc', name: 'Web', redirect_uris: ['https://a.example.com/cb'] }];
    const io = captureIO();
    await run(['apply', write('atlas.yaml', 'oauth_clients:\n  - name: Web\n    redirect_uris: [https://a.example.com/cb]\n'), '--yes', '--secrets-out', join(dir, '.env')], ctx(io, api));
    expect(io.stdout()).toContain('atlas client rotate client_abc');
    expect(api.calls.some((c) => c.path.includes('rotate'))).toBe(false);
  });
});
