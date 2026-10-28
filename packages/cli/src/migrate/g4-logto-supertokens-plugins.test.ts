import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SOURCE_PROFILES, type MigrationBundleWriter, type RecordIssue } from '@atlasauth/migrate';
import { MIGRATE_VENDORS } from '@atlasauth/upgrade';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { fakeVendor } from './export/fake-vendor.test-helper';
import { registerBuiltInPlugins } from './framework/builtins';
import type { CredentialSpec, MigrationPlugin, PluginContext } from './framework/plugin';
import { migrationPlugin } from './framework/registry';
import { logtoPlugin } from './logto/plugin';
import { supertokensPlugin } from './supertokens/plugin';

/**
 * The Logto and SuperTokens plugins as the framework sees them: registered,
 * pointing at their source profile's bridge and lazy presets and at a codemod
 * `atlas migrate code --from` knows, and driven end to end against a dump
 * folder and a fake vendor API (never a real one).
 */

function context(project: string, opts: { values?: Record<string, unknown>; env?: Record<string, string>; fetch?: typeof fetch } = {}) {
  const values = opts.values ?? {};
  const env = opts.env ?? {};
  const said: string[] = [];
  const p: PluginContext = {
    ctx: { env, readFile: (path: string) => readFileSync(path, 'utf8') } as unknown as RunContext,
    args: { positionals: [], values } as unknown as ParsedArgs,
    project,
    credential(spec: CredentialSpec) {
      const name = spec.flag.replace(/^--/, '');
      const raw = values[name];
      const value = (typeof raw === 'string' && raw.trim() ? raw.trim() : undefined) ?? env[spec.env]?.trim();
      if (value) return value;
      if (spec.required) throw new CliError(`${spec.label} is needed. Pass --set ${name}=<value> or set ${spec.env}.`);
      return undefined;
    },
    fetch:
      opts.fetch ??
      ((async () => {
        throw new Error('no vendor API in this test');
      }) as typeof fetch),
    say: (line) => void said.push(line),
    dryRun: false,
  };
  return { p, said };
}

class FakeWriter {
  described: unknown[] = [];
  omits: Array<[string, string, number]> = [];
  adds: Array<{ model: string; data: Record<string, unknown> }> = [];
  describe(fields: unknown): void {
    this.described.push(fields);
  }
  warn(): void {}
  omit(model: string, reason: string, count = 1): void {
    this.omits.push([model, reason, count]);
  }
  async add(model: string, data: unknown): Promise<RecordIssue[]> {
    this.adds.push({ model, data: data as Record<string, unknown> });
    return [];
  }
  get writer(): MigrationBundleWriter {
    return this as unknown as MigrationBundleWriter;
  }
  of(model: string): Array<Record<string, unknown>> {
    return this.adds.filter((a) => a.model === model).map((a) => a.data);
  }
}

const noResume = { cursor: null, checkpoint: () => undefined };
const BCRYPT = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-g4-plugins-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('registry', () => {
  registerBuiltInPlugins();
  const plugins = (['logto', 'supertokens'] as const).map((v) => [v, migrationPlugin(v)] as const);

  it.each(plugins)('%s is registered with its source profile presets and codemod', (vendor, plugin) => {
    expect(plugin).toBeDefined();
    const pl = plugin as MigrationPlugin;
    expect(pl.vendor).toBe(vendor);
    const profile = SOURCE_PROFILES[pl.source];
    expect(profile).toBeDefined();
    expect(pl.bridge?.preset).toBe(profile.bridgePreset);
    expect(pl.lazy?.preset).toBe(profile.lazyPreset);
    expect(MIGRATE_VENDORS as readonly string[]).toContain(pl.codemod);
    expect(pl.help.length).toBeGreaterThan(40);
    expect(pl.export?.limits?.length).toBeGreaterThan(0);
  });

  it.each(plugins)('%s takes each credential under one flag and one env var', (_vendor, plugin) => {
    const pl = plugin as MigrationPlugin;
    for (const step of [pl.config?.credentials ?? [], pl.export?.credentials ?? []]) {
      const flags = step.map((c) => c.flag);
      expect(new Set(flags).size).toBe(flags.length);
      for (const c of step) {
        expect(c.flag).toMatch(/^--[a-z0-9-]+$/);
        expect(c.env).toMatch(/^[A-Z0-9_]+$/);
      }
    }
  });
});

