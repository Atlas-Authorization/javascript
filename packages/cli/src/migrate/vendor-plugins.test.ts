import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { CANONICAL_MODEL_ORDER, type MigrationBundleWriter, type RecordIssue } from '@atlasauth/migrate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { auth0Plugin } from './auth0/plugin';
import { clerkPlugin } from './clerk/plugin';
import { descopePlugin } from './descope/plugin';
import { fakeVendor } from './export/fake-vendor.test-helper';
import { flag, hostOf, localFile, need, vendorStep, writeRecordSet } from './export/plugin-kit';
import { RecordSet } from './export/record-set';
import { registerBuiltInPlugins } from './framework/builtins';
import type { CredentialSpec, ExportCursor, MigrationPlugin, PluginContext, TranslationResult } from './framework/plugin';
import { migrationPlugin, registerMigrationPlugin, resetMigrationPlugins } from './framework/registry';
import { kindePlugin } from './kinde/plugin';
import { oktaPlugin } from './okta/plugin';

/**
 * The five vendor plugins (clerk, auth0, okta, kinde, descope) as the
 * framework drives them: a hand-built PluginContext (credentials from a
 * `--set`/flag map, then an env map, a CliError for a missing required one),
 * a fake vendor API, and a fake bundle writer that records every call.
 */

// ── harness ─────────────────────────────────────────────────────────────────

interface Harness {
  p: PluginContext;
  said: string[];
}

function context(opts: { values?: Record<string, unknown>; env?: Record<string, string>; files?: Record<string, string>; fetch?: typeof fetch } = {}): Harness {
  const values = opts.values ?? {};
  const env = opts.env ?? {};
  const files = opts.files ?? {};
  const said: string[] = [];
  const p: PluginContext = {
    ctx: {
      env,
      readFile: (path: string) => {
        const text = files[path];
        if (text === undefined) throw new Error(`ENOENT: no such file, open '${path}'`);
        return text;
      },
    } as unknown as RunContext,
    args: { positionals: [], values } as unknown as ParsedArgs,
    project: '/project',
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
  warnings: string[] = [];
  omits: Array<[string, string, number]> = [];
  adds: Array<{ model: string; data: Record<string, unknown> }> = [];
  /** Issues `add` answers per model (the writer refusing a record). */
  issues: Record<string, RecordIssue[]> = {};

  describe(fields: unknown): void {
    this.described.push(fields);
  }
  warn(message: string): void {
    this.warnings.push(message);
  }
  omit(model: string, reason: string, count = 1): void {
    this.omits.push([model, reason, count]);
  }
  async add(model: string, data: unknown): Promise<RecordIssue[]> {
    this.adds.push({ model, data: data as Record<string, unknown> });
    return this.issues[model] ?? [];
  }

  get writer(): MigrationBundleWriter {
    return this as unknown as MigrationBundleWriter;
  }
  ids(model: string): unknown[] {
    return this.adds.filter((a) => a.model === model).map((a) => a.data.id);
  }
  models(): string[] {
    return this.adds.map((a) => a.model);
  }
}

function resumeFrom(cursor: ExportCursor | null = null) {
  const checkpoints: ExportCursor[] = [];
  return { checkpoints, resume: { cursor, checkpoint: (c: ExportCursor) => void checkpoints.push(c) } };
}

function inCanonicalOrder(models: string[]): boolean {
  const order = CANONICAL_MODEL_ORDER as readonly string[];
  const idx = models.map((m) => order.indexOf(m));
  return idx.every((v, i) => v >= 0 && (i === 0 || v >= idx[i - 1]!));
}

function translation(over: Partial<TranslationResult>): TranslationResult {
  return { origin: 'test', documents: {}, report: [], env: [], mappings: { providers: {}, roles: {} }, ...over };
}

async function failure(promise: Promise<unknown>): Promise<CliError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CliError);
  return err as CliError;
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-vendor-plugins-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ── plugin-kit ──────────────────────────────────────────────────────────────

