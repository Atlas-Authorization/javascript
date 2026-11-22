import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtlasApiError } from '@atlasauth/backend';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryConfigStore } from '../config';
import type { ConfigHttp } from '../config-http';
import type { ManagementClient, RunContext } from '../context';
import { captureIO } from '../io';
import { run } from '../run';

/** Answers lists from `answers` (an empty list otherwise) and records every write that is not a dry run. */
class Api implements ConfigHttp {
  writes: Array<{ method: string; path: string; body: unknown }> = [];
  constructor(private answers: Record<string, unknown> = {}) {}
  async get<T>(path: string): Promise<T> {
    if (path in this.answers) return this.answers[path] as T;
    if (path === '/v1/instance' || path === '/v1/branding') return {} as T;
    if (path.startsWith('/v1/')) return { data: [] } as T;
    throw new AtlasApiError(404, [{ code: 'NOT_FOUND', message: path }]);
  }
  private write<T>(method: string, path: string, body: unknown): T {
    if (!path.includes('dry_run=true')) this.writes.push({ method, path, body });
    return {} as T;
  }
  async post<T>(path: string, body: unknown): Promise<T> {
    return this.write('POST', path, body);
  }
  async put<T>(path: string, body: unknown): Promise<T> {
    return this.write('PUT', path, body);
  }
  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.write('PATCH', path, body);
  }
  async delete(path: string): Promise<void> {
    this.write('DELETE', path, undefined);
  }
}

const ctx = (io: ReturnType<typeof captureIO>, api: ConfigHttp): RunContext => ({
  io,
  env: {},
  config: new MemoryConfigStore({ active_profile: 'default', profiles: { default: { api_url: 'https://api.test', secret_key: 'sk_test_123456' } } }),
  prompt: { text: async () => '', secret: async () => '' },
  readFile: (path) => readFileSync(path, 'utf8'),
  makeClient: () => ({}) as unknown as ManagementClient,
  makeHttp: () => api,
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-v6cfg-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const file = (doc: unknown, name = 'atlas.json') => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(doc));
  return path;
};

describe('X-2: a list section never wipes the catalogue', () => {
  it('refuses a bare list, a scalar and an empty list without confirm_empty, and writes nothing', async () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ scopes: [{ name: 'a:b' }] }, /must be a mapping|scopes:/],
      [{ scopes: 'oops' }, /must be a mapping|scopes:/],
      [{ scopes: [] }, /scopes/],
      [{ scopes: { scopes: [] } }, /confirm_empty/],
      [{ scopes: { confirm_empty: true } }, /scopes:/],
    ];
    for (const [doc, message] of cases) {
      const api = new Api();
      const io = captureIO();
      expect(await run(['apply', file(doc), '--yes'], ctx(io, api)), JSON.stringify(doc)).not.toBe(0);
      expect(api.writes).toEqual([]);
      expect(io.stderr() + io.stdout()).toMatch(message);
    }
  });

  it('applies an explicit empty list only with confirm_empty, and a normal list as before', async () => {
    const api = new Api();
    expect(await run(['apply', file({ scopes: { scopes: [], confirm_empty: true } }), '--yes'], ctx(captureIO(), api))).toBe(0);
    expect(api.writes.find((w) => w.path === '/v1/instance/scopes')!.body).toEqual({ scopes: [] });
    const api2 = new Api();
    expect(await run(['apply', file({ scopes: { scopes: [{ name: 'tools:a', description: 'A' }] } }), '--yes'], ctx(captureIO(), api2))).toBe(0);
    expect(api2.writes.find((w) => w.path === '/v1/instance/scopes')!.body).toEqual({ scopes: [{ name: 'tools:a', description: 'A' }] });
  });
});

describe('X-1: unknown nested keys are refused by plan', () => {
  it('names branding.legal.<unknown> and accepts the real legal keys', async () => {
    const bad = captureIO();
    expect(await run(['plan', file({ branding: { legal: { termsUrl: 'https://example.com/t', foo: 1 } } }), '--check'], ctx(bad, new Api()))).not.toBe(0);
    expect(bad.stderr()).toContain('UNKNOWN_FIELD_VALUE branding.legal.foo');
    const ok = captureIO();
    expect(await run(['plan', file({ branding: { applicationName: 'Acme', legal: { termsUrl: 'https://example.com/t', required: true }, socialButtons: { labels: { google: 'Go' } } } }), '--check'], ctx(ok, new Api()))).toBe(2);
    expect(ok.stderr()).not.toContain('UNKNOWN_FIELD');
  });

  it('refuses an unknown key inside a map entry (audiences.<name>.<key>) and a sign-up field', async () => {
    const io = captureIO();
    expect(await run(['plan', file({ branding: { audiences: { partners: { heading: 'x', nope: 1 } }, signUpFields: [{ key: 'k', bogus: true }] } }), '--check'], ctx(io, new Api()))).not.toBe(0);
    expect(io.stderr()).toContain('branding.audiences.partners.nope');
    expect(io.stderr()).toContain('branding.signUpFields[0].bogus');
  });
});