describe('logtoPlugin', () => {
  it('exports a database dump folder', async () => {
    const dump = join(dir, 'logto-dump');
    mkdirSync(dump, { recursive: true });
    writeFileSync(join(dump, 'users.json'), JSON.stringify([{ id: 'u1', primary_email: 'ada@example.com', password_encrypted: BCRYPT, password_encryption_method: 'Bcrypt', tenant_id: 'default' }]));
    const { p } = context(dir, { values: { 'logto-dump': dump } });
    const w = new FakeWriter();
    await logtoPlugin.export!.run(p, w.writer, noResume);
    expect(w.of('user')[0]).toMatchObject({ id: 'u1', password: { algorithm: 'bcrypt', hash: BCRYPT } });
    expect(w.described[0]).toMatchObject({ origin: 'Logto database (tenant default)' });
  });

  it('reads the Management API with the machine-to-machine app, through the CLI fetch', async () => {
    const origin = 'https://abc123.logto.app';
    const api = fakeVendor(origin, {
      'POST /oidc/token': { access_token: 'at', expires_in: 3600 },
      'GET /api/users': [{ id: 'u1', primaryEmail: 'ada@example.com' }],
      'GET /api/roles': [],
    });
    const { p, said } = context(dir, { values: { 'logto-endpoint': 'abc123.logto.app' }, env: { LOGTO_M2M_APP_ID: 'app', LOGTO_M2M_APP_SECRET: 'secret' }, fetch: api.fetchImpl });
    const w = new FakeWriter();
    await logtoPlugin.export!.run(p, w.writer, noResume);
    expect(w.of('user')).toHaveLength(1);
    expect(said).toContain('  reading users');
    expect(api.calls[0]!.headers.get('authorization')).toBe(`Basic ${Buffer.from('app:secret').toString('base64')}`);
  });

  it('names every way in when nothing is given', async () => {
    const { p } = context(dir);
    const err = await logtoPlugin.export!.run(p, new FakeWriter().writer, noResume).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as Error).message).toMatch(/logto-dump/);
    expect((err as Error).message).toMatch(/LOGTO_M2M_APP_ID/);
  });

  it('translates the tenant config and fills the bridge and lazy variables', async () => {
    const origin = 'https://auth.example.com';
    const api = fakeVendor(origin, { 'POST /oidc/token': { access_token: 'at' }, 'GET /api/sign-in-exp': { signIn: { methods: [{ identifier: 'email', password: true, verificationCode: false }] }, signUp: { identifiers: ['email'], password: true, verify: true } } });
    const { p } = context(dir, { values: { 'logto-endpoint': origin, 'logto-m2m-app-id': 'app', 'logto-client-id': 'my-app' }, env: { LOGTO_M2M_APP_SECRET: 's' }, fetch: api.fetchImpl });
    const t = await logtoPlugin.config!.translate(p);
    expect((t.documents.instance as { auth_config: Record<string, unknown> }).auth_config).toMatchObject({ strategies: { password: true }, requireEmailVerification: true });
    expect(logtoPlugin.bridge!.vars(p, t)).toEqual({ base_url: origin, client_id: 'my-app' });
    expect(logtoPlugin.lazy!.config(p, t)).toEqual({ base_url: origin, app_id: 'app' });
    expect(logtoPlugin.lazy!.secret?.env).toBe('LOGTO_M2M_APP_SECRET');
  });

  it('needs the M2M app for the config step and an https endpoint', async () => {
    await expect(logtoPlugin.config!.translate(context(dir, { values: { 'logto-endpoint': 'https://auth.example.com' } }).p)).rejects.toThrow(/machine-to-machine/);
    await expect(logtoPlugin.config!.translate(context(dir, { values: { 'logto-endpoint': 'http://auth.example.com' } }).p)).rejects.toThrow(/https/);
  });

  it('takes the Cloud tenant id from the endpoint for lazy migration', () => {
    const { p } = context(dir, { values: { 'logto-endpoint': 'https://abc123.logto.app', 'logto-m2m-app-id': 'app' } });
    expect(logtoPlugin.lazy!.config(p)).toEqual({ base_url: 'https://abc123.logto.app', app_id: 'app', tenant_id: 'abc123' });
  });
});