describe('writeRecordSet', () => {
  function sample(): RecordSet {
    const set = new RecordSet();
    set.manifest = { origin: 'acme.example', providers: ['google'] };
    // Added out of order on purpose: the writer must see canonical order.
    set.add('user', { id: 'u1', emails: [{ email: 'a@example.com', verified: true, primary: true }] } as never);
    set.add('organization', { id: 'o1', name: 'Acme' } as never);
    set.add('user', { id: 'u2', emails: [{ email: 'b@example.com', verified: false, primary: true }] } as never);
    set.add('membership', { id: 'm1', organization_id: 'o1', user_id: 'u1', role: 'member' } as never);
    set.warn('w1');
    set.omit('passkey', 'no public keys', 2);
    return set;
  }

  it('describes the bundle, writes warnings and omissions, then every record in canonical order', async () => {
    const w = new FakeWriter();
    const { resume, checkpoints } = resumeFrom();
    const said: string[] = [];
    await writeRecordSet(sample(), w.writer, resume, (l) => void said.push(l));
    expect(w.described).toEqual([{ origin: 'acme.example', providers: ['google'] }]);
    expect(w.warnings).toEqual(['w1']);
    expect(w.omits).toEqual([['passkey', 'no public keys', 2]]);
    expect(w.adds.map((a) => [a.model, a.data.id])).toEqual([
      ['organization', 'o1'],
      ['user', 'u1'],
      ['user', 'u2'],
      ['membership', 'm1'],
    ]);
    expect(checkpoints).toEqual([]);
    expect(said).toEqual([]);
  });

  it('on resume skips the first N records and does not count the omissions twice', async () => {
    const w = new FakeWriter();
    const { resume } = resumeFrom(2);
    const said: string[] = [];
    await writeRecordSet(sample(), w.writer, resume, (l) => void said.push(l));
    expect(w.adds.map((a) => [a.model, a.data.id])).toEqual([
      ['user', 'u2'],
      ['membership', 'm1'],
    ]);
    expect(w.omits).toEqual([]);
    // The manifest fields and warnings are written to every segment.
    expect(w.described).toHaveLength(1);
    expect(w.warnings).toEqual(['w1']);
    expect(said).toEqual(['  resuming after record 2']);
  });

  it('treats a non-numeric cursor as a fresh run', async () => {
    const w = new FakeWriter();
    await writeRecordSet(sample(), w.writer, resumeFrom('orgs_done').resume, () => undefined);
    expect(w.adds).toHaveLength(4);
    expect(w.omits).toHaveLength(1);
  });

  it('checkpoints every 1000 records, counting the skipped ones', async () => {
    const set = new RecordSet();
    for (let i = 0; i < 2500; i++) set.add('user', { id: `u${i}` } as never);
    const fresh = resumeFrom();
    await writeRecordSet(set, new FakeWriter().writer, fresh.resume, () => undefined);
    expect(fresh.checkpoints).toEqual([1000, 2000]);

    const w = new FakeWriter();
    const resumed = resumeFrom(1000);
    await writeRecordSet(set, w.writer, resumed.resume, () => undefined);
    expect(w.adds).toHaveLength(1500);
    expect(w.adds[0]!.data.id).toBe('u1000');
    expect(resumed.checkpoints).toEqual([2000]);
  });

  it('says which record the writer refused', async () => {
    const w = new FakeWriter();
    w.issues.membership = [{ field: 'role', message: 'membership.role is required.' }];
    const said: string[] = [];
    await writeRecordSet(sample(), w.writer, resumeFrom().resume, (l) => void said.push(l));
    expect(said).toEqual(['  left out membership #4: membership.role is required.']);
  });
});

describe('plugin-kit helpers', () => {
  const SPEC: CredentialSpec = { flag: '--thing', env: 'THING', label: 'the thing', required: false };

  it('need() turns an optional credential into a required one', () => {
    expect(need(context({ values: { thing: 'x' } }).p, SPEC)).toBe('x');
    expect(need(context({ env: { THING: ' y ' } }).p, SPEC)).toBe('y');
    expect(() => need(context().p, SPEC)).toThrow(CliError);
    expect(() => need(context().p, SPEC)).toThrow(/the thing is needed/);
  });

  it('flag() is true only for a boolean true', () => {
    expect(flag(context({ values: { factors: true } }).p, 'factors')).toBe(true);
    expect(flag(context({ values: { factors: 'true' } }).p, 'factors')).toBe(false);
    expect(flag(context().p, 'factors')).toBe(false);
  });

  it('localFile() reads text through the context, bytes from disk, and names the file it could not read', () => {
    const path = resolve('/fixtures/thing.txt');
    expect(localFile(context({ values: { thing: '/fixtures/thing.txt' }, files: { [path]: 'hello' } }).p, SPEC, 'text')).toBe('hello');
    expect(localFile(context().p, SPEC, 'text')).toBeUndefined();
    const bin = join(dir, 'thing.bin');
    writeFileSync(bin, Buffer.from([1, 2, 3]));
    expect([...localFile(context({ values: { thing: bin } }).p, SPEC, 'bytes')!]).toEqual([1, 2, 3]);
    expect(() => localFile(context({ values: { thing: '/fixtures/missing.txt' } }).p, SPEC, 'text')).toThrow(/Could not read the thing at \/fixtures\/missing\.txt: ENOENT/);
  });

  it('hostOf() strips the scheme and any path', () => {
    expect(hostOf('https://acme.us.auth0.com/api/v2/')).toBe('acme.us.auth0.com');
    expect(hostOf(' http://dev-1.okta.com ')).toBe('dev-1.okta.com');
    expect(hostOf('acme.kinde.com')).toBe('acme.kinde.com');
    expect(hostOf('acme.auth0.com?x=1')).toBe('acme.auth0.com');
    expect(hostOf('acme.auth0.com#frag')).toBe('acme.auth0.com');
  });

  it('vendorStep() wraps vendor errors in a CliError and passes CliErrors through', async () => {
    const wrapped = await failure(vendorStep('Okta', async () => Promise.reject(new Error('HTTP 401 Invalid token'))));
    expect(wrapped.message).toBe('Okta: HTTP 401 Invalid token');
    const original = new CliError('already clean');
    await expect(vendorStep('Okta', async () => Promise.reject(original))).rejects.toBe(original);
    await expect(vendorStep('Okta', async () => 42)).resolves.toBe(42);
  });
});

// ── registration ────────────────────────────────────────────────────────────

