import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtlasApiError } from '@atlasauth/backend';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryConfigStore } from '../config';
import type { ConfigHttp } from '../config-http';
import type { ManagementClient, RunContext } from '../context';
import { captureIO, type CaptureIO } from '../io';
import { run } from '../run';

/**
 * `atlas init` / `preflight` / `env` / `client rotate` and the secrets-to-file
 * rule, against an in-memory Atlas: one fake that answers both the platform API
 * (psk_) and an instance's Backend API (sk_), and mutates its own state so a
 * re-run sees what the first run created.
 */

const SK = 'sk_test_instance_secret_value_0001';
const CLIENT_SECRET = 'oacs_client_secret_value_0001';
const WEBHOOK_SECRET = 'whsec_webhook_secret_value_0001';
const PROVIDER_KEY = 're_customer_own_provider_key_01';
const SECRETS = [SK, CLIENT_SECRET, WEBHOOK_SECRET, PROVIDER_KEY];

interface State {
  apps: Array<Record<string, unknown>>;
  instance: { strategies: Record<string, boolean>; issuer?: string };
  managed: null | { from_address: string; verified: boolean; records: unknown[] };
  development: boolean;
  emailProvider: null | { id: string; mode: string };
  domains: Array<Record<string, unknown>>;
  clients: Array<{ id: string; client_id: string; name: string; redirect_uris: string[] }>;
  hooks: Array<{ id: string; url: string }>;
  findings: Array<{ severity: string; code: string; message: string; fix: string }>;
  writes: Array<{ method: string; path: string; body: unknown; key: string }>;
  rotations: number;
}

function fresh(): State {
  return {
    apps: [],
    instance: { strategies: { password: true, emailCode: false, passkey: false } },
    managed: null,
    development: false,
    emailProvider: null,
    domains: [],
    clients: [],
    hooks: [],
    findings: [],
    writes: [],
    rotations: 0,
  };
}

const notFound = () => new AtlasApiError(404, [{ code: 'NOT_FOUND', message: 'not found' }]);