describe('supertokensPlugin', () => {
  it('exports a core database dump folder', async () => {
    const dump = join(dir, 'st-dump');
    mkdirSync(dump, { recursive: true });
    writeFileSync(join(dump, 'emailpassword_users.json'), JSON.stringify([{ user_id: 'u1', email: 'ada@example.com', password_hash: BCRYPT, time_joined: 1700000000000 }]));
    const { p } = context(dir, { values: { 'supertokens-dump': dump } });
    const w = new FakeWriter();
    await supertokensPlugin.export!.run(p, w.writer, noResume);
    expect(w.of('user')[0]).toMatchObject({ id: 'u1', password: { algorithm: 'bcrypt', hash: BCRYPT } });
  });

  it('reads the core API with the API key, through the CLI fetch', async () => {
    const origin = 'https://st-dev-1.aws.supertokens.io';
    const api = fakeVendor(origin, {
      'GET /recipe/multitenancy/tenant/list/v2': { status: 'OK', tenants: [{ tenantId: 'public' }] },
      'GET /users': { status: 'OK', users: [{ id: 'u1', loginMethods: [{ recipeId: 'emailpassword', recipeUserId: 'u1', email: 'ada@example.com', verified: true, tenantIds: ['public'] }] }] },
      'GET /recipe/roles': { status: 'OK', roles: [] },
      'GET /recipe/user/metadata': { status: 'OK', metadata: {} },
    });
    const { p, said } = context(dir, { values: { 'supertokens-connection-uri': origin }, env: { SUPERTOKENS_API_KEY: 'core-key' }, fetch: api.fetchImpl });
    const w = new FakeWriter();
    await supertokensPlugin.export!.run(p, w.writer, noResume);
    expect(w.of('user')).toHaveLength(1);
    expect(said).toContain('  reading users');
    expect(api.calls.every((c) => c.headers.get('api-key') === 'core-key')).toBe(true);
  });

  it('names every way in when nothing is given', async () => {
    const err = await supertokensPlugin.export!.run(context(dir).p, new FakeWriter().writer, noResume).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as Error).message).toMatch(/supertokens-dump/);
    expect((err as Error).message).toMatch(/supertokens-connection-uri/);
  });

  it('translates the core config and fills the lazy and bridge variables', async () => {
    const origin = 'https://st-dev-1.aws.supertokens.io';
    const api = fakeVendor(origin, { 'GET /recipe/multitenancy/tenant/list/v2': { status: 'OK', tenants: [{ tenantId: 'public', emailPassword: { enabled: true }, firstFactors: ['emailpassword'], coreConfig: {} }] } });
    const { p } = context(dir, { values: { 'supertokens-connection-uri': origin, 'supertokens-api-domain': 'https://api.example.com', 'supertokens-api-base-path': '/api/auth/' }, fetch: api.fetchImpl });
    const t = await supertokensPlugin.config!.translate(p);
    expect((t.documents.instance as { auth_config: Record<string, unknown> }).auth_config).toMatchObject({ strategies: { password: true } });
    expect(supertokensPlugin.bridge!.vars(p, t)).toEqual({ base_url: 'https://api.example.com', api_base_path: 'api/auth' });
    expect(supertokensPlugin.lazy!.config(p, t)).toEqual({ base_url: origin });
    expect(supertokensPlugin.lazy!.secret?.env).toBe('SUPERTOKENS_API_KEY');
  });
});