describe('built-in registration', () => {
  beforeAll(() => {
    // Tests share one registry (vitest --no-isolate): start from the built-ins only.
    resetMigrationPlugins();
    registerBuiltInPlugins();
  });

  it('registers the five vendor plugins under their names', () => {
    expect(migrationPlugin('clerk')).toBe(clerkPlugin);
    expect(migrationPlugin('auth0')).toBe(auth0Plugin);
    expect(migrationPlugin('okta')).toBe(oktaPlugin);
    expect(migrationPlugin('kinde')).toBe(kindePlugin);
    expect(migrationPlugin('descope')).toBe(descopePlugin);
  });

  it('resolves other spellings through sourceFromVendor and is idempotent', () => {
    expect(migrationPlugin('Clerk')).toBe(clerkPlugin);
    expect(migrationPlugin(' OKTA ')).toBe(oktaPlugin);
    expect(migrationPlugin(' Descope')).toBe(descopePlugin);
    // Stytch has a plugin now; an unknown vendor has none.
    expect(migrationPlugin('stytch')?.vendor).toBe('stytch');
    expect(migrationPlugin('nope')).toBeUndefined();
    expect(() => registerBuiltInPlugins()).not.toThrow();
    expect(migrationPlugin('auth0')).toBe(auth0Plugin);
  });

  it('still registers a built-in when another vendor with the same source came first', () => {
    resetMigrationPlugins();
    const acme: MigrationPlugin = { ...auth0Plugin, vendor: 'acmeauth' };
    registerMigrationPlugin(acme);
    registerBuiltInPlugins();
    expect(migrationPlugin('auth0')).toBe(auth0Plugin);
    expect(migrationPlugin('acmeauth')).toBe(acme);
    resetMigrationPlugins();
    registerBuiltInPlugins();
  });

  it('wires vendor, source, presets and codemod ids', () => {
    const plugins: MigrationPlugin[] = [clerkPlugin, auth0Plugin, oktaPlugin, kindePlugin, descopePlugin];
    expect(plugins.map((p) => [p.vendor, p.source, p.codemod, p.bridge?.preset, p.lazy?.preset])).toEqual([
      ['clerk', 'clerk', 'clerk', 'clerk', 'clerk'],
      ['auth0', 'auth0', 'auth0', 'auth0', 'auth0'],
      ['okta', 'okta', 'okta', 'okta', 'okta'],
      ['kinde', 'kinde', 'kinde', 'kinde', undefined],
      ['descope', 'descope', 'descope', 'descope', 'descope'],
    ]);
    for (const p of plugins) {
      expect(p.config).toBeDefined();
      expect(p.export?.credentials.length).toBeGreaterThan(0);
    }
  });
});

// ── bridge and lazy presets ─────────────────────────────────────────────────

describe('clerk presets', () => {
  const HOST = 'fox.clerk.accounts.dev';
  // A publishable key is pk_test_ + base64('<frontend api host>$'), without padding.
  const PK = `pk_test_${Buffer.from(`${HOST}$`).toString('base64').replace(/=+$/, '')}`;

  it('derives frontend_api from the publishable key (flag or a framework env var)', () => {
    expect(PK.includes('=')).toBe(false);
    expect(clerkPlugin.bridge!.vars(context({ values: { 'clerk-publishable-key': PK } }).p)).toEqual({ frontend_api: HOST });
    expect(clerkPlugin.bridge!.vars(context({ env: { CLERK_PUBLISHABLE_KEY: PK } }).p)).toEqual({ frontend_api: HOST });
    expect(clerkPlugin.bridge!.vars(context({ env: { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: PK } }).p)).toEqual({ frontend_api: HOST });
    expect(clerkPlugin.bridge!.vars(context({ env: { VITE_CLERK_PUBLISHABLE_KEY: ` ${PK} ` } }).p)).toEqual({ frontend_api: HOST });
  });

  it('prefers the translation, and is empty without either', () => {
    const t = translation({ bridge: { preset: 'clerk', vars: { frontend_api: 'clerk.acme.example' } } });
    expect(clerkPlugin.bridge!.vars(context({ values: { 'clerk-publishable-key': PK } }).p, t)).toEqual({ frontend_api: 'clerk.acme.example' });
    expect(clerkPlugin.bridge!.vars(context().p)).toEqual({});
  });

  it('lazy needs no config, only the secret key', () => {
    expect(clerkPlugin.lazy!.config(context().p)).toEqual({});
    expect(clerkPlugin.lazy!.secret).toMatchObject({ flag: '--clerk-secret-key', env: 'CLERK_SECRET_KEY', required: true });
  });
});

describe('auth0 presets', () => {
  it('bridge: the domain without scheme or path, and the client id, from flags or env', () => {
    expect(auth0Plugin.bridge!.vars(context({ values: { 'auth0-domain': 'https://acme.us.auth0.com/authorize', 'auth0-client-id': 'cid' } }).p)).toEqual({
      domain: 'acme.us.auth0.com',
      client_id: 'cid',
    });
    expect(auth0Plugin.bridge!.vars(context({ env: { AUTH0_DOMAIN: 'acme.eu.auth0.com', AUTH0_CLIENT_ID: 'abc' } }).p)).toEqual({ domain: 'acme.eu.auth0.com', client_id: 'abc' });
    // The domain is optional here: missing ones are asked for by the framework.
    expect(auth0Plugin.bridge!.vars(context().p)).toEqual({});
  });

  it('bridge: flags override what the translation learned', () => {
    const t = translation({ bridge: { preset: 'auth0', vars: { domain: 'old.auth0.com', audience: 'https://api.example' } } });
    expect(auth0Plugin.bridge!.vars(context().p, t)).toEqual({ domain: 'old.auth0.com', audience: 'https://api.example' });
    expect(auth0Plugin.bridge!.vars(context({ values: { 'auth0-domain': 'https://new.auth0.com/' } }).p, t)).toEqual({ domain: 'new.auth0.com', audience: 'https://api.example' });
  });

  it('lazy: domain, client id and connection on top of the translation', () => {
    const t = translation({ lazy: { preset: 'auth0', config: { domain: 'old.auth0.com', connection: 'db-from-config' } } });
    expect(auth0Plugin.lazy!.config(context({ values: { 'auth0-domain': 'https://acme.eu.auth0.com/u/login', 'auth0-client-id': 'cid' } }).p, t)).toEqual({
      domain: 'acme.eu.auth0.com',
      connection: 'db-from-config',
      client_id: 'cid',
    });
    expect(auth0Plugin.lazy!.config(context({ env: { AUTH0_DOMAIN: 'acme.us.auth0.com', AUTH0_CONNECTION: 'Username-Password-Authentication' } }).p)).toEqual({
      domain: 'acme.us.auth0.com',
      connection: 'Username-Password-Authentication',
    });
    expect(auth0Plugin.lazy!.secret).toMatchObject({ flag: '--auth0-client-secret', env: 'AUTH0_CLIENT_SECRET', required: false });
  });
});

