import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtlasApiError } from '@atlasauth/backend';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryConfigStore } from '../config';
import type { ConfigHttp } from '../config-http';
import type { ManagementClient, RunContext } from '../context';
import { captureIO } from '../io';
import { run } from '../run';

/** Live answers by path; every write is recorded. Unknown paths are 404 (section not set). */
class Api implements ConfigHttp {
  writes: Array<{ method: string; path: string; body: unknown }> = [];
  constructor(private live: Record<string, unknown> = {}) {}
  async get<T>(path: string): Promise<T> {
    if (path === '/v1/instance') return { allowed_origins: [], auth_config: this.live.auth_config ?? {} } as T;
    if (path in this.live) return this.live[path] as T;
    throw new AtlasApiError(404, [{ code: 'NOT_FOUND', message: path }]);
  }
  async post<T>(path: string, body: unknown): Promise<T> { this.writes.push({ method: 'POST', path, body }); return {} as T; }
  async put<T>(path: string, body: unknown): Promise<T> { this.writes.push({ method: 'PUT', path, body }); return {} as T; }
  async patch<T>(path: string, body: unknown): Promise<T> { this.writes.push({ method: 'PATCH', path, body }); return {} as T; }
  async delete(path: string): Promise<void> { this.writes.push({ method: 'DELETE', path, body: undefined }); }
}

const ctx = (api: ConfigHttp, env: NodeJS.ProcessEnv = {}): RunContext => ({
  io: captureIO(),
  env,
  config: new MemoryConfigStore({ active_profile: 'default', profiles: { default: { api_url: 'https://api.test', secret_key: 'sk_test_123456' } } }),
  prompt: { text: async () => '', secret: async () => '' },
  readFile: (p) => readFileSync(p, 'utf8'),
  makeClient: () => ({}) as unknown as ManagementClient,
  makeHttp: () => api,
});

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'atlas-all-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const file = (doc: unknown) => { const p = join(dir, 'atlas.json'); writeFileSync(p, JSON.stringify(doc)); return p; };
const write = (api: Api, path: string) => api.writes.find((w) => w.path === path);

