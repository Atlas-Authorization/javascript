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

/**
 * A fake API that behaves like the real one for the surfaces `atlas plan` /
 * `apply` touch: it fills server defaults on create, returns more fields than
 * the file set, keeps origin hints in auth_config, never returns a secret, and
 * (optionally) refuses to enable a hook whose test fails.
 */
class FakeApi implements ConfigHttp {
  writes: Array<{ method: string; path: string; body: unknown }> = [];
  origins: string[] = [];
  hints: Record<string, string> = {};
  authConfig: Record<string, unknown> = { session: { idle_ms: 1000 }, password: { min_length: 8 } };
  clients: Array<Record<string, unknown>> = [];
  webhooks: Array<Record<string, unknown>> = [];
  email: Record<string, unknown> | null = null;
  hook: Record<string, unknown> = { url: null, enabled: false, timeout_ms: 3000, fail_closed: false, signing_secret_set: false };
  branding: Record<string, unknown> = {};
  hookTestFails = false;

  async get<T>(path: string): Promise<T> {
    if (path === '/v1/instance') {
      return {
        allowed_origins: this.origins,
        allowed_origin_integrations: this.hints,
        auth_config: { ...this.authConfig, ...(Object.keys(this.hints).length ? { originIntegrations: this.hints } : {}) },
      } as T;
    }
    if (path === '/v1/oauth_clients') return { data: this.clients } as T;
    if (path === '/v1/webhook_endpoints') return { data: this.webhooks } as T;
    if (path === '/v1/messaging_providers/email') {
      return (this.email ?? { object: 'messaging_provider', configured: false, channel: 'email' }) as T;
    }
    if (path === '/v1/instance/hooks/before_user_create') return { object: 'before_user_create_hook', last_call: null, ...this.hook } as T;
    if (path === '/v1/branding') return { object: 'branding', ...this.branding, resolved: { applicationName: 'x', theme: 'auto' } } as T;
    if (path.startsWith('/v1/')) return { data: [] } as T;
    throw new AtlasApiError(404, [{ code: 'NOT_FOUND', message: path }]);
  }
  async post<T>(path: string, body: unknown): Promise<T> {
    this.writes.push({ method: 'POST', path, body });
    const b = body as Record<string, unknown>;
    if (path === '/v1/oauth_clients') {
      // The server fills defaults and adds fields the file never set.
      this.clients.push({
        id: `oc_${this.clients.length}`, client_id: 'cid', secret_prefix: 'abc', is_public: false, disabled: false, require_pkce: true,
        post_logout_redirect_uris: [], backchannel_logout_session_required: false, skip_logout_confirmation: false,
        refresh_touches_session: false, require_verified_email: false, login_url: null, subject_type: 'public',
        created_at: 1, ...b,
      });
    }
    if (path === '/v1/webhook_endpoints') {
      this.webhooks.push({ id: `we_${this.webhooks.length}`, active: true, secret: undefined, ...b });
    }
    return {} as T;
  }
  async put<T>(path: string, body: unknown): Promise<T> {
    this.writes.push({ method: 'PUT', path, body });
    if (path === '/v1/messaging_providers/email') {
      const { config = {}, ...rest } = body as { config?: Record<string, string> };
      const secrets = Object.keys(config).filter((k) => /key|secret/.test(k));
      this.email = {
        object: 'messaging_provider', configured: true, channel: 'email', mode: 'standard', status: 'active', ...rest,
        config: Object.fromEntries(Object.entries(config).filter(([k]) => !secrets.includes(k))),
        secrets_set: Object.fromEntries(secrets.map((k) => [k, true])),
      };
    }
    return {} as T;
  }
  async patch<T>(path: string, body: unknown): Promise<T> {
    this.writes.push({ method: 'PATCH', path, body });
    const b = body as Record<string, unknown>;
    if (path === '/v1/instance') {
      if (b.allowed_origins) {
        const entries = b.allowed_origins as Array<string | { origin: string; integration: string }>;
        this.origins = entries.map((e) => (typeof e === 'string' ? e : e.origin));
        this.hints = {};
        for (const e of entries) if (typeof e !== 'string') this.hints[e.origin] = e.integration;
      }
      const { originIntegrations, ...rest } = (b.auth_config ?? {}) as Record<string, unknown>;
      void originIntegrations;
      this.authConfig = rest;
    } else if (path.startsWith('/v1/oauth_clients/')) {
      Object.assign(this.clients.find((c) => path.endsWith(String(c.id)))!, b);
    } else if (path.startsWith('/v1/instance/hooks/before_user_create')) {
      if (b.enabled === true && this.hookTestFails && !path.includes('force=true')) {
        throw new AtlasApiError(409, [{ code: 'HOOK_TEST_FAILED', message: 'Hook test failed: 404 from https://app.example.com/hook' }]);
      }
      const { signing_secret, ...rest } = b;
      this.hook = { ...this.hook, ...rest, ...(signing_secret ? { signing_secret_set: true } : {}) };
    } else if (path === '/v1/branding') {
      this.branding = { ...this.branding, ...b };
    }
    return {} as T;
  }
  async delete(path: string): Promise<void> {
    this.writes.push({ method: 'DELETE', path, body: undefined });
  }
}

