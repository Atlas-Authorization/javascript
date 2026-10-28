import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SOURCE_PROFILES, type MigrationBundleWriter, type RecordIssue } from '@atlasauth/migrate';
import { MIGRATE_VENDORS } from '@atlasauth/upgrade';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { fakeVendor, type Route } from './export/fake-vendor.test-helper';
import { registerBuiltInPlugins } from './framework/builtins';
import type { CredentialSpec, MigrationPlugin, PluginContext } from './framework/plugin';
import { migrationPlugin } from './framework/registry';
import { firebasePlugin } from './firebase/plugin';
import { nhostPlugin } from './nhost/plugin';
import { supabasePlugin } from './supabase/plugin';

/**
 * The g3 vendor plugins (Firebase, Supabase, Cognito, Azure AD B2C, Entra
 * External ID, Appwrite, PocketBase, Nhost) as the framework sees them: each
 * one registered, pointing at its source profile's bridge and lazy presets
 * and at a codemod `atlas migrate code --from` knows; and the Nhost plugin
 * driven end to end (dump folder, GraphQL with a fake Hasura, nhost.toml).
 */

const G3 = ['firebase', 'supabase', 'cognito', 'azure-ad-b2c', 'entra-external-id', 'appwrite', 'pocketbase', 'nhost'] as const;

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

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-g3-plugins-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('g3 plugin registry', () => {
  registerBuiltInPlugins();
  const plugins = G3.map((v) => [v, migrationPlugin(v)] as const);

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

  it('registers Azure AD B2C and Entra External ID as two sources', () => {
    expect(migrationPlugin('azure-ad-b2c')!.source).toBe('azure_ad_b2c');
    expect(migrationPlugin('entra-external-id')!.source).toBe('entra_external_id');
  });
});

// ── Nhost ────────────────────────────────────────────────────────────────────

const HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
const TOKEN_HASH = '454b783724805d3b60f2cde911a04c6605e83628c05b78684bdb44baf24a1794';

describe('nhostPlugin', () => {
  it('exports a dump folder of the auth schema', async () => {
    const dump = join(dir, 'dump');
    mkdirSync(dump, { recursive: true });
    writeFileSync(join(dump, 'auth.users.csv'), `id,email,email_verified,password_hash,default_role,created_at\nu1,ada@example.com,t,${HASH},user,2024-01-02 03:04:05+00\n`);
    writeFileSync(join(dump, 'auth.refresh_tokens.csv'), `id,user_id,expires_at,refresh_token_hash,type\nr1,u1,2099-01-01T00:00:00Z,\\x${TOKEN_HASH},regular\n`);
    const { p } = context(dir, { values: { 'nhost-dump': dump } });
    const w = new FakeWriter();
    await nhostPlugin.export!.run(p, w.writer, noResume);
    expect(w.of('user')[0]).toMatchObject({ id: 'u1', password: { algorithm: 'auto', hash: HASH } });
    expect(w.of('session')[0]).toMatchObject({ user_id: 'u1', token_hash: TOKEN_HASH });
    expect(w.described[0]).toMatchObject({ origin: 'auth schema dump' });
  });

  it('reads the auth tables through GraphQL with the admin secret, through the CLI fetch', async () => {
    const gql = 'https://abc.graphql.eu-central-1.nhost.run';
    const route: Route = ({ body, headers }: { body: unknown; headers: Headers }) => {
      expect(headers.get('x-hasura-admin-secret')).toBe('s3cret');
      const q = String((body as { query: string }).query);
      const root = /query \{ (\w+)\(/.exec(q)![1]!;
      return { data: { [root]: root === 'users' ? [{ id: 'u1', email: 'ada@example.com', emailVerified: true, passwordHash: HASH }] : [] } };
    };
    const api = fakeVendor(gql, { 'POST /v1': route });
    const { p, said } = context(dir, { values: { 'nhost-subdomain': 'abc', 'nhost-region': 'eu-central-1' }, env: { NHOST_ADMIN_SECRET: 's3cret' }, fetch: api.fetchImpl });
    const w = new FakeWriter();
    await nhostPlugin.export!.run(p, w.writer, noResume);
    expect(w.of('user')).toHaveLength(1);
    expect(api.calls.length).toBe(5);
    expect(said).toContain('  reading users');
  });

  it('names every way in when neither a dump nor the admin secret is given', async () => {
    const { p } = context(dir, { values: { 'nhost-subdomain': 'abc', 'nhost-region': 'eu-central-1' } });
    const err = await nhostPlugin.export!.run(p, new FakeWriter().writer, noResume).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as Error).message).toMatch(/nhost-admin-secret/);
    expect((err as Error).message).toMatch(/nhost-dump/);
  });

  it('translates nhost/nhost.toml found in the project and fills the lazy Auth URL from subdomain + region', async () => {
    const project = join(dir, 'app');
    mkdirSync(join(project, 'nhost'), { recursive: true });
    writeFileSync(join(project, 'nhost', 'nhost.toml'), '[auth]\nversion = "0.36.0"\n\n[auth.method.emailPassword]\npasswordMinLength = 9\n');
    const { p } = context(project, { values: { 'nhost-subdomain': 'abc', 'nhost-region': 'eu-central-1' } });
    const t = await nhostPlugin.config!.translate(p);
    expect(t.report.some((r) => r.file === join('nhost', 'nhost.toml'))).toBe(true);
    expect(nhostPlugin.lazy!.config(p, t)).toMatchObject({ auth_url: 'https://abc.auth.eu-central-1.nhost.run/v1' });
    expect(nhostPlugin.bridge!.vars(p, t)).toEqual({});
  });

  it('refuses a project without nhost.toml', async () => {
    const empty = join(dir, 'empty');
    mkdirSync(empty, { recursive: true });
    await expect(nhostPlugin.config!.translate(context(empty).p)).rejects.toThrow(/nhost-config/);
  });
});

