import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtlasApiError } from '@atlasauth/backend';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryConfigStore } from '../config';
import type { ConfigHttp } from '../config-http';
import type { ManagementClient, RunContext } from '../context';
import { captureIO, type CaptureIO } from '../io';
import { run } from '../run';

/**
 * An in-memory stand-in for the Atlas management API. It answers every GET the
 * registry lists against, records every write, and mutates its own collections
 * on write so a create/update is observable on a subsequent read.
 */
class MockApi implements ConfigHttp {
  writes: Array<{ method: string; path: string; body: unknown }> = [];
  constructor(private state: Record<string, unknown>) {}

  async get<T>(path: string): Promise<T> {
    if (path === '/v1/instance') return this.state.instance as T;
    if (path === '/v1/organization_settings_schema') {
      if (this.state.schema) return { schema: this.state.schema } as T;
      throw new AtlasApiError(404, [{ code: 'NOT_FOUND', message: 'none' }]);
    }
    const map: Record<string, string> = {
      '/v1/redirect_urls': 'redirect_urls',
      '/v1/oauth_clients': 'oauth_clients',
      '/v1/oauth_providers': 'oauth_providers',
      '/v1/resource_servers': 'resource_servers',
      '/v1/jwt_templates': 'jwt_templates',
      '/v1/roles': 'roles',
      '/v1/webhook_endpoints': 'webhook_endpoints',
      '/v1/sso_connections': 'sso_connections',
      '/v1/billing/plans': 'billing_plans',
      '/v1/notification_templates': 'notification_templates',
      '/v1/email_templates': 'email_templates',
      '/v1/organizations': 'organizations',
    };
    const key = map[path];
    if (key) return { data: (this.state[key] as unknown[]) ?? [] } as T;
    throw new AtlasApiError(404, [{ code: 'NOT_FOUND', message: `no route ${path}` }]);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    this.writes.push({ method: 'POST', path, body });
    if (path === '/v1/redirect_urls') {
      const url = (body as { url: string }).url;
      (this.state.redirect_urls as unknown[]).push({ id: `rurl_${url}`, url });
    }
    return {} as T;
  }
  async put<T>(path: string, body: unknown): Promise<T> {
    this.writes.push({ method: 'PUT', path, body });
    return {} as T;
  }
  async patch<T>(path: string, body: unknown): Promise<T> {
    this.writes.push({ method: 'PATCH', path, body });
    return {} as T;
  }
  async delete(path: string): Promise<void> {
    this.writes.push({ method: 'DELETE', path, body: undefined });
  }
}

/** A representative live config: a mix of singletons and keyed collections. */
function seedState(): Record<string, unknown> {
  return {
    instance: {
      allowed_origins: ['https://app.example.com'],
      auth_config: { session: { idle_ms: 1000 }, password: { min_length: 8 } },
    },
    redirect_urls: [
      { id: 'rurl_1', url: 'https://app.example.com/cb' },
      { id: 'rurl_2', url: 'https://app.example.com/cb2' },
    ],
    oauth_clients: [
      {
        id: 'oc_1',
        client_id: 'cid_1',
        name: 'Web App',
        redirect_uris: ['https://app.example.com/cb'],
        allowed_scopes: ['openid', 'profile'],
        grant_types: ['authorization_code'],
        token_endpoint_auth_method: 'client_secret_basic',
        logo_url: null,
        first_party: true,
        // SECRET — must never be exported.
        client_secret: 'sk_super_secret_value',
      },
    ],
    roles: [
      { id: 'role_1', key: 'editor', name: 'Editor', description: 'Edits', permissions: ['posts:write'], is_system: false },
      { id: 'role_sys', key: 'admin', name: 'Admin', is_system: true, permissions: [] },
    ],
    jwt_templates: [{ name: 'default', claims: { role: '{{user.role}}' } }],
    webhook_endpoints: [
      {
        id: 'we_1',
        url: 'https://hooks.example.com/atlas',
        enabled_events: ['user.created'],
        active: true,
        // SECRET — must never be exported.
        secret: 'whsec_super_secret',
      },
    ],
    resource_servers: [
      {
        id: 'rs_1',
        identifier: 'https://api.example.com',
        name: 'My API',
        scopes: [{ value: 'read', description: 'Read' }],
        token_ttl_seconds: 3600,
        signing_alg: 'RS256',
      },
    ],
    email_templates: [
      { name: 'welcome', customised: true, override: { subject: 'Hi', text: 'Welcome\naboard' } },
      { name: 'reset', customised: false, override: null },
    ],
    oauth_providers: [],
    sso_connections: [],
    billing_plans: [],
    notification_templates: [],
    organizations: [],
  };
}