describe('okta presets', () => {
  it('bridge: domain from --okta-domain or OKTA_ORG_URL, plus the authorization server', () => {
    expect(oktaPlugin.bridge!.vars(context({ values: { 'okta-domain': 'https://acme.okta.com/', 'okta-auth-server': 'aus1' } }).p)).toEqual({ domain: 'acme.okta.com', auth_server: 'aus1' });
    expect(oktaPlugin.bridge!.vars(context({ env: { OKTA_ORG_URL: 'https://dev-1.okta.com' } }).p)).toEqual({ domain: 'dev-1.okta.com' });
    expect(oktaPlugin.bridge!.vars(context({ env: { OKTA_DOMAIN: 'acme.okta.com', OKTA_ORG_URL: 'https://other.okta.com' } }).p)).toEqual({ domain: 'acme.okta.com' });
    const t = translation({ bridge: { preset: 'okta', vars: { domain: 'from-config.okta.com', auth_server: 'default' } } });
    expect(oktaPlugin.bridge!.vars(context().p, t)).toEqual({ domain: 'from-config.okta.com', auth_server: 'default' });
  });

  it('lazy: Classic authn by default, the password grant when --okta-client-id is given', () => {
    expect(oktaPlugin.lazy!.config(context({ values: { 'okta-domain': 'acme.okta.com' } }).p)).toEqual({ domain: 'acme.okta.com' });
    expect(oktaPlugin.lazy!.config(context({ values: { 'okta-domain': 'acme.okta.com', 'okta-client-id': '0oaapp' } }).p)).toEqual({
      domain: 'acme.okta.com',
      mode: 'password_grant',
      client_id: '0oaapp',
      auth_server: 'default',
    });
    const t = translation({ lazy: { preset: 'okta', config: { domain: 'acme.okta.com', mode: 'authn' } } });
    expect(oktaPlugin.lazy!.config(context({ env: { OKTA_CLIENT_ID: '0oaapp', OKTA_AUTH_SERVER: 'aus9' } }).p, t)).toEqual({
      domain: 'acme.okta.com',
      mode: 'password_grant',
      client_id: '0oaapp',
      auth_server: 'aus9',
    });
    expect(oktaPlugin.lazy!.secret).toMatchObject({ flag: '--okta-client-secret', env: 'OKTA_CLIENT_SECRET', required: false });
  });
});

describe('kinde presets', () => {
  it('bridge: the domain from --kinde-domain, KINDE_ISSUER_URL or KINDE_DOMAIN, else the translation', () => {
    expect(kindePlugin.bridge!.vars(context({ values: { 'kinde-domain': 'https://acme.kinde.com' } }).p)).toEqual({ domain: 'acme.kinde.com' });
    expect(kindePlugin.bridge!.vars(context({ env: { KINDE_ISSUER_URL: 'https://acme.kinde.com/' } }).p)).toEqual({ domain: 'acme.kinde.com' });
    expect(kindePlugin.bridge!.vars(context({ env: { KINDE_DOMAIN: 'auth.acme.example' } }).p)).toEqual({ domain: 'auth.acme.example' });
    const t = translation({ bridge: { preset: 'kinde', vars: { domain: 'from-config.kinde.com' } } });
    expect(kindePlugin.bridge!.vars(context().p, t)).toEqual({ domain: 'from-config.kinde.com' });
    // Here the flag wins over the translation.
    expect(kindePlugin.bridge!.vars(context({ values: { 'kinde-domain': 'acme.kinde.com' } }).p, t)).toEqual({ domain: 'acme.kinde.com' });
    expect(kindePlugin.bridge!.vars(context().p)).toEqual({});
  });

  it('has no lazy-migration preset (Kinde has no password grant)', () => {
    expect(kindePlugin.lazy).toBeUndefined();
  });
});