// ── bridge preset choice ─────────────────────────────────────────────────────

describe('bridge presetFor', () => {
  const pick = (plugin: MigrationPlugin, values: Record<string, unknown>) => {
    const { p } = context(dir, { values });
    return { preset: plugin.bridge!.presetFor!(p), vars: plugin.bridge!.vars(p) };
  };

  it('Supabase: hosted access tokens by default, refresh tokens on request, self-hosted from an Auth URL', () => {
    expect(pick(supabasePlugin, { 'supabase-project-ref': 'abcdefghijklmnop' })).toEqual({ preset: 'supabase', vars: { project_ref: 'abcdefghijklmnop' } });
    expect(pick(supabasePlugin, { 'supabase-project-ref': 'abcdefghijklmnop', 'supabase-bridge': 'refresh-token' }).preset).toBe('supabase_refresh_token');
    expect(pick(supabasePlugin, { 'supabase-auth-url': 'https://db.example.com/auth/v1/' })).toEqual({
      preset: 'supabase_self_hosted',
      vars: { auth_url: 'https://db.example.com/auth/v1', cookie_name: 'sb-db-auth-token' },
    });
    expect(() => pick(supabasePlugin, { 'supabase-bridge': 'cookie' })).toThrow(CliError);
    expect(() => pick(supabasePlugin, { 'supabase-bridge': 'refresh-token', 'supabase-auth-url': 'https://db.example.com/auth/v1' })).toThrow(/hosted cookie/);
  });

  it('Firebase: ID tokens by default, Admin SDK session cookies on request', () => {
    expect(pick(firebasePlugin, { 'firebase-project': 'demo-proj' })).toEqual({ preset: 'firebase', vars: { project_id: 'demo-proj' } });
    expect(pick(firebasePlugin, { 'firebase-project': 'demo-proj', 'firebase-bridge': 'session-cookie', 'firebase-cookie-name': '__fb_session' })).toEqual({
      preset: 'firebase_session_cookie',
      vars: { project_id: 'demo-proj', cookie_name: '__fb_session' },
    });
  });

  it('Nhost: imported refresh tokens by default, Hasura Auth access tokens on request', () => {
    expect(pick(nhostPlugin, {})).toEqual({ preset: 'nhost', vars: {} });
    expect(pick(nhostPlugin, { 'nhost-bridge': 'access-token', 'nhost-subdomain': 'abc', 'nhost-region': 'eu-central-1' })).toEqual({
      preset: 'nhost_jwt',
      vars: { auth_url: 'https://abc.auth.eu-central-1.nhost.run/v1' },
    });
    expect(() => pick(nhostPlugin, { 'nhost-bridge': 'both' })).toThrow(CliError);
  });
});