function fakeAtlas(state: State, key: string): ConfigHttp {
  const platform = key.startsWith('psk_');
  const record = (method: string, path: string, body: unknown) => state.writes.push({ method, path, body, key });
  return {
    async get<T>(path: string): Promise<T> {
      if (platform) {
        if (path === '/v1/platform/apps') return { data: state.apps.map(({ secret: _s, ...a }) => a) } as T;
        throw notFound();
      }
      if (key !== SK) throw new AtlasApiError(401, [{ code: 'INVALID_KEY', message: 'bad key' }]);
      switch (path) {
        case '/v1/instance':
          return {
            id: 'ins_1',
            publishable_key: 'pk_test_1',
            frontend_api_host: 'acme-fapi.atlas.test',
            issuer: state.instance.issuer,
            auth_config_resolved: { strategies: state.instance.strategies },
          } as T;
        case '/v1/messaging_providers/email/managed':
          if (!state.managed) throw notFound();
          return state.managed as T;
        case '/v1/messaging_providers':
          return { email: state.emailProvider } as T;
        case '/v1/messaging_providers/email/development':
          if (state.emailProvider?.mode !== 'development') throw notFound();
          return { from_address: 'onboarding@resend.dev', active: true } as T;
        case '/v1/domains':
          return { data: state.domains } as T;
        case '/v1/oauth_clients':
          return { data: state.clients } as T;
        case '/v1/webhook_endpoints':
          return { data: state.hooks } as T;
        case '/v1/instance/preflight':
          return { ok: !state.findings.some((f) => f.severity === 'error'), findings: state.findings } as T;
      }
      throw notFound();
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      record('POST', path, body);
      const b = (body ?? {}) as Record<string, unknown>;
      if (platform && path === '/v1/platform/apps') {
        const app = { id: 'ins_1', name: b.name, environment: b.environment, publishable_key: 'pk_test_1', frontend_api_host: 'acme-fapi.atlas.test', secret: SK };
        state.apps.push(app);
        return app as T;
      }
      if (platform && path === '/v1/platform/apps/ins_1/rotate_secret') {
        state.rotations++;
        return { secret: SK, previous_keys_expire_at: 1_900_000_000_000 } as T;
      }
      if (path === '/v1/messaging_providers/email/managed') {
        if ((b.config as { api_key?: string } | undefined)?.api_key !== PROVIDER_KEY) {
          throw new AtlasApiError(422, [{ code: 'VALIDATION_FAILED', message: 'key', param: 'config.api_key' }]);
        }
        state.emailProvider = { id: 'msgp_1', mode: 'managed_domain' };
        state.managed = {
          from_address: b.from_address as string,
          verified: false,
          records: [{ type: 'TXT', name: 'resend._domainkey.mail.acme.example', value: 'p=MIGf' }],
        };
        return state.managed as T;
      }
      if (path === '/v1/messaging_providers/email/development') {
        const viaKey = (b.config as { api_key?: string } | undefined)?.api_key === PROVIDER_KEY;
        if (!viaKey && b.provider_id !== state.emailProvider?.id) {
          throw new AtlasApiError(422, [{ code: 'VALIDATION_FAILED', message: 'key', param: 'provider_id' }]);
        }
        state.development = true;
        state.emailProvider = { id: 'msgp_1', mode: 'development' };
        return { from_address: 'onboarding@resend.dev', active: true, note: 'Resend only delivers to your account address.' } as T;
      }
      if (path === '/v1/domains') {
        const d = { host: b.host, cname_target: 'cname.atlas.test', status: 'pending', live: false };
        state.domains.push(d);
        return d as T;
      }
      if (path === '/v1/oauth_clients') {
        const c = { id: 'oc_1', client_id: 'client_abc', name: b.name as string, redirect_uris: b.redirect_uris as string[] };
        state.clients.push(c);
        return { ...c, client_secret: CLIENT_SECRET } as T;
      }
      if (path === '/v1/oauth_clients/oc_1/rotate_secret') {
        const overlap = b.overlap_seconds as number | undefined;
        return {
          id: 'oc_1',
          client_id: 'client_abc',
          client_secret: 'oacs_rotated_secret_0002',
          previous_secret_expires_at: overlap === 0 ? null : 1_800_000_000_000,
        } as T;
      }
      if (path === '/v1/webhook_endpoints') {
        const h = { id: 'whe_1', url: b.url as string };
        state.hooks.push(h);
        return { ...h, secret: WEBHOOK_SECRET } as T;
      }
      return {} as T;
    },
    async put<T>(path: string, body: unknown): Promise<T> {
      record('PUT', path, body);
      return {} as T;
    },
    async patch<T>(path: string, body: unknown): Promise<T> {
      record('PATCH', path, body);
      if (path === '/v1/instance') {
        const st = ((body as { auth_config: { strategies: Record<string, boolean> } }).auth_config.strategies);
        if ((st.emailCode || st.emailLink) && !state.development && !state.managed?.verified) {
          throw new AtlasApiError(422, [{ code: 'EMAIL_PROVIDER_REQUIRED', message: 'No email provider.' }]);
        }
        Object.assign(state.instance.strategies, st);
      }
      if (path === '/v1/oauth_clients/oc_1') {
        state.clients[0]!.redirect_uris = (body as { redirect_uris: string[] }).redirect_uris;
      }
      return {} as T;
    },
    async delete(path: string): Promise<void> {
      record('DELETE', path, undefined);
    },
  };
}

let home: string;
let state: State;

function ctxWith(io: CaptureIO, extra: Partial<RunContext> = {}): RunContext {
  return {
    io,
    env: { XDG_CONFIG_HOME: home, ATLAS_PLATFORM_KEY: 'psk_test_platform', ATLAS_API_URL: 'https://api.atlas.test' },
    config: new MemoryConfigStore(),
    prompt: { text: async () => 'y', secret: async () => '' },
    makeClient: () => ({}) as ManagementClient,
    makeHttp: ({ secretKey }) => fakeAtlas(state, secretKey),
    readFile: (path) => readFileSync(path, 'utf8'),
    ...extra,
  };
}

const mode = (p: string) => statSync(p).mode & 0o777;
const noSecrets = (io: CaptureIO) => {
  const all = `${io.stdout()}\n${io.stderr()}`;
  for (const s of SECRETS) expect(all).not.toContain(s);
};