describe('descope presets', () => {
  it('bridge and lazy: the project id from the flag, DESCOPE_PROJECT_ID or NEXT_PUBLIC_DESCOPE_PROJECT_ID', () => {
    expect(descopePlugin.bridge!.vars(context({ values: { 'descope-project-id': 'P2flag' } }).p)).toEqual({ project_id: 'P2flag' });
    expect(descopePlugin.bridge!.vars(context({ env: { DESCOPE_PROJECT_ID: 'P2env' } }).p)).toEqual({ project_id: 'P2env' });
    expect(descopePlugin.bridge!.vars(context({ env: { NEXT_PUBLIC_DESCOPE_PROJECT_ID: 'P2next' } }).p)).toEqual({ project_id: 'P2next' });
    expect(descopePlugin.lazy!.config(context({ env: { NEXT_PUBLIC_DESCOPE_PROJECT_ID: 'P2next' } }).p)).toEqual({ project_id: 'P2next' });
  });

  it('treats a blank NEXT_PUBLIC_DESCOPE_PROJECT_ID / base URL as unset', () => {
    expect(() => descopePlugin.bridge!.vars(context({ env: { NEXT_PUBLIC_DESCOPE_PROJECT_ID: '  ' } }).p)).toThrow(CliError);
    expect(descopePlugin.bridge!.vars(context({ env: { DESCOPE_PROJECT_ID: 'P2env', NEXT_PUBLIC_DESCOPE_BASE_URL: ' ' } }).p)).toEqual({ project_id: 'P2env' });
  });

  it('adds the base URL without trailing slashes', () => {
    const p = context({ env: { DESCOPE_PROJECT_ID: 'P2env', NEXT_PUBLIC_DESCOPE_BASE_URL: 'https://auth.acme.example//' } }).p;
    expect(descopePlugin.bridge!.vars(p)).toEqual({ project_id: 'P2env', base_url: 'https://auth.acme.example' });
    expect(descopePlugin.lazy!.config(context({ values: { 'descope-project-id': 'P2flag', 'descope-base-url': 'https://api.euc1.descope.com/' } }).p)).toEqual({
      project_id: 'P2flag',
      base_url: 'https://api.euc1.descope.com',
    });
  });

  it('the translation\'s project id wins; without any the project id is asked for', () => {
    const t = translation({
      bridge: { preset: 'descope', vars: { project_id: 'P2config' } },
      lazy: { preset: 'descope', config: { project_id: 'P2config' } },
    });
    expect(descopePlugin.bridge!.vars(context({ env: { DESCOPE_PROJECT_ID: 'P2env' } }).p, t)).toEqual({ project_id: 'P2config' });
    expect(descopePlugin.lazy!.config(context().p, t)).toEqual({ project_id: 'P2config' });
    expect(() => descopePlugin.bridge!.vars(context().p)).toThrow(CliError);
    expect(() => descopePlugin.lazy!.config(context().p)).toThrow(/Descope project id/);
  });
});

// ── export.run without a data source ────────────────────────────────────────

describe('export.run without a data source', () => {
  it('clerk: neither the secret key nor the CSV', async () => {
    const w = new FakeWriter();
    const err = await failure(clerkPlugin.export!.run(context().p, w.writer, resumeFrom().resume));
    expect(err.message).toMatch(/secret key.*dashboard CSV export/);
    expect(w.described).toEqual([]);
    expect(w.adds).toEqual([]);
  });

  it('auth0: neither Management API credentials nor a users file (and the domain is required)', async () => {
    const w = new FakeWriter();
    const err = await failure(auth0Plugin.export!.run(context({ values: { 'auth0-domain': 'acme.us.auth0.com' } }).p, w.writer, resumeFrom().resume));
    expect(err.message).toMatch(/Management API credentials.*users export file/);
    // A client id without its secret is not enough either.
    const half = await failure(auth0Plugin.export!.run(context({ values: { 'auth0-domain': 'acme.us.auth0.com', 'auth0-mgmt-client-id': 'm2m' } }).p, w.writer, resumeFrom().resume));
    expect(half.message).toMatch(/Management API credentials/);
    const noDomain = await failure(auth0Plugin.export!.run(context({ values: { 'auth0-mgmt-token': 't' } }).p, w.writer, resumeFrom().resume));
    expect(noDomain.message).toMatch(/your Auth0 domain/);
    expect(w.adds).toEqual([]);
  });

  it('kinde: neither the export file nor M2M credentials', async () => {
    const w = new FakeWriter();
    const err = await failure(kindePlugin.export!.run(context().p, w.writer, resumeFrom().resume));
    expect(err.message).toMatch(/data export.*Management API credentials/);
    const partial = await failure(kindePlugin.export!.run(context({ values: { 'kinde-domain': 'acme.kinde.com', 'kinde-client-id': 'cid' } }).p, w.writer, resumeFrom().resume));
    expect(partial.message).toMatch(/data export.*Management API credentials/);
    expect(w.adds).toEqual([]);
  });

  it('okta: the domain and API token are required, --groups-as is checked', async () => {
    const api = fakeVendor('https://acme.okta.com', {});
    const w = new FakeWriter();
    const noToken = await failure(oktaPlugin.export!.run(context({ values: { 'okta-domain': 'acme.okta.com' }, fetch: api.fetchImpl }).p, w.writer, resumeFrom().resume));
    expect(noToken.message).toMatch(/Okta API token/);
    const noDomain = await failure(oktaPlugin.export!.run(context({ values: { 'okta-api-token': '00token' }, fetch: api.fetchImpl }).p, w.writer, resumeFrom().resume));
    expect(noDomain.message).toMatch(/your Okta domain/);
    const badGroups = await failure(
      oktaPlugin.export!.run(context({ values: { 'okta-domain': 'acme.okta.com', 'okta-api-token': '00token', 'groups-as': 'teams' }, fetch: api.fetchImpl }).p, w.writer, resumeFrom().resume),
    );
    expect(badGroups.message).toBe('Okta: --groups-as must be roles, organizations or skip (got teams).');
    expect(api.calls).toEqual([]);
    expect(w.adds).toEqual([]);
  });

  it('descope: the project id and management key are required', async () => {
    const w = new FakeWriter();
    const noProject = await failure(descopePlugin.export!.run(context({ values: { 'descope-management-key': 'K2key' } }).p, w.writer, resumeFrom().resume));
    expect(noProject.message).toMatch(/Descope project id/);
    const noKey = await failure(descopePlugin.export!.run(context({ env: { DESCOPE_PROJECT_ID: 'P2abcDEFghiJKLmno' } }).p, w.writer, resumeFrom().resume));
    expect(noKey.message).toMatch(/Descope management key/);
    expect(w.adds).toEqual([]);
  });
});