const ctx = (io: ReturnType<typeof captureIO>, api: ConfigHttp, env: NodeJS.ProcessEnv = {}): RunContext => ({
  io,
  env,
  config: new MemoryConfigStore({ active_profile: 'default', profiles: { default: { api_url: 'https://api.test', secret_key: 'sk_test_123456' } } }),
  prompt: { text: async () => '', secret: async () => '' },
  readFile: (path) => readFileSync(path, 'utf8'),
  makeClient: () => ({}) as unknown as ManagementClient,
  makeHttp: () => api,
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-drift-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const file = (doc: unknown, name = 'atlas.json') => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(doc));
  return path;
};

const clientFile = {
  instance: {
    allowed_origins: [{ origin: 'https://app.example.com', integration: 'cookiemunch' }, 'https://www.example.com'],
    auth_config: { session: { idle_ms: 1000 } },
  },
  oauth_clients: [
    {
      name: 'Web',
      redirect_uris: ['https://app.example.com/cb'],
      post_logout_redirect_uris: ['https://app.example.com/bye'],
      backchannel_logout_uri: 'https://app.example.com/bcl',
      backchannel_logout_session_required: true,
      require_verified_email: true,
      refresh_touches_session: true,
      login_url: 'https://app.example.com/login',
    },
  ],
};