let keyFile: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'atlas-cli-init-'));
  state = fresh();
  keyFile = join(home, 'resend.key');
  writeFileSync(keyFile, `RESEND_API_KEY=${PROVIDER_KEY}\n`, { mode: 0o600 });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const INIT_BASE = [
  'init',
  '--product', 'acme',
  '--domain', 'acme.example',
  '--strategies', 'password,email_code,passkey',
  '--client-redirect', 'https://app.acme.example/callback',
  '--webhook-url', 'https://app.acme.example/hooks/atlas',
  '--yes',
];
const INIT = () => [...INIT_BASE, '--email-provider', 'resend', '--email-key-file', keyFile];

describe('atlas init', () => {
  it('creates app, email, domain, client and webhook; writes every secret to a 0600 file and prints none', async () => {
    const io = captureIO();
    expect(await run(INIT(), ctxWith(io))).toBe(0);
    noSecrets(io);

    const dir = join(home, 'acme');
    expect(mode(dir)).toBe(0o700);
    expect(mode(join(dir, 'production.env'))).toBe(0o600);
    expect(readFileSync(join(dir, 'production.env'), 'utf8')).toContain(`ATLAS_SECRET_KEY=${SK}`);
    expect(readFileSync(join(dir, 'production-oauth-client.env'), 'utf8')).toContain(`ATLAS_CLIENT_SECRET=${CLIENT_SECRET}`);
    expect(mode(join(dir, 'production-oauth-client.env'))).toBe(0o600);
    expect(readFileSync(join(dir, 'production-webhook.env'), 'utf8')).toContain(`ATLAS_WEBHOOK_SECRET=${WEBHOOK_SECRET}`);

    // The app is created without a sibling, with the redirect origin allowed.
    expect(state.writes.find((w) => w.path === '/v1/platform/apps')?.body).toMatchObject({
      name: 'acme',
      environment: 'production',
      create_development_sibling: false,
      allowed_origins: ['https://app.acme.example'],
    });
    // Managed email from mail.<domain> on the customer's own key (read from the file), records printed.
    expect(state.managed?.from_address).toBe('noreply@mail.acme.example');
    expect(state.writes.find((w) => w.path === '/v1/messaging_providers/email/managed')?.body).toMatchObject({
      transport: 'resend',
      config: { api_key: PROVIDER_KEY },
    });
    expect(io.stdout()).toContain('resend._domainkey.mail.acme.example');
    expect(io.stdout()).toContain('CNAME auth.acme.example → cname.atlas.test');
    // Email code waits for the sender; the others are on.
    expect(state.instance.strategies).toMatchObject({ password: true, passkey: true, emailCode: false });
    expect(io.stdout()).toMatch(/Not turned on yet.*emailCode/);
    expect(state.clients[0]).toMatchObject({ name: 'acme (production)', redirect_uris: ['https://app.acme.example/callback'] });
    expect(state.writes.find((w) => w.path === '/v1/oauth_clients')?.body).toMatchObject({ first_party: true });

    // Summary: public values only; issuer derived from the Frontend API host when the API has none.
    expect(io.stdout()).toContain('pk_test_1');
    expect(io.stdout()).toContain('Issuer:            https://acme-fapi.atlas.test');
    const manifest = JSON.parse(readFileSync(join(dir, 'atlas.json'), 'utf8'));
    expect(manifest.instances.production).toMatchObject({
      instance_id: 'ins_1',
      publishable_key: 'pk_test_1',
      issuer: 'https://acme-fapi.atlas.test',
      discovery_url: 'https://acme-fapi.atlas.test/.well-known/openid-configuration',
      oauth_client: { client_id: 'client_abc' },
    });
    expect(JSON.stringify(manifest)).not.toContain(SK);
  });

  it('is idempotent: a re-run finds everything and only fills gaps', async () => {
    expect(await run(INIT(), ctxWith(captureIO()))).toBe(0);
    const writesAfterFirst = state.writes.length;
    state.instance.issuer = 'https://auth.acme.example';

    const io = captureIO();
    const again = [...INIT(), '--client-redirect', 'https://app.acme.example/callback2'];
    expect(await run(again, ctxWith(io))).toBe(0);
    noSecrets(io);
    const second = state.writes.slice(writesAfterFirst);
    // No new app, managed domain, custom domain, client or webhook.
    expect(second.filter((w) => w.method === 'POST')).toEqual([]);
    // Only the missing redirect URI is added.
    expect(second).toEqual([
      expect.objectContaining({
        method: 'PATCH',
        path: '/v1/oauth_clients/oc_1',
        body: { redirect_uris: ['https://app.acme.example/callback', 'https://app.acme.example/callback2'] },
      }),
    ]);
    expect(io.stdout()).toContain('Found app ins_1');
    // The issuer the API returns wins over the derived one.
    expect(io.stdout()).toContain('Issuer:            https://auth.acme.example');
  });

  it('refuses to create a secret over an existing, different file unless --force', async () => {
    const dir = join(home, 'acme');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'production.env'), 'ATLAS_SECRET_KEY=sk_test_someone_elses\n');
    const io = captureIO();
    expect(await run(INIT(), ctxWith(io))).toBe(1);
    expect(io.stderr()).toContain('already exists');
    expect(state.apps).toHaveLength(0);
    expect(readFileSync(join(dir, 'production.env'), 'utf8')).toContain('sk_test_someone_elses');

    expect(await run([...INIT(), '--force'], ctxWith(captureIO()))).toBe(0);
    expect(readFileSync(join(dir, 'production.env'), 'utf8')).toContain(SK);
  });

  it('an existing app whose secret file is gone needs --rotate-secret', async () => {
    state.apps.push({ id: 'ins_1', name: 'acme', environment: 'production', publishable_key: 'pk_test_1', frontend_api_host: null });
    const io = captureIO();
    expect(await run(['init', '--product', 'acme', '--yes'], ctxWith(io))).toBe(1);
    expect(io.stderr()).toContain('--rotate-secret');

    const io2 = captureIO();
    expect(await run(['init', '--product', 'acme', '--yes', '--rotate-secret'], ctxWith(io2))).toBe(0);
    expect(state.rotations).toBe(1);
    noSecrets(io2);
    expect(readFileSync(join(home, 'acme', 'production.env'), 'utf8')).toContain(SK);
  });

  it('uses the development sender with the customer key (read from stdin), and turns on email code', async () => {
    const io = captureIO();
    const reads: string[] = [];
    const ctx = ctxWith(io, {
      readFile: (path) => {
        reads.push(path);
        return `${PROVIDER_KEY}\n`;
      },
    });
    const code = await run(
      ['init', '--product', 'acme', '--instance-env', 'development', '--email', 'development', '--email-provider', 'resend', '--email-key-file', '-', '--strategies', 'email_code', '--yes'],
      ctx,
    );
    expect(code).toBe(0);
    expect(reads).toEqual(['/dev/stdin']);
    noSecrets(io);
    expect(state.development).toBe(true);
    expect(state.instance.strategies.emailCode).toBe(true);
    expect(io.stdout()).toContain('onboarding@resend.dev');
    expect(readFileSync(join(home, 'acme', 'development.env'), 'utf8')).toContain(SK);

    // A re-run without the key reuses the provider already in development mode.
    const again = captureIO();
    expect(
      await run(['init', '--product', 'acme', '--instance-env', 'development', '--email', 'development', '--yes'], ctxWith(again)),
    ).toBe(0);
  });

  it('managed or development email without a key says how to pass one; the key is never an argv flag', async () => {
    const io = captureIO();
    expect(await run([...INIT_BASE], ctxWith(io))).toBe(1);
    expect(io.stderr()).toContain('--email-key-file');
    const bad = captureIO();
    expect(await run(['init', '--product', 'acme', '--email-provider', 'ses', '--yes'], ctxWith(bad))).toBe(1);
    const argv = captureIO();
    expect(await run(['init', '--product', 'acme', '--email-key', PROVIDER_KEY, '--yes'], ctxWith(argv))).toBe(1);
    expect(argv.stderr()).toMatch(/Unknown option/);
  });

  it('validates its flags and needs a platform key', async () => {
    const io = captureIO();
    expect(await run(['init', '--yes'], ctxWith(io))).toBe(1);
    expect(io.stderr()).toContain('--product');
    const bad = captureIO();
    expect(await run(['init', '--product', '../etc', '--yes'], ctxWith(bad))).toBe(1);
    const dev = captureIO();
    expect(await run(['init', '--product', 'acme', '--email', 'development', '--yes'], ctxWith(dev))).toBe(1);
    expect(dev.stderr()).toContain('development');
    const nokey = captureIO();
    const ctx = ctxWith(nokey);
    ctx.env = { XDG_CONFIG_HOME: home };
    expect(await run(['init', '--product', 'acme', '--yes'], ctx)).toBe(1);
    expect(nokey.stderr()).toContain('ATLAS_PLATFORM_KEY');
  });

  it('asks before changing anything without --yes', async () => {
    const io = captureIO();
    const ctx = ctxWith(io, { prompt: { text: async () => 'n', secret: async () => '' } });
    expect(await run(['init', '--product', 'acme'], ctx)).toBe(1);
    expect(io.stderr()).toContain('Aborted');
    expect(state.writes).toEqual([]);
  });
});