// ── one end-to-end export per vendor ────────────────────────────────────────

describe('clerk export.run', () => {
  // The dashboard CSV export's header row and rows (copied from export/clerk.test.ts).
  const CSV = [
    'id,first_name,last_name,username,primary_email_address,primary_phone_number,verified_email_addresses,unverified_email_addresses,verified_phone_numbers,unverified_phone_numbers,totp_secret,password_digest,password_hasher',
    'user_2a,Ada,Lovelace,,ada@example.com,+14155550100,ada@example.com,,+14155550100,,JBSWY3DPEHPK3PXP,$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy,bcrypt',
    'user_2b,Bob,,bobby,bob@example.com,,,bob@example.com,,,,pbkdf2_sha256$600000$c2FsdA==$aGFzaA==,pbkdf2_sha256',
    'user_gone,Old,User,,old@example.com,,old@example.com,,,,,,',
  ].join('\n');

  it('writes users and TOTP factors from the CSV alone, without calling Clerk', async () => {
    const api = fakeVendor('https://api.clerk.com', {});
    const csvPath = resolve('/fixtures/clerk-users.csv');
    const { p } = context({ values: { 'clerk-csv': '/fixtures/clerk-users.csv' }, files: { [csvPath]: CSV }, fetch: api.fetchImpl });
    const w = new FakeWriter();
    await clerkPlugin.export!.run(p, w.writer, resumeFrom().resume);
    expect(api.calls).toEqual([]);
    expect(w.described).toEqual([{ origin: null, providers: [] }]);
    expect(w.warnings[0]).toMatch(/dashboard CSV only/);
    expect(w.warnings.some((m) => m.includes('does not export passkeys'))).toBe(true);
    expect(w.omits).toEqual([]);
    expect(w.models()).toEqual(['user', 'user', 'user', 'mfa_factor']);
    expect(w.ids('user')).toEqual(['user_2a', 'user_2b', 'user_gone']);
    expect(w.adds[0]!.data).toMatchObject({ emails: [{ email: 'ada@example.com', verified: true, primary: true }], password: { algorithm: 'bcrypt' } });
    expect(w.adds[3]!.data).toMatchObject({ user_id: 'user_2a', type: 'totp', secret_base32: 'JBSWY3DPEHPK3PXP' });
  });
});

describe('auth0 export.run', () => {
  // A users export file as the dashboard / export job writes it (copied from export/auth0.test.ts).
  const EXPORTED = [
    {
      user_id: 'auth0|60d1f0c0ffee',
      email: 'Ada@Example.com',
      email_verified: true,
      given_name: 'Ada',
      family_name: 'Lovelace',
      identities: [{ provider: 'auth0', user_id: '60d1f0c0ffee', connection: 'Username-Password-Authentication', isSocial: false }],
      created_at: '2021-06-22T10:00:00.000Z',
    },
    {
      user_id: 'google-oauth2|1093849',
      email: 'grace@gmail.com',
      email_verified: true,
      identities: [{ provider: 'google-oauth2', user_id: '1093849', connection: 'google-oauth2', isSocial: true }],
      created_at: '2022-01-01T00:00:00.000Z',
      blocked: true,
    },
    {
      user_id: 'samlp|corp|ada@corp.example',
      email: 'ada@corp.example',
      email_verified: true,
      identities: [{ provider: 'samlp', user_id: 'corp|ada@corp.example', connection: 'corp', isSocial: false }],
    },
    { user_id: 'sms|60d2', identities: [{ provider: 'sms', user_id: '60d2', connection: 'sms' }] },
  ];

  it('works offline from a users file: no Management API call, users in canonical order', async () => {
    const api = fakeVendor('https://acme.us.auth0.com', {});
    const usersPath = resolve('/fixtures/auth0-users.ndjson');
    const { p } = context({
      values: { 'auth0-domain': 'https://acme.us.auth0.com/', 'auth0-users-file': '/fixtures/auth0-users.ndjson' },
      files: { [usersPath]: EXPORTED.map((u) => JSON.stringify(u)).join('\n') },
      fetch: api.fetchImpl,
    });
    const w = new FakeWriter();
    await auth0Plugin.export!.run(p, w.writer, resumeFrom().resume);
    expect(api.calls).toEqual([]);
    expect(w.ids('user')).toEqual(['auth0|60d1f0c0ffee', 'google-oauth2|1093849', 'samlp|corp|ada@corp.example']);
    expect(inCanonicalOrder(w.models())).toBe(true);
    expect(w.described).toHaveLength(1);
    expect(w.described[0]).toMatchObject({ origin: 'acme.us.auth0.com', rpId: null });
    expect(w.warnings).toContain('Exported from files only: organizations, roles and enterprise connections need Management API access.');
    expect(w.warnings.some((m) => m.startsWith('1 database user(s) without password hashes'))).toBe(true);
    expect(w.omits).toContainEqual(['user', 'no email, phone number or username', 1]);
  });
});