function ctx(io: CaptureIO, api: ConfigHttp, env: NodeJS.ProcessEnv = {}): RunContext {
  return {
    io,
    env,
    config: new MemoryConfigStore({
      active_profile: 'default',
      profiles: { default: { api_url: 'https://api.test', secret_key: 'sk_test_123456' } },
    }),
    prompt: { text: async () => '', secret: async () => '' },
    // Config tests work on real files in a temp dir, so read them for real.
    readFile: (path) => readFileSync(path, 'utf8'),
    makeClient: () => ({}) as unknown as ManagementClient,
    makeHttp: () => api,
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-cfg-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('config export', () => {
  it('writes one deterministic file per resource type', async () => {
    const io = captureIO();
    const code = await run(['config', 'export', '--dir', dir], ctx(io, new MockApi(seedState())));
    expect(code).toBe(0);

    const files = readdirSync(dir).sort();
    expect(files).toContain('instance.json');
    expect(files).toContain('redirect_urls.json');
    expect(files).toContain('roles.json');
    // org_settings_schema has no live schema → no file.
    expect(files).not.toContain('org_settings_schema.json');

    // A second export is byte-for-byte identical.
    const dir2 = mkdtempSync(join(tmpdir(), 'atlas-cfg2-'));
    await run(['config', 'export', '--dir', dir2], ctx(captureIO(), new MockApi(seedState())));
    for (const f of files) {
      expect(readFileSync(join(dir2, f), 'utf8')).toBe(readFileSync(join(dir, f), 'utf8'));
    }
    rmSync(dir2, { recursive: true, force: true });
  });

  it('never writes a secret to disk', async () => {
    await run(['config', 'export', '--dir', dir], ctx(captureIO(), new MockApi(seedState())));
    const everything = readdirSync(dir)
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n');
    expect(everything).not.toContain('sk_super_secret_value');
    expect(everything).not.toContain('whsec_super_secret');
    // client_secret / secret KEYS are dropped entirely from the projection
    // (the token_endpoint_auth_method value "client_secret_basic" is unrelated).
    expect(everything).not.toContain('"client_secret"');
    expect(everything).not.toContain('"secret"');
  });

  it('excludes system roles and non-customised email templates', async () => {
    await run(['config', 'export', '--dir', dir], ctx(captureIO(), new MockApi(seedState())));
    const roles = readFileSync(join(dir, 'roles.json'), 'utf8');
    expect(roles).toContain('editor');
    expect(roles).not.toContain('admin'); // is_system filtered out
    const emails = readFileSync(join(dir, 'email_templates.json'), 'utf8');
    expect(emails).toContain('welcome');
    expect(emails).not.toContain('reset'); // not customised
  });
});

describe('config import', () => {
  it('a round-trip (export then import) is an empty diff that applies nothing', async () => {
    await run(['config', 'export', '--dir', dir], ctx(captureIO(), new MockApi(seedState())));

    const io = captureIO();
    const api = new MockApi(seedState());
    const code = await run(['config', 'import', '--dir', dir], ctx(io, api));
    expect(code).toBe(0);
    expect(io.stdout()).toContain('No changes to apply.');
    expect(api.writes).toEqual([]); // nothing mutated
  });

  it('--dry-run prints the plan and applies nothing', async () => {
    await run(['config', 'export', '--dir', dir], ctx(captureIO(), new MockApi(seedState())));
    // Add a redirect URL to the config files that is NOT live → a pending create.
    writeFileSync(
      join(dir, 'redirect_urls.json'),
      JSON.stringify(
        [
          { url: 'https://app.example.com/cb' },
          { url: 'https://app.example.com/cb2' },
          { url: 'https://app.example.com/new' },
        ],
        null,
        2,
      ) + '\n',
    );

    const io = captureIO();
    const api = new MockApi(seedState());
    const code = await run(['config', 'import', '--dir', dir, '--dry-run'], ctx(io, api));
    expect(code).toBe(0);
    expect(io.stdout()).toContain('dry run');
    expect(io.stdout()).toContain('+ create redirect_urls https://app.example.com/new');
    expect(api.writes).toEqual([]); // dry run touched nothing
  });

  it('applies a create for a new resource (no --dry-run)', async () => {
    await run(['config', 'export', '--dir', dir], ctx(captureIO(), new MockApi(seedState())));
    writeFileSync(
      join(dir, 'redirect_urls.json'),
      JSON.stringify(
        [{ url: 'https://app.example.com/cb' }, { url: 'https://app.example.com/cb2' }, { url: 'https://app.example.com/new' }],
        null,
        2,
      ) + '\n',
    );

    const io = captureIO();
    const api = new MockApi(seedState());
    const code = await run(['config', 'import', '--dir', dir], ctx(io, api));
    expect(code).toBe(0);
    expect(api.writes).toEqual([
      { method: 'POST', path: '/v1/redirect_urls', body: { url: 'https://app.example.com/new' } },
    ]);
    expect(io.stdout()).toContain('Applied 1 change(s).');
  });

  it('never sends signing_alg (read-only) when creating or updating a resource server', async () => {
    await run(['config', 'export', '--dir', dir], ctx(captureIO(), new MockApi(seedState())));
    const servers = JSON.parse(readFileSync(join(dir, 'resource_servers.json'), 'utf8')) as Record<string, unknown>[];
    servers.push({ identifier: 'https://api.example.com/new', name: 'New API', scopes: ['read'], signing_alg: 'RS256' });
    servers[0] = { ...servers[0], name: 'Renamed API' };
    writeFileSync(join(dir, 'resource_servers.json'), JSON.stringify(servers, null, 2) + '\n');

    const api = new MockApi(seedState());
    expect(await run(['config', 'import', '--dir', dir], ctx(captureIO(), api))).toBe(0);
    const rs = api.writes.filter((w) => w.path.startsWith('/v1/resource_servers'));
    expect(rs.length).toBe(2);
    for (const w of rs) expect(w.body).not.toHaveProperty('signing_alg');
  });

  it('does not delete a live-only resource without --prune, but does with it', async () => {
    await run(['config', 'export', '--dir', dir], ctx(captureIO(), new MockApi(seedState())));
    // Drop one redirect URL from the config → it exists live but not in config.
    writeFileSync(
      join(dir, 'redirect_urls.json'),
      JSON.stringify([{ url: 'https://app.example.com/cb' }], null, 2) + '\n',
    );

    const noPrune = captureIO();
    const api1 = new MockApi(seedState());
    await run(['config', 'import', '--dir', dir], ctx(noPrune, api1));
    expect(noPrune.stdout()).toContain('--prune to delete');
    expect(api1.writes.some((w) => w.method === 'DELETE')).toBe(false);

    const withPrune = captureIO();
    const api2 = new MockApi(seedState());
    await run(['config', 'import', '--dir', dir, '--prune'], ctx(withPrune, api2));
    expect(withPrune.stdout()).toContain('- delete redirect_urls https://app.example.com/cb2');
    expect(api2.writes).toContainEqual({
      method: 'DELETE',
      path: '/v1/redirect_urls/rurl_2',
      body: undefined,
    });
  });

  it('a resource type with no file is left untouched', async () => {
    // Only an instance file present; everything else unmanaged.
    writeFileSync(
      join(dir, 'instance.json'),
      JSON.stringify(
        {
          allowed_origins: ['https://app.example.com'],
          auth_config: { session: { idle_ms: 1000 }, password: { min_length: 8 } },
        },
        null,
        2,
      ) + '\n',
    );
    const io = captureIO();
    const api = new MockApi(seedState());
    const code = await run(['config', 'import', '--dir', dir], ctx(io, api));
    expect(code).toBe(0);
    expect(api.writes).toEqual([]); // instance matched; nothing else even looked at for writes
  });

  it('interpolates a ${ENV} placeholder from the environment at import', async () => {
    writeFileSync(
      join(dir, 'oauth_clients.json'),
      JSON.stringify([{ name: 'Web App', redirect_uris: ['https://x/y'], token_hint: '${A_TOKEN}' }], null, 2) + '\n',
    );
    const io = captureIO();
    const api = new MockApi({ ...seedState(), oauth_clients: [] });
    await run(['config', 'import', '--dir', dir], ctx(io, api, { A_TOKEN: 'injected' }));
    const create = api.writes.find((w) => w.path === '/v1/oauth_clients');
    expect(create).toBeDefined();
    expect((create!.body as { token_hint: string }).token_hint).toBe('injected');
  });

  it('errors cleanly when the directory is missing', async () => {
    const io = captureIO();
    const code = await run(['config', 'import', '--dir', join(dir, 'nope')], ctx(io, new MockApi(seedState())));
    expect(code).toBe(1);
    expect(io.stderr()).toContain('Config directory not found');
  });
});

describe('config dispatch', () => {
  it('an unknown subcommand exits non-zero with a hint', async () => {
    const io = captureIO();
    const code = await run(['config', 'frob'], ctx(io, new MockApi(seedState())));
    expect(code).toBe(1);
    expect(io.stderr()).toContain("Unknown subcommand 'config frob'");
  });

  it('rejects an invalid --format', async () => {
    const io = captureIO();
    const code = await run(['config', 'export', '--dir', dir, '--format', 'toml'], ctx(io, new MockApi(seedState())));
    expect(code).toBe(1);
    expect(io.stderr()).toContain("--format must be 'json' or 'yaml'");
  });
});