describe('atlas preflight', () => {
  const findings = [
    { severity: 'warning', code: 'email_development_sender', message: 'Dev sender in use.', fix: 'Add a domain.' },
    { severity: 'info', code: 'email_sign_in_available', message: 'Email sign-in available.', fix: 'Turn it on.' },
  ];

  it('exits 0 with only warnings, 1 with --fail-on warning, 1 on an error', async () => {
    await run(['init', '--product', 'acme', '--yes'], ctxWith(captureIO()));
    state.findings = findings;

    const ok = captureIO();
    expect(await run(['preflight', '--product', 'acme'], ctxWith(ok))).toBe(0);
    expect(ok.stdout()).toContain('email_development_sender');
    expect(ok.stdout()).toContain('Add a domain.');

    const strict = captureIO();
    expect(await run(['preflight', '--product', 'acme', '--fail-on', 'warning'], ctxWith(strict))).toBe(1);

    state.findings = [...findings, { severity: 'error', code: 'email_provider_missing', message: 'No email.', fix: 'Add one.' }];
    const err = captureIO();
    expect(await run(['preflight', '--instance', 'ins_1'], ctxWith(err))).toBe(1);
    expect(err.stderr()).toContain('preflight failed');

    const json = captureIO();
    expect(await run(['preflight', '--product', 'acme', '--json'], ctxWith(json))).toBe(1);
    expect(JSON.parse(json.stdout()).findings).toHaveLength(3);
  });

  it('uses ATLAS_SECRET_KEY when no project is named', async () => {
    const io = captureIO();
    const ctx = ctxWith(io);
    ctx.env = { ...ctx.env, ATLAS_SECRET_KEY: SK };
    expect(await run(['preflight'], ctx)).toBe(0);
    expect(io.stdout()).toContain('Preflight passed');
  });

  it('rejects an unknown --fail-on', async () => {
    const io = captureIO();
    expect(await run(['preflight', '--fail-on', 'info'], ctxWith(io))).toBe(1);
  });
});