describe('atlas plan drift (apply then plan --check)', () => {
  it('exits 0 right after apply: logout URIs, require_verified_email, object-form origins, keys the file leaves unset', async () => {
    const api = new FakeApi();
    const path = file(clientFile);
    expect(await run(['apply', path, '--yes'], ctx(captureIO(), api))).toBe(0);
    const io = captureIO();
    expect(await run(['plan', path, '--check'], ctx(io, api))).toBe(0);
    expect(io.stdout()).toContain('No drift');
    // The client is created with every field the file set.
    const create = api.writes.find((w) => w.path === '/v1/oauth_clients')!.body as Record<string, unknown>;
    expect(create.post_logout_redirect_uris).toEqual(['https://app.example.com/bye']);
    expect(create.require_verified_email).toBe(true);
    expect(create.backchannel_logout_uri).toBe('https://app.example.com/bcl');
  });

  it('plain-string origins and object-form origins compare as the same set, ignoring auth_config.originIntegrations', async () => {
    const api = new FakeApi();
    api.origins = ['https://app.example.com'];
    api.hints = { 'https://app.example.com': 'cookiemunch' };
    api.authConfig = { session: { idle_ms: 1000 } };
    const asStrings = file({ instance: { allowed_origins: ['https://app.example.com'] } }, 'a.json');
    const asObjects = file({ instance: { allowed_origins: [{ origin: 'https://app.example.com', integration: 'cookiemunch' }], auth_config: { originIntegrations: { 'https://app.example.com': 'cookiemunch' } } } }, 'b.json');
    expect(await run(['plan', asStrings, '--check'], ctx(captureIO(), api))).toBe(0);
    expect(await run(['plan', asObjects, '--check'], ctx(captureIO(), api))).toBe(0);
    const wrongHint = file({ instance: { allowed_origins: [{ origin: 'https://app.example.com', integration: 'other' }] } }, 'c.json');
    expect(await run(['plan', wrongHint, '--check'], ctx(captureIO(), api))).toBe(2);
  });

  it('applying a plain-string origin list keeps the live integration hint', async () => {
    const api = new FakeApi();
    api.origins = ['https://app.example.com'];
    api.hints = { 'https://app.example.com': 'cookiemunch' };
    await run(['apply', file({ instance: { allowed_origins: ['https://app.example.com', 'https://b.example.com'] } }), '--yes'], ctx(captureIO(), api));
    expect(api.hints).toEqual({ 'https://app.example.com': 'cookiemunch' });
    expect(api.origins).toHaveLength(2);
  });

  it('without --prune a key the file leaves out is not drift; a key it sets is; --prune shows unset keys', async () => {
    const api = new FakeApi();
    await run(['apply', file(clientFile), '--yes'], ctx(captureIO(), api));
    api.authConfig = { session: { idle_ms: 1000, extra: true }, password: { min_length: 8 } };
    const path = file({ instance: { auth_config: { session: { idle_ms: 1000 } } } }, 'partial.json');
    expect(await run(['plan', path, '--check'], ctx(captureIO(), api))).toBe(0);
    const io = captureIO();
    expect(await run(['plan', path, '--check', '--prune'], ctx(io, api))).toBe(2);
    expect(io.stdout()).toContain('auth_config.password');
    expect(io.stdout()).toContain('(unset)');
    const changed = file({ instance: { auth_config: { session: { idle_ms: 5 } } } }, 'changed.json');
    expect(await run(['plan', changed, '--check'], ctx(captureIO(), api))).toBe(2);
  });

  it('export -> apply -> plan --check exits 0 (new instance), with hints, clients, hook, email and branding', async () => {
    const src = new FakeApi();
    await run(['apply', file(clientFile), '--yes'], ctx(captureIO(), src));
    src.email = { object: 'messaging_provider', configured: true, channel: 'email', transport: 'brevo', from_address: 'a@example.com', mode: 'standard', config: {}, secrets_set: { api_key: true } };
    src.hook = { url: 'https://app.example.com/h', enabled: false, timeout_ms: 2000, fail_closed: true, signing_secret_set: true };
    src.branding = { applicationName: 'Acme' };
    const out = join(dir, 'export');
    expect(await run(['config', 'export', '--dir', out], ctx(captureIO(), src))).toBe(0);
    const exported = readFileSync(join(out, 'email_provider.json'), 'utf8') + readFileSync(join(out, 'hooks.json'), 'utf8');
    expect(exported).not.toMatch(/xkeysib|secret set|signing_secret|api_key/);

    const dst = new FakeApi();
    // Secrets are not exported, so a copy to a new instance supplies them by placeholder; here the
    // secrets live only on the source, and the export carries "(secret set)" markers.
    expect(await run(['config', 'import', '--dir', out], ctx(captureIO(), dst))).toBe(0);
    expect(await run(['config', 'plan', '--dir', out, '--check'], ctx(captureIO(), dst))).toBe(0);
    expect(await run(['config', 'plan', '--dir', out, '--check'], ctx(captureIO(), src))).toBe(0);
  });
});