describe('C-2: connection_provider_policies', () => {
  const live = {
    '/v1/connection_providers/policies': {
      object: 'list',
      data: [
        { object: 'connection_provider_policy', provider: 'etsy', unique_external_id: true, has_webhook_secret: true },
        { object: 'connection_provider_policy', provider: 'ebay', unique_external_id: false, has_dev_id: true },
      ],
    },
  };

  it('is clean when the file matches, never compares a secret, and --fail-on-unmanaged exits 2 for a policy the file dropped', async () => {
    const doc = { connection_provider_policies: [{ provider: 'etsy', unique_external_id: true, webhook_secret: 'secret-value' }] };
    const plain = captureIO();
    expect(await run(['plan', file(doc), '--check'], ctx(plain, new Api(live)))).toBe(0);
    expect(plain.stdout()).not.toContain('secret-value');
    expect(await run(['plan', file(doc), '--check', '--fail-on-unmanaged'], ctx(captureIO(), new Api(live)))).toBe(2);
  });

  it('creates and updates with PUT per provider, and deletes only under --prune-type', async () => {
    const api = new Api(live);
    const doc = { connection_provider_policies: [{ provider: 'etsy', unique_external_id: false }, { provider: 'wix', unique_external_id: true }] };
    expect(await run(['apply', file(doc), '--yes'], ctx(captureIO(), api))).toBe(0);
    expect(api.writes).toHaveLength(2);
    expect(api.writes).toContainEqual({ method: 'PUT', path: '/v1/connection_providers/etsy/policy', body: { unique_external_id: false } });
    expect(api.writes).toContainEqual({ method: 'PUT', path: '/v1/connection_providers/wix/policy', body: { unique_external_id: true } });
    const bare = new Api(live);
    expect(await run(['apply', file(doc, 'b.json'), '--yes', '--prune'], ctx(captureIO(), bare))).toBe(0);
    expect(bare.writes.some((w) => w.method === 'DELETE')).toBe(false);
    const pruned = new Api(live);
    expect(await run(['apply', file(doc, 'c.json'), '--yes', '--prune-type', 'connection_provider_policies'], ctx(captureIO(), pruned))).toBe(0);
    expect(pruned.writes).toContainEqual({ method: 'DELETE', path: '/v1/connection_providers/ebay/policy', body: undefined });
  });
});

describe('M-4: message_receivers', () => {
  it('sets a signing secret, leaves token providers alone and is clean once set', async () => {
    const secrets = join(dir, 's.env');
    writeFileSync(secrets, 'MG_KEY=signing-key-value\n');
    chmodSync(secrets, 0o600);
    const doc = { message_receivers: [{ provider: 'mailgun', secret: '${MG_KEY}' }, { provider: 'brevo' }] };
    const live = {
      '/v1/message_receivers': {
        object: 'list',
        data: [
          { provider: 'brevo', secret_set: false, secret_help: null },
          { provider: 'mailgun', secret_set: false, secret_help: 'Your Mailgun HTTP webhook signing key.' },
        ],
      },
    };
    const api = new Api(live);
    expect(await run(['apply', file(doc), '--yes', '--secrets-file', secrets], ctx(captureIO(), api))).toBe(0);
    expect(api.writes).toEqual([{ method: 'PUT', path: '/v1/message_receivers/mailgun', body: { secret: 'signing-key-value' } }]);

    const after = { '/v1/message_receivers': { object: 'list', data: [{ provider: 'brevo', secret_set: false, secret_help: null }, { provider: 'mailgun', secret_set: true, secret_help: 'x' }] } };
    const plan = captureIO();
    expect(await run(['plan', file(doc, 'p.json'), '--check', '--secrets-file', secrets], ctx(plan, new Api(after)))).toBe(0);
    expect(plan.stdout()).not.toContain('signing-key-value');
  });

  it('refuses a missing secret, and a secret for a provider that needs none', async () => {
    for (const entry of [{ provider: 'mailgun' }, { provider: 'brevo', secret: 'x' }]) {
      const io = captureIO();
      expect(await run(['plan', file({ message_receivers: [entry] }), '--check'], ctx(io, new Api()))).not.toBe(0);
    }
  });
});

describe('X-4: a claim template that reads external_id', () => {
  it('warns per template and prints the apply order', async () => {
    const io = captureIO();
    const doc = { jwt_templates: [{ name: 'partner', claims: { uid: '{{user.external_id}}', plan: '{{user.publicMetadata.plan}}' } }] };
    await run(['plan', file(doc), '--json'], ctx(io, new Api()));
    const json = JSON.parse(io.stdout());
    expect(json.warnings.some((w: string) => w.includes('jwt_templates') && w.includes('external_id') && w.includes('renders empty'))).toBe(true);
    expect(json.warnings.filter((w: string) => w.includes('plan')).length).toBe(0);
    expect(json.apply_order.indexOf('instance')).toBeLessThan(json.apply_order.indexOf('jwt_templates'));
  });
});

describe('X-1: what was deleted or changed by hand shows as drift', () => {
  const declared = {
    oauth_providers: [{ provider: 'google', mode: 'redirect', values: { client_id: 'abc', client_secret: 'shh' } }],
    oauth_clients: [{ name: 'Introspector', redirect_uris: ['https://app.example.com/cb'] }],
    webhook_endpoints: [{ url: 'https://app.example.com/hook', enabled_events: ['user.created'], active: false }],
  };

  it('a declared provider and client deleted live plan as creates, and a webhook switched on live plans as an update with a warning', async () => {
    const api = new Api({ '/v1/webhook_endpoints': { data: [{ id: 'we_1', url: 'https://app.example.com/hook', enabled_events: ['user.created'], active: true }] } });
    const io = captureIO();
    expect(await run(['plan', file(declared), '--check', '--json'], ctx(io, api))).toBe(2);
    const json = JSON.parse(io.stdout());
    const actions = json.changes.map((c: { type: string; action: string }) => `${c.type}:${c.action}`).sort();
    expect(actions).toEqual(['oauth_clients:create', 'oauth_providers:create', 'webhook_endpoints:update']);
    expect(json.warnings.join(' ')).toContain('active: false');
    expect(JSON.stringify(json)).not.toContain('shh');
  });
});
