import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryConfigStore } from '../config';
import type { ConfigHttp } from '../config-http';
import type { ManagementClient, RunContext } from '../context';
import { captureIO } from '../io';
import { run } from '../run';
import { mountEndpoints } from './project-commands';

type Call = { method: string; path: string; body?: unknown };
class Api implements ConfigHttp {
  calls: Call[] = [];
  webhooks: Array<Record<string, unknown>> = [];
  email: Record<string, unknown> | null = null;
  async get<T>(path: string): Promise<T> {
    if (path === '/v1/webhook_endpoints') return { data: this.webhooks } as T;
    if (path === '/v1/messaging_providers/email') return (this.email ?? { configured: false }) as T;
    return { data: [] } as T;
  }
  async post<T>(path: string, body: unknown): Promise<T> {
    if (path.includes('dry_run=true')) return {} as T;
    this.calls.push({ method: 'POST', path, body });
    if (path === '/v1/webhook_endpoints') return { id: 'we_new', secret: 'whsec_minted0123456789012345678901234567' } as T;
    return {} as T;
  }
  async put<T>(path: string, body: unknown): Promise<T> {
    if (path.includes('dry_run=true')) return {} as T;
    this.calls.push({ method: 'PUT', path, body });
    return {} as T;
  }
  async patch<T>(path: string, body: unknown): Promise<T> {
    if (path.includes('dry_run=true')) return {} as T;
    this.calls.push({ method: 'PATCH', path, body });
    return {} as T;
  }
  async delete(path: string): Promise<void> {
    this.calls.push({ method: 'DELETE', path });
  }
}
const ctx = (io: ReturnType<typeof captureIO>, api: ConfigHttp): RunContext => ({
  io,
  env: {},
  config: new MemoryConfigStore({ active_profile: 'default', profiles: { default: { api_url: 'https://api.test', secret_key: 'sk_test_123456' } } }),
  prompt: { text: async () => '', secret: async () => '' },
  readFile: (p) => readFileSync(p, 'utf8'),
  makeClient: () => ({}) as unknown as ManagementClient,
  makeHttp: () => api,
});
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-golive-cfg-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const write = (name: string, text: string) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};
const fp = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 8);

const HOOK = 'webhook_endpoints:\n  - url: https://app.example.com/hook\n    enabled_events: ["user.created"]\n';

describe('webhook endpoint active: golive', () => {
  it('creates the endpoint inactive and says golive activates it', async () => {
    const api = new Api();
    const io = captureIO();
    expect(await run(['apply', write('a.yaml', `${HOOK}    active: golive\n`), '--yes'], ctx(io, api))).toBe(0);
    expect(api.calls.find((c) => c.path === '/v1/webhook_endpoints')?.body).toMatchObject({ active: false });
    expect(io.stdout()).toContain('created inactive; atlas golive activates it after a test delivery');
  });

  it('is never diffed against a live endpoint that golive activated', async () => {
    const api = new Api();
    api.webhooks = [{ id: 'we_1', url: 'https://app.example.com/hook', enabled_events: ['user.created'], active: true }];
    expect(await run(['plan', write('b.yaml', `${HOOK}    active: golive\n`), '--check'], ctx(captureIO(), api))).toBe(0);
  });

  it('plain active: false on an endpoint that is active warns in the plan', async () => {
    const api = new Api();
    api.webhooks = [{ id: 'we_1', url: 'https://app.example.com/hook', enabled_events: ['user.created'], active: true }];
    const io = captureIO();
    await run(['plan', write('c.yaml', `${HOOK}    active: false\n`)], ctx(io, api));
    expect(io.stdout()).toContain('Write active: golive');
  });

  it('refuses an unknown active value', async () => {
    const io = captureIO();
    expect(await run(['plan', write('d.yaml', `${HOOK}    active: later\n`)], ctx(io, new Api()))).toBe(1);
  });
});

describe('plan --file', () => {
  it('takes the file as a flag as well as a positional', async () => {
    const api = new Api();
    const p = write('e.yaml', HOOK);
    const io = captureIO();
    expect(await run(['plan', '--file', p], ctx(io, api))).toBe(0);
    expect(io.stdout()).toContain('webhook_endpoints');
    const clash = captureIO();
    expect(await run(['plan', p, '--file', write('f.yaml', HOOK)], ctx(clash, api))).toBe(1);
  });
});

describe('email_provider secret fingerprints', () => {
  const doc = (key: string) => `email_provider:\n  transport: resend\n  from_address: noreply@example.com\n  config:\n    api_key: ${key}\n`;
  const live = (fps?: Record<string, string>) => ({
    configured: true,
    transport: 'resend',
    from_address: 'noreply@example.com',
    config: {},
    secrets_set: ['api_key'],
    ...(fps ? { secret_fingerprints: fps } : {}),
  });

  it('says nothing when the fingerprint matches', async () => {
    const api = new Api();
    api.email = live({ api_key: fp('re_same_key_value') });
    const io = captureIO();
    expect(await run(['plan', write('g.yaml', doc('re_same_key_value')), '--check'], ctx(io, api))).toBe(0);
    expect(io.stdout()).not.toContain('Atlas does not return this value');
  });

  it('shows a differing key as a change that apply sends, without --rotate-secret', async () => {
    const api = new Api();
    api.email = live({ api_key: fp('re_old_key_value') });
    const io = captureIO();
    expect(await run(['apply', write('h.yaml', doc('re_new_key_value')), '--yes'], ctx(io, api))).toBe(0);
    expect(io.stdout()).toContain(`config.api_key: …${fp('re_old_key_value')} -> …${fp('re_new_key_value')}`);
    expect(io.stdout()).not.toContain('re_new_key_value');
    expect(api.calls.find((c) => c.method === 'PUT' && c.path === '/v1/messaging_providers/email')?.body).toMatchObject({ config: { api_key: 're_new_key_value' } });
  });

  it('keeps the old note when the server returns no fingerprint', async () => {
    const api = new Api();
    api.email = live();
    const io = captureIO();
    await run(['plan', write('i.yaml', doc('re_any_key_value'))], ctx(io, api));
    expect(io.stdout()).toContain('Atlas does not return this value');
  });
});

describe('mountEndpoints', () => {
  it('points discovery and keys at a mount issuer and keeps the Frontend API host as the previous issuer', () => {
    const pub: Record<string, string> = {
      ATLAS_ISSUER: 'https://app.example.com/atlas',
      ATLAS_FRONTEND_API: 'https://acme-fapi.atlasauth.net',
      ATLAS_JWKS_URI: 'https://acme-fapi.atlasauth.net/.well-known/jwks.json',
      ATLAS_DISCOVERY_URL: 'https://acme-fapi.atlasauth.net/.well-known/openid-configuration',
    };
    mountEndpoints(pub);
    expect(pub.ATLAS_JWKS_URI).toBe('https://app.example.com/atlas/.well-known/jwks.json');
    expect(pub.ATLAS_DISCOVERY_URL).toBe('https://app.example.com/atlas/.well-known/openid-configuration');
    expect(pub.ATLAS_PREVIOUS_ISSUERS).toBe('https://acme-fapi.atlasauth.net');
  });

  it('leaves an issuer that is the Frontend API host alone', () => {
    const pub: Record<string, string> = { ATLAS_ISSUER: 'https://x-fapi.atlasauth.net', ATLAS_FRONTEND_API: 'https://x-fapi.atlasauth.net' };
    mountEndpoints(pub);
    expect(pub.ATLAS_PREVIOUS_ISSUERS).toBeUndefined();
  });
});