describe('atlas env', () => {
  beforeEach(async () => {
    await run(INIT(), ctxWith(captureIO()));
  });

  it('dotenv: public values and *_FILE paths, never a secret', async () => {
    const io = captureIO();
    expect(await run(['env', '--product', 'acme', '--format', 'dotenv'], ctxWith(io))).toBe(0);
    noSecrets(io);
    const out = io.stdout();
    expect(out).toContain('ATLAS_PUBLISHABLE_KEY=pk_test_1');
    expect(out).toContain('ATLAS_CLIENT_ID=client_abc');
    expect(out).toContain(`ATLAS_SECRET_KEY_FILE=${join(home, 'acme', 'production.env')}`);
    expect(out).toContain(`ATLAS_CLIENT_SECRET_FILE=${join(home, 'acme', 'production-oauth-client.env')}`);
    expect(out).toContain(`ATLAS_WEBHOOK_SECRET_FILE=${join(home, 'acme', 'production-webhook.env')}`);
  });

  it('coolify and vercel formats reference the files', async () => {
    const c = captureIO();
    expect(await run(['env', '--product', 'acme', '--format', 'coolify'], ctxWith(c))).toBe(0);
    noSecrets(c);
    expect(c.stdout()).toContain(`ATLAS_SECRET_KEY=@${join(home, 'acme', 'production.env')}`);

    const v = captureIO();
    expect(await run(['env', '--product', 'acme', '--format', 'vercel'], ctxWith(v))).toBe(0);
    noSecrets(v);
    expect(v.stdout()).toContain("vercel env add ATLAS_SECRET_KEY production");
    expect(v.stdout()).toContain(join(home, 'acme', 'production.env'));
  });

  it('needs a known product and format', async () => {
    expect(await run(['env', '--format', 'dotenv'], ctxWith(captureIO()))).toBe(1);
    expect(await run(['env', '--product', 'nope'], ctxWith(captureIO()))).toBe(1);
    expect(await run(['env', '--product', 'acme', '--format', 'yaml'], ctxWith(captureIO()))).toBe(1);
  });
});