describe('config as code: everything', () => {
  it('applies every new section with the right call', async () => {
    const api = new Api();
    const p = file({
      hosted_pages: { sign_in_url: 'https://app.example.com/login', user_url: null },
      connection_oauth_clients: [
        { provider: 'ebay', client_id: 'inst', client_secret: '${EBAY_SECRET}' },
        { owner: { type: 'organization', id: 'org_1' }, provider: 'ebay', client_id: 'own', client_secret: 's', environment: 'sandbox' },
      ],
      migration_bridges: [{ source: 'auth0', enabled: true, preset: 'auth0', shared_secret: 'x' }],
      impersonation_policy: { require_reason: true, reason_codes: ['support'], max_duration_seconds: 900, read_only_default: true },
      connection_token_limits: { per_key: 1000, per_app: 200, providers: { ebay: 50 } },
      connection_relay_limits: { request_bytes: 524288, response_bytes: 2097152 },
    });
    expect(await run(['apply', p, '--yes'], ctx(api, { EBAY_SECRET: 'es' }))).toBe(0);
    expect(write(api, '/v1/instance/hosted_pages')).toMatchObject({ method: 'PATCH', body: { sign_in_url: 'https://app.example.com/login', user_url: null } });
    const clients = api.writes.filter((w) => w.path === '/v1/connections/oauth_clients');
    expect(clients).toHaveLength(2);
    expect(clients[0]!.body).toEqual({ provider: 'ebay', client_id: 'inst', client_secret: 'es' });
    expect((clients[1]!.body as { owner: unknown }).owner).toEqual({ type: 'organization', id: 'org_1' });
    expect(write(api, '/v1/migrations/auth0/bridge')).toMatchObject({ method: 'PUT', body: { enabled: true, preset: 'auth0', shared_secret: 'x' } });
    expect(write(api, '/v1/instance/impersonation_policy')!.body).toMatchObject({ require_reason: true, max_duration_seconds: 900 });
    expect(write(api, '/v1/connections/token_limits')!.body).toEqual({ per_key: 1000, per_app: 200, providers: { ebay: 50 } });
    expect(write(api, '/v1/connections/relay_limits')!.body).toEqual({ request_bytes: 524288, response_bytes: 2097152 });
  });

  it('is clean when live matches (secrets are not drift) and exits 2 when it differs', async () => {
    const live = {
      '/v1/instance/hosted_pages': { sign_in_url: 'https://app.example.com/login', sign_up_url: null, user_url: null },
      '/v1/connections/oauth_clients': { data: [{ id: 'cc_1', owner: { type: 'instance' }, provider: 'ebay', environment: 'production', client_id: 'inst', has_secret: true, scopes: [], host_params: {}, enabled: true }] },
      '/v1/migrations/sources': { data: [{ source: 'auth0' }, { source: 'okta' }] },
      '/v1/migrations/auth0/bridge': { source: 'auth0', enabled: true, preset: 'auth0', ends_at: Date.parse('2026-12-01T00:00:00Z'), created_at: 1 },
      '/v1/migrations/okta/bridge': { source: 'okta', enabled: false, created_at: null },
      '/v1/instance/impersonation_policy': { require_reason: true, reason_codes: ['support'], max_duration_seconds: 900 },
      '/v1/connections/token_limits': { per_key: { limit: 1000, default: 6000, used: 3 }, per_connection: { limit: 300 }, providers: { ebay: { limit: 50, used: 1 } } },
      '/v1/connections/relay_limits': { request_bytes: 524288, response_bytes: 2097152 },
    };
    const doc = {
      hosted_pages: { sign_in_url: 'https://app.example.com/login' },
      connection_oauth_clients: [{ provider: 'ebay', client_id: 'inst', client_secret: 'es' }],
      migration_bridges: [{ source: 'auth0', enabled: true, ends_at: '2026-12-01T00:00:00Z' }],
      impersonation_policy: { require_reason: true, max_duration_seconds: 900 },
      connection_token_limits: { per_key: 1000, providers: { ebay: 50 } },
      connection_relay_limits: { request_bytes: 524288 },
    };
    expect(await run(['plan', file(doc), '--check'], ctx(new Api(live)))).toBe(0);
    expect(await run(['plan', file({ ...doc, connection_token_limits: { per_key: 1001 } }), '--check'], ctx(new Api(live)))).toBe(2);
    expect(await run(['plan', file({ ...doc, impersonation_policy: { max_duration_seconds: 600 } }), '--check'], ctx(new Api(live)))).toBe(2);
  });

  it('removes a provider limit and prunes a client only under --prune; instance auth_config covers app approval and captcha flows', async () => {
    const live = {
      '/v1/connections/token_limits': { per_key: { limit: 6000 }, providers: { ebay: { limit: 50 }, etsy: { limit: 9 } } },
      '/v1/connections/oauth_clients': { data: [{ id: 'cc_9', provider: 'etsy', environment: 'production', client_id: 'x' }] },
      auth_config: { appApproval: { firstFactor: false, stepUp: false, ttlSeconds: 60 }, captcha: { flows: { signIn: { enabled: false } } } },
    };
    const api = new Api(live);
    const p = file({
      connection_token_limits: { providers: { ebay: 50 } },
      connection_oauth_clients: [],
      instance: { auth_config: { appApproval: { stepUp: true }, captcha: { flows: { signIn: { enabled: true } } } } },
    });
    expect(await run(['apply', p, '--yes', '--prune'], ctx(api))).toBe(0);
    expect(write(api, '/v1/connections/token_limits')!.body).toEqual({ providers: { ebay: 50, etsy: null } });
    expect(write(api, '/v1/connections/oauth_clients/cc_9')!.method).toBe('DELETE');
    const patch = write(api, '/v1/instance')!.body as { auth_config: { appApproval: unknown; captcha: unknown } };
    expect(patch.auth_config.appApproval).toEqual({ stepUp: true });
    expect(patch.auth_config.captcha).toEqual({ flows: { signIn: { enabled: true } } });
  });
});