describe('email_provider, hooks.before_user_create, branding', () => {
  const sections = {
    email_provider: { transport: 'brevo', from_address: 'login@example.com', config: { api_key: '${BREVO_API_KEY}' } },
    hooks: { before_user_create: { url: 'https://app.example.com/hook', timeout_ms: 3000, fail_closed: true, enabled: false, signing_secret: '${HOOK_SECRET}' } },
    branding: { applicationName: 'Acme', theme: 'dark' },
  };
  const secretsFile = () => {
    const p = join(dir, 'secrets.env');
    writeFileSync(p, 'BREVO_API_KEY=xkeysib-123\nHOOK_SECRET=whsec_abc\n');
    chmodSync(p, 0o600);
    return p;
  };

  it('a file of only those sections applies on an empty instance, in order, and re-plans clean without echoing a secret', async () => {
    const api = new FakeApi();
    const io = captureIO();
    expect(await run(['apply', file(sections), '--yes', '--secrets-file', secretsFile()], ctx(io, api))).toBe(0);
    const order = api.writes.map((w) => w.path);
    expect(order).toEqual(['/v1/messaging_providers/email', '/v1/instance/hooks/before_user_create', '/v1/branding']);
    expect(api.writes[0]!.body).toMatchObject({ config: { api_key: 'xkeysib-123' } });
    expect(api.writes[1]!.body).toMatchObject({ signing_secret: 'whsec_abc', fail_closed: true, enabled: false });
    expect(io.stdout()).not.toMatch(/xkeysib-123|whsec_abc/);

    const plan = captureIO();
    expect(await run(['plan', file(sections), '--check', '--secrets-file', secretsFile()], ctx(plan, api))).toBe(0);
    expect(plan.stdout() + plan.stderr()).not.toMatch(/xkeysib-123|whsec_abc/);
  });

  it('plan never prints a secret value; an unresolved ${VAR} still blocks apply', async () => {
    const api = new FakeApi();
    const io = captureIO();
    expect(await run(['plan', file(sections), '--secrets-file', secretsFile()], ctx(io, api))).toBe(0);
    const text = io.stdout();
    expect(text).not.toMatch(/xkeysib-123|whsec_abc/);
    expect(await run(['apply', file(sections), '--yes'], ctx(captureIO(), api))).toBe(1);
    expect(api.writes).toEqual([]);
  });

  it('shows drift when the live hook differs and planning branding compares only the keys set', async () => {
    const api = new FakeApi();
    await run(['apply', file(sections), '--yes', '--secrets-file', secretsFile()], ctx(captureIO(), api));
    api.hook = { ...api.hook, fail_closed: false };
    api.branding = { ...api.branding, colorPrimary: '#fff' };
    const io = captureIO();
    expect(await run(['plan', file(sections), '--check', '--secrets-file', secretsFile()], ctx(io, api))).toBe(2);
    expect(io.stdout()).toContain('before_user_create.fail_closed: false -> true');
    expect(io.stdout()).not.toContain('colorPrimary');
  });

  it('surfaces 409 HOOK_TEST_FAILED clearly and --force-hook passes force=true', async () => {
    const api = new FakeApi();
    api.hookTestFails = true;
    const enable = file({ hooks: { before_user_create: { url: 'https://app.example.com/hook', enabled: true } } });
    const refused = captureIO();
    expect(await run(['apply', enable, '--yes'], ctx(refused, api))).toBe(1);
    expect(refused.stderr()).toMatch(/HOOK_TEST_FAILED[\s\S]*--force-hook/);
    expect(api.hook.enabled).toBe(false);

    expect(await run(['apply', enable, '--yes', '--force-hook'], ctx(captureIO(), api))).toBe(0);
    expect(api.writes.at(-1)!.path).toBe('/v1/instance/hooks/before_user_create?force=true');
    expect(api.hook.enabled).toBe(true);
  });
});