describe('atlas client rotate', () => {
  beforeEach(async () => {
    await run(INIT(), ctxWith(captureIO()));
  });

  it('writes the new secret to the client file and prints when the old one dies', async () => {
    const io = captureIO();
    expect(await run(['client', 'rotate', 'oc_1', '--product', 'acme', '--overlap', '3600'], ctxWith(io))).toBe(0);
    expect(io.stdout()).not.toContain('oacs_rotated_secret_0002');
    const file = join(home, 'acme', 'production-oauth-client.env');
    expect(readFileSync(file, 'utf8')).toContain('ATLAS_CLIENT_SECRET=oacs_rotated_secret_0002');
    expect(mode(file)).toBe(0o600);
    expect(io.stdout()).toContain(new Date(1_800_000_000_000).toISOString());
    expect(state.writes.at(-1)).toMatchObject({ path: '/v1/oauth_clients/oc_1/rotate_secret', body: { overlap_seconds: 3600 } });
  });

  it('--now sends overlap_seconds 0 and accepts the public client_id', async () => {
    const io = captureIO();
    expect(await run(['client', 'rotate', 'client_abc', '--product', 'acme', '--now'], ctxWith(io))).toBe(0);
    expect(state.writes.at(-1)).toMatchObject({ body: { overlap_seconds: 0 } });
    expect(io.stdout()).toContain('stopped working immediately');
  });

  it('refuses --now with --overlap', async () => {
    const io = captureIO();
    expect(await run(['client', 'rotate', 'oc_1', '--product', 'acme', '--now', '--overlap', '5'], ctxWith(io))).toBe(1);
  });
});

describe('secrets written by default', () => {
  it('api-keys create writes the key to a 0600 file; --print-secret prints it with a warning', async () => {
    const create = vi.fn(async () => ({
      object: 'api_key',
      id: 'ak_1',
      subject_type: 'user',
      subject_id: 'user_1',
      name: null,
      prefix: 'ak_test_abcd',
      secret: 'ak_test_the_secret_value',
    }));
    const client = { apiKeys: { create } } as unknown as ManagementClient;
    const io = captureIO();
    const ctx = ctxWith(io, { makeClient: () => client });
    ctx.env = { ...ctx.env, ATLAS_SECRET_KEY: SK };
    expect(await run(['api-keys', 'create', '--subject-type', 'user', '--subject-id', 'user_1'], ctx)).toBe(0);
    expect(io.stdout()).not.toContain('ak_test_the_secret_value');
    const file = join(home, 'atlasauth', 'api-key-ak_1.env');
    expect(readFileSync(file, 'utf8')).toContain('ATLAS_API_KEY=ak_test_the_secret_value');
    expect(mode(file)).toBe(0o600);

    const printed = captureIO();
    const ctx2 = ctxWith(printed, { makeClient: () => client });
    ctx2.env = { ...ctx2.env, ATLAS_SECRET_KEY: SK };
    expect(
      await run(['api-keys', 'create', '--subject-type', 'user', '--subject-id', 'user_1', '--print-secret'], ctx2),
    ).toBe(0);
    expect(printed.stdout()).toContain('ak_test_the_secret_value');
    expect(printed.stderr()).toContain('warning');
  });

  it('webhooks create writes the signing secret to a 0600 file', async () => {
    const io = captureIO();
    const ctx = ctxWith(io);
    ctx.env = { ...ctx.env, ATLAS_SECRET_KEY: SK };
    expect(await run(['webhooks', 'create', '--url', 'https://acme.example/hooks', '--json'], ctx)).toBe(0);
    noSecrets(io);
    const body = JSON.parse(io.stdout());
    expect(body.secret_file).toBe(join(home, 'atlasauth', 'webhook-whe_1.env'));
    expect(readFileSync(body.secret_file, 'utf8')).toContain(`ATLAS_WEBHOOK_SECRET=${WEBHOOK_SECRET}`);
  });
});