describe('okta export.run', () => {
  // Okta API responses (copied from export/okta.test.ts).
  const ORIGIN = 'https://acme.okta.com';
  const JANE = {
    id: '00u1janeABCD',
    status: 'ACTIVE',
    created: '2020-01-01T00:00:00.000Z',
    profile: { login: 'jane@acme.example', email: 'Jane@Acme.example', firstName: 'Jane', lastName: 'Doe' },
    credentials: { password: {}, provider: { type: 'OKTA', name: 'OKTA' } },
  };
  const SAM = {
    id: '00u2samEFGH',
    status: 'LOCKED_OUT',
    profile: { login: 'sam', email: 'sam@acme.example', firstName: 'Sam', lastName: 'Ray' },
    credentials: { emails: [{ value: 'sam@acme.example', status: 'VERIFIED', type: 'PRIMARY' }], provider: { type: 'OKTA' } },
  };
  const STAGED = { id: '00u3stg', status: 'STAGED', profile: { login: 'new@acme.example', email: 'new@acme.example' } };
  const SUSPENDED = { id: '00u4sus', status: 'SUSPENDED', profile: { login: 'gone@acme.example', email: 'gone@acme.example', displayName: 'Gone Person' } };

  it('reads users and groups (as roles) with the API token, only from the Okta org', async () => {
    const api = fakeVendor(ORIGIN, {
      'GET /api/v1/groups': [
        { id: '00g0every', type: 'BUILT_IN', profile: { name: 'Everyone' } },
        { id: '00g1eng', type: 'OKTA_GROUP', created: '2020-01-01T00:00:00.000Z', profile: { name: 'Engineering Team', description: 'Builders' } },
      ],
      'GET /api/v1/users?limit=200': { status: 200, body: [JANE, SAM], headers: { link: `<${ORIGIN}/api/v1/users?after=00u2samEFGH&limit=200>; rel="next"` } },
      'GET /api/v1/users?after=00u2samEFGH&limit=200': [STAGED, SUSPENDED],
      'GET /api/v1/groups/00g1eng/users': [{ id: '00u1janeABCD' }],
      'GET /api/v1/idps': [],
      'GET /oauth2/default/v1/keys': { keys: [{ kid: 'ak1', kty: 'RSA', alg: 'RS256', n: 'x', e: 'AQAB' }] },
    });
    const { p, said } = context({ values: { 'okta-domain': 'https://acme.okta.com/', 'okta-api-token': '00token' }, fetch: api.fetchImpl });
    const w = new FakeWriter();
    await oktaPlugin.export!.run(p, w.writer, resumeFrom().resume);
    expect(api.calls.length).toBeGreaterThan(0);
    expect(api.calls.every((c) => c.url.startsWith(`${ORIGIN}/`) && c.headers.get('authorization') === 'SSWS 00token')).toBe(true);
    expect(w.ids('user')).toEqual(['00u1janeABCD', '00u2samEFGH', '00u3stg', '00u4sus']);
    expect(w.adds.filter((a) => a.model === 'role').map((a) => a.data.key)).toEqual(['engineering_team']);
    expect(w.adds.find((a) => a.data.id === '00u1janeABCD')!.data.roles).toEqual(['engineering_team']);
    expect(inCanonicalOrder(w.models())).toBe(true);
    expect(w.warnings.some((m) => m.includes('never exports password hashes'))).toBe(true);
    expect(said.some((l) => l.startsWith('  reading '))).toBe(true);
  });
});

describe('kinde export.run', () => {
  // Kinde's data export (copied from export/kinde.test.ts).
  const USERS = [
    {
      id: 'kp_0a1b2c',
      email: 'Ada@Example.com',
      first_name: 'Ada',
      last_name: 'Lovelace',
      created_on: '2023-01-01T00:00:00.000000+00:00',
      identities: [{ type: 'email', identity: 'ada@example.com' }, { type: 'oauth2:google', identity: 'ada@example.com', provider: 'google' }],
      external_id: 'legacy-17',
      business_code: 'bus_1',
      organizations: ['org_default', 'org_acme'],
      email_verified: true,
      password: { hashed_password: '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', hashing_algorithm: 'bcrypt', hashing_config: {} },
    },
    {
      id: 'kp_ffee',
      email: 'bo@example.com',
      phone: '+61 412 345 678',
      username: 'bo',
      created_on: '2023-02-01T00:00:00.000000+00:00',
      identities: [{ type: 'email', identity: 'bo@example.com' }],
      business_code: 'bus_1',
      organizations: ['org_default'],
      email_verified: false,
      password: { hashed_password: '5f4dcc3b5aa765d61d8327deb882cf99', hashing_algorithm: 'md5', hashing_config: { salt: 'NaCl', salt_position: 'prefix' } },
    },
  ];
  const ORGS = [
    { name: 'Default Organization', created_on: '2023-01-01T00:00:00+00:00', business_code: 'bus_1', organization_code: 'org_default' },
    { name: 'Acme', created_on: '2023-01-02T00:00:00+00:00', business_code: 'bus_1', organization_code: 'org_acme' },
  ];
  const ndjson = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

  /** A minimal ZIP writer (deflated entries), the shape Kinde's export unpacks to. */
  function makeZip(files: Record<string, string>): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const [name, text] of Object.entries(files)) {
      const data = Buffer.from(text);
      const packed = deflateRawSync(data);
      const nameBuf = Buffer.from(name);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(8, 8);
      local.writeUInt32LE(packed.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(8, 10);
      central.writeUInt32LE(packed.length, 20);
      central.writeUInt32LE(data.length, 24);
      central.writeUInt16LE(nameBuf.length, 28);
      central.writeUInt32LE(offset, 42);
      locals.push(local, nameBuf, packed);
      centrals.push(central, nameBuf);
      offset += 30 + nameBuf.length + packed.length;
    }
    const cd = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Object.keys(files).length, 8);
    end.writeUInt16LE(Object.keys(files).length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, end]);
  }

  function encryptedExport() {
    const zip = makeZip({ 'export/users.ndjson': ndjson(USERS), 'export/organizations.ndjson': ndjson(ORGS), 'export/access_requests.ndjson': '' });
    const key = randomBytes(32);
    const iv = randomBytes(16);
    const c = createCipheriv('aes-256-ctr', key, iv);
    return { data: Buffer.concat([c.update(zip), c.final()]), key: key.toString('hex'), iv: iv.toString('hex') };
  }

  it('decrypts the .dat with the Key and IV and writes organizations, users and memberships', async () => {
    const enc = encryptedExport();
    const dat = join(dir, 'kinde-export.dat');
    writeFileSync(dat, enc.data);
    const { p } = context({ values: { 'kinde-export': dat, 'kinde-export-key': enc.key, 'kinde-export-iv': enc.iv } });
    const w = new FakeWriter();
    await kindePlugin.export!.run(p, w.writer, resumeFrom().resume);
    expect(w.ids('organization')).toEqual(['org_acme']);
    expect(w.ids('user')).toEqual(['kp_0a1b2c', 'kp_ffee']);
    expect(w.adds.find((a) => a.data.id === 'kp_0a1b2c')!.data.password).toEqual({ algorithm: 'bcrypt', hash: '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy' });
    expect(w.adds.filter((a) => a.model === 'membership').map((a) => a.data)).toEqual([{ organization_id: 'org_acme', user_id: 'kp_0a1b2c', role: 'member' }]);
    expect(inCanonicalOrder(w.models())).toBe(true);
    expect(w.omits.map((o) => o[0])).toContain('identity');
    expect(w.warnings.some((m) => m.includes('default organization (org_default)'))).toBe(true);
  });

  it('takes an already decrypted zip without the Key and IV', async () => {
    const zipPath = join(dir, 'kinde-export.zip');
    writeFileSync(zipPath, makeZip({ 'users.ndjson': ndjson(USERS) }));
    const w = new FakeWriter();
    await kindePlugin.export!.run(context({ values: { 'kinde-export': zipPath } }).p, w.writer, resumeFrom().resume);
    expect(w.ids('user')).toEqual(['kp_0a1b2c', 'kp_ffee']);
  });

  it('asks for the Key when the .dat comes without it', async () => {
    const dat = join(dir, 'kinde-nokey.dat');
    writeFileSync(dat, encryptedExport().data);
    const w = new FakeWriter();
    const err = await failure(kindePlugin.export!.run(context({ values: { 'kinde-export': dat } }).p, w.writer, resumeFrom().resume));
    expect(err.message).toMatch(/Key Kinde showed with the export/);
    expect(w.adds).toEqual([]);
  });
});