describe('webhook_endpoints[].active', () => {
  it('is sent on create, so a paused endpoint is never live; a second apply and a plan are no-ops', async () => {
    const api = new FakeApi();
    const path = file({ webhook_endpoints: [{ url: 'https://app.example.com/hook', enabled_events: ['user.created'], active: false }] });
    expect(await run(['apply', path, '--yes'], ctx(captureIO(), api))).toBe(0);
    expect(api.writes[0]!.body).toMatchObject({ active: false });
    expect(api.webhooks[0]!.active).toBe(false);
    api.writes = [];
    expect(await run(['apply', path, '--yes'], ctx(captureIO(), api))).toBe(0);
    expect(api.writes).toEqual([]);
    expect(await run(['plan', path, '--check'], ctx(captureIO(), api))).toBe(0);
  });

  it('plan shows a paused file against a live endpoint as an active change', async () => {
    const api = new FakeApi();
    api.webhooks = [{ id: 'we_1', url: 'https://app.example.com/hook', enabled_events: ['user.created'], active: true }];
    const io = captureIO();
    const path = file({ webhook_endpoints: [{ url: 'https://app.example.com/hook', enabled_events: ['user.created'], active: false }] });
    expect(await run(['plan', path, '--check'], ctx(io, api))).toBe(2);
    expect(io.stdout()).toContain('active: true -> false');
  });
});

describe('explicit null clears a nullable field; an absent key is unmanaged', () => {
  const withUrls = {
    oauth_clients: [{ name: 'Web', redirect_uris: ['https://app.example.com/cb'], login_url: 'https://app.example.com/login', logo_url: 'https://app.example.com/l.png' }],
  };

  it('oauth_clients: null sends null on PATCH, plan shows value -> null, then plan --check is clean', async () => {
    const api = new FakeApi();
    await run(['apply', file(withUrls), '--yes'], ctx(captureIO(), api));
    const cleared = file({ oauth_clients: [{ name: 'Web', redirect_uris: ['https://app.example.com/cb'], login_url: null }] }, 'cleared.json');
    const io = captureIO();
    expect(await run(['plan', cleared, '--check'], ctx(io, api))).toBe(2);
    expect(io.stdout()).toContain('login_url: "https://app.example.com/login" -> null');
    await run(['apply', cleared, '--yes'], ctx(captureIO(), api));
    const patch = api.writes.filter((w) => w.method === 'PATCH' && w.path.startsWith('/v1/oauth_clients/')).pop()!;
    expect((patch.body as Record<string, unknown>).login_url).toBeNull();
    expect(await run(['plan', cleared, '--check'], ctx(captureIO(), api))).toBe(0);
  });

  it('an absent key is left unmanaged: no PATCH field, no drift', async () => {
    const api = new FakeApi();
    await run(['apply', file(withUrls), '--yes'], ctx(captureIO(), api));
    const absent = file({ oauth_clients: [{ name: 'Web', redirect_uris: ['https://app.example.com/cb'], logo_url: 'https://app.example.com/other.png' }] }, 'absent.json');
    await run(['apply', absent, '--yes'], ctx(captureIO(), api));
    const patch = api.writes.filter((w) => w.method === 'PATCH' && w.path.startsWith('/v1/oauth_clients/')).pop()!;
    expect(patch.body).not.toHaveProperty('login_url');
    expect(await run(['plan', absent, '--check'], ctx(captureIO(), api))).toBe(0);
  });

  it('branding and hook url: null clears them, and a null-only section against nothing live is clean', async () => {
    const api = new FakeApi();
    expect(await run(['plan', file({ branding: { logoUrl: null } }, 'b0.json'), '--check'], ctx(captureIO(), api))).toBe(0);
    await run(['apply', file({ branding: { logoUrl: 'https://example.com/l.png', colorPrimary: '#000' } }, 'b1.json'), '--yes'], ctx(captureIO(), api));
    const clear = file({ branding: { logoUrl: null } }, 'b2.json');
    const io = captureIO();
    expect(await run(['plan', clear, '--check'], ctx(io, api))).toBe(2);
    expect(io.stdout()).toContain('logoUrl');
    await run(['apply', clear, '--yes'], ctx(captureIO(), api));
    const patch = api.writes.filter((w) => w.method === 'PATCH' && w.path === '/v1/branding').pop()!;
    expect((patch.body as Record<string, unknown>).logoUrl).toBeNull();
    expect(await run(['plan', clear, '--check'], ctx(captureIO(), api))).toBe(0);
  });
});