describe('descope export.run', () => {
  // Descope Management API responses (copied from export/descope.test.ts).
  const ORIGIN = 'https://api.descope.com';
  const PROJECT = 'P2abcDEFghiJKLmno';
  const KEY = 'K2mgmtSecretKey';
  const JANE = {
    userId: 'U2jane',
    loginIds: ['jane@acme.example'],
    name: 'Jane Doe',
    givenName: 'Jane',
    familyName: 'Doe',
    email: 'Jane@Acme.example',
    verifiedEmail: true,
    roleNames: ['Viewer'],
    userTenants: [{ tenantId: 'T1acme', tenantName: 'Acme Corp', roleNames: ['Tenant Admin'] }],
    status: 'enabled',
    test: false,
    createdTime: 1700000000,
  };
  const DISABLED = { userId: 'U2dis', loginIds: ['dis@acme.example'], email: 'dis@acme.example', verifiedEmail: true, roleNames: [], userTenants: [], status: 'disabled', test: false, createdTime: 1700000200 };
  const TEST_USER = { userId: 'U2test', loginIds: ['test@acme.example'], email: 'test@acme.example', verifiedEmail: true, status: 'enabled', test: true, userTenants: [] };

  it('reads tenants, roles and users with the project id from NEXT_PUBLIC_DESCOPE_PROJECT_ID', async () => {
    const api = fakeVendor(ORIGIN, {
      'GET /v1/mgmt/tenant/all': { tenants: [{ id: 'T1acme', name: 'Acme Corp', selfProvisioningDomains: ['acme.example'], customAttributes: {} }] },
      'GET /v1/mgmt/role/all': { roles: [{ name: 'Tenant Admin', description: 'Admins', permissionNames: [], tenantId: 'T1acme' }, { name: 'Viewer', permissionNames: [] }] },
      'POST /v2/mgmt/user/search': { users: [JANE, DISABLED, TEST_USER] },
      'POST /v1/mgmt/accesskey/search': { keys: [] },
    });
    const { p } = context({ env: { NEXT_PUBLIC_DESCOPE_PROJECT_ID: PROJECT }, values: { 'descope-management-key': KEY }, fetch: api.fetchImpl });
    const w = new FakeWriter();
    await descopePlugin.export!.run(p, w.writer, resumeFrom().resume);
    expect(api.calls.every((c) => c.url.startsWith(`${ORIGIN}/`) && c.headers.get('authorization') === `Bearer ${PROJECT}:${KEY}`)).toBe(true);
    expect(w.ids('organization')).toEqual(['T1acme']);
    expect(w.ids('user')).toEqual(['U2jane', 'U2dis']);
    expect(w.adds.find((a) => a.data.id === 'U2dis')!.data.banned).toBe(true);
    expect(w.adds.filter((a) => a.model === 'membership').map((a) => a.data)).toEqual([{ organization_id: 'T1acme', user_id: 'U2jane', role: 'tenant_admin' }]);
    expect(inCanonicalOrder(w.models())).toBe(true);
    expect(w.omits).toContainEqual(['user', 'test user', 1]);
  });
});
