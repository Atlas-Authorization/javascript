import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MigrationBundleWriter } from '@atlasauth/migrate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ParsedArgs } from '../../args';
import type { RunContext } from '../../context';
import { CliError } from '../../errors';
import { registerBuiltInPlugins } from '../framework/builtins';
import type { CredentialSpec, MigrationPlugin, PluginContext, TranslationResult } from '../framework/plugin';
import { migrationPlugin, resetMigrationPlugins } from '../framework/registry';
import { FRAMEWORK_PLUGINS, authJsPlugin, bridgeSecret, devisePlugin, djangoPlugin, ironSessionPlugin, luciaPlugin, parsePairs, passportPlugin } from './plugins';

/**
 * The framework plugins as the orchestrator drives them: inputs checked before
 * anything is fetched, dumps and export-script streams read into the bundle
 * writer, the export script written for Devise / Django when no input is
 * given, bridge variables and lazy settings resolved from the translation and
 * `--set`. A fake writer records what would be sealed.
 */
const FIXTURES = join(__dirname, '../../../fixtures/frameworks');

class FakeWriter {
  records: Array<[string, Record<string, unknown>]> = [];
  warnings: string[] = [];
  omitted: Record<string, number> = {};
  warn(message: string) {
    this.warnings.push(message);
  }
  omit(model: string, _reason: string, count = 1) {
    this.omitted[model] = (this.omitted[model] ?? 0) + count;
  }
  async add(model: string, data: Record<string, unknown>) {
    this.records.push([model, data]);
    return [];
  }
  ids(model: string): string[] {
    return this.records.filter(([m]) => m === model).map(([, d]) => String(d.id));
  }
}

let project: string;
let said: string[];

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'atlas-fw-plugins-'));
  said = [];
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

function pctx(opts: { sets?: Record<string, string>; env?: Record<string, string>; file?: string; dryRun?: boolean } = {}): PluginContext {
  const sets = opts.sets ?? {};
  const env = opts.env ?? {};
  return {
    ctx: { readFile: (p: string) => readFileSync(p, 'utf8'), env } as unknown as RunContext,
    args: { positionals: [], values: opts.file ? { file: opts.file } : {} } as ParsedArgs,
    project,
    credential(spec: CredentialSpec) {
      const name = spec.flag.replace(/^--/, '');
      const v = sets[name] ?? env[spec.env];
      if (v) return v;
      if (spec.required) throw new CliError(`${spec.label} is needed`);
      return undefined;
    },
    fetch: (() => {
      throw new Error('no vendor calls');
    }) as unknown as typeof fetch,
    say: (line) => said.push(line),
    dryRun: opts.dryRun ?? false,
  };
}

async function exportWith(plugin: MigrationPlugin, p: PluginContext): Promise<FakeWriter> {
  const writer = new FakeWriter();
  plugin.export!.check?.(p);
  await plugin.export!.run(p, writer as unknown as MigrationBundleWriter, { cursor: null, checkpoint: () => {} });
  return writer;
}

describe('registry', () => {
  afterEach(() => resetMigrationPlugins());

  it('registers every framework under its CLI spelling and its aliases', () => {
    resetMigrationPlugins();
    registerBuiltInPlugins();
    expect(migrationPlugin('authjs')).toBe(authJsPlugin);
    expect(migrationPlugin('next-auth')).toBe(authJsPlugin);
    expect(migrationPlugin('nextauth')).toBe(authJsPlugin);
    expect(migrationPlugin('lucia')).toBe(luciaPlugin);
    expect(migrationPlugin('passport')).toBe(passportPlugin);
    expect(migrationPlugin('express-session')).toBe(passportPlugin);
    expect(migrationPlugin('iron-session')).toBe(ironSessionPlugin);
    expect(migrationPlugin('iron_session')).toBe(ironSessionPlugin);
    expect(migrationPlugin('devise')).toBe(devisePlugin);
    expect(migrationPlugin('rails')).toBe(devisePlugin);
    expect(migrationPlugin('django')).toBe(djangoPlugin);
    expect(migrationPlugin('allauth')).toBe(djangoPlugin);
  });

  it('gives every plugin a translator, an exporter and a bridge; codemods where one exists', () => {
    for (const p of FRAMEWORK_PLUGINS) {
      expect(p.config, p.vendor).toBeDefined();
      expect(p.export?.limits?.length, p.vendor).toBeGreaterThan(0);
      expect(p.bridge?.preset, p.vendor).toBeTruthy();
    }
    expect(FRAMEWORK_PLUGINS.filter((p) => p.codemod).map((p) => p.codemod)).toEqual(['authjs', 'lucia', 'passport', 'iron-session']);
    expect(FRAMEWORK_PLUGINS.filter((p) => p.lazy).map((p) => [p.vendor, p.lazy!.preset, p.lazy!.optional])).toEqual([
      ['authjs', 'authjs_credentials', true],
      ['devise', 'devise_json', true],
      ['django', 'allauth_headless', true],
    ]);
  });
});

describe('export inputs', () => {
  it('stops a dump-based export before anything is fetched when no dump is given', () => {
    for (const plugin of [authJsPlugin, luciaPlugin, passportPlugin, ironSessionPlugin]) {
      expect(() => plugin.export!.check!(pctx()), plugin.vendor).toThrow(/--set dump=<dir>/);
    }
  });

  it('writes the Rails export script and says how to pipe it in', () => {
    expect(() => devisePlugin.export!.check!(pctx())).toThrow(/bin\/rails runner atlas-migrate\/devise\/atlas_export\.rb \[User\] \| atlas migrate devise export --file -/);
    const script = join(project, 'atlas-migrate', 'devise', 'atlas_export.rb');
    expect(readFileSync(script, 'utf8')).toContain('bin/rails runner atlas_export.rb');
  });

  it('writes the Django export script, but not on a dry run', () => {
    expect(() => djangoPlugin.export!.check!(pctx({ dryRun: true }))).toThrow(/python manage\.py shell </);
    expect(existsSync(join(project, 'atlas-migrate', 'django', 'atlas_export.py'))).toBe(false);
    expect(() => djangoPlugin.export!.check!(pctx())).toThrow(CliError);
    expect(readFileSync(join(project, 'atlas-migrate', 'django', 'atlas_export.py'), 'utf8')).toContain('call_command("dumpdata"');
  });

  it('rejects malformed settings', () => {
    const p = pctx({ sets: { dump: join(FIXTURES, 'passport-mongo'), 'plm-digest': 'md5' } });
    return expect(exportWith(passportPlugin, p)).rejects.toThrow(/plm-digest/);
  });

  it('parses provider=column pairs', () => {
    expect(parsePairs('google=googleId, github = github_id')).toEqual({ google: 'googleId', github: 'github_id' });
    expect(() => parsePairs('google')).toThrow(/provider=column/);
  });
});

describe('exports', () => {
  it('Auth.js: a Prisma dump folder', async () => {
    const w = await exportWith(authJsPlugin, pctx({ sets: { dump: join(FIXTURES, 'authjs-prisma'), 'rp-id': 'example.com' } }));
    expect(w.ids('user')).toEqual(['clu1ada', 'clu2grace', 'clu4plain']);
    expect(w.records.some(([m]) => m === 'identity')).toBe(true);
    // Canonical order: every user before the first identity.
    const models = w.records.map(([m]) => m);
    expect(models.lastIndexOf('user')).toBeLessThan(models.indexOf('identity'));
    expect(said.at(-1)).toMatch(/^ {2}read .*\d+ user/);
  });

  it('Auth.js: OAuth tokens only on request', async () => {
    const plain = await exportWith(authJsPlugin, pctx({ sets: { dump: join(FIXTURES, 'authjs-prisma') } }));
    const withTokens = await exportWith(authJsPlugin, pctx({ sets: { dump: join(FIXTURES, 'authjs-prisma'), 'oauth-tokens': 'true' } }));
    const tokenKeys = (w: FakeWriter) => w.records.filter(([m]) => m === 'identity').flatMap(([, d]) => Object.keys(d).filter((k) => /token/i.test(k)));
    expect(tokenKeys(plain)).toEqual([]);
    expect(tokenKeys(withTokens).length).toBeGreaterThan(0);
  });

  it('Passport: users and provider identities from a mongoexport folder', async () => {
    const w = await exportWith(passportPlugin, pctx({ sets: { dump: join(FIXTURES, 'passport-mongo') } }));
    expect(w.ids('user')[0]).toBe('64b000000000000000000001');
    expect(w.records.filter(([m]) => m === 'identity').map(([, d]) => d.provider)).toEqual(['google']);
  });

  it('iron-session: never exports sessions (they live only in the cookie)', async () => {
    const w = await exportWith(ironSessionPlugin, pctx({ sets: { dump: join(FIXTURES, 'passport-mongo') } }));
    expect(w.ids('user').length).toBeGreaterThan(0);
    expect(w.records.some(([m]) => m === 'session')).toBe(false);
  });

  it('Lucia: v2 tables from sqlite3 -json', async () => {
    const w = await exportWith(luciaPlugin, pctx({ sets: { dump: join(FIXTURES, 'lucia-v2') } }));
    expect(w.ids('user').length).toBeGreaterThan(0);
  });

  it('Devise: the Rails runner stream from a file, boot noise and all', async () => {
    const w = await exportWith(devisePlugin, pctx({ file: join(FIXTURES, 'devise', 'rails-runner.ndjson') }));
    expect(w.ids('user')).toEqual(expect.arrayContaining(['17', '18']));
    expect(w.records.filter(([m]) => m === 'mfa_factor').map(([, d]) => d.type)).toEqual(['totp', 'backup_codes']);
  });

  it('Django: plain dumpdata JSON passed as a single file', async () => {
    const w = await exportWith(djangoPlugin, pctx({ file: join(FIXTURES, 'django', 'dumpdata.json'), sets: { 'rp-id': 'example.com' } }));
    expect(w.ids('user')[0]).toBe('1');
    expect(w.records.some(([m]) => m === 'identity')).toBe(true);
  });
});

describe('bridge and lazy settings', () => {
  const translation = (extra: Partial<TranslationResult>): TranslationResult => ({
    origin: 'test',
    documents: {},
    report: [],
    env: [],
    mappings: { providers: {}, roles: {} },
    ...extra,
  });

  it('takes the cookie name from the translation, a --set over it', () => {
    const t = translation({ bridge: { preset: 'authjs_jwt', vars: { cookie_name: 'legacy.session' } } });
    expect(authJsPlugin.bridge!.vars(pctx(), t)).toEqual({ cookie_name: 'legacy.session' });
    expect(authJsPlugin.bridge!.vars(pctx({ sets: { 'cookie-name': '__Secure-x' } }), t)).toEqual({ cookie_name: '__Secure-x' });
    expect(passportPlugin.bridge!.vars(pctx({ env: { ATLAS_BRIDGE_COOKIE_NAME: 'api.sid' } }), undefined)).toEqual({ cookie_name: 'api.sid' });
  });

  it('reads lazy-migration settings, dropping placeholders the source could not resolve', () => {
    const t = translation({ lazy: { preset: 'devise_json', config: { base_url: '${APP_URL}', scope: 'admin' } } });
    expect(devisePlugin.lazy!.config(pctx(), t)).toEqual({ scope: 'admin' });
    expect(devisePlugin.lazy!.config(pctx({ sets: { 'base-url': 'https://app.example.com' } }), t)).toEqual({ base_url: 'https://app.example.com', scope: 'admin' });
    expect(djangoPlugin.lazy!.config(pctx({ sets: { 'base-url': 'https://app.example.com', 'login-field': 'username' } }), undefined)).toEqual({
      base_url: 'https://app.example.com',
      login_field: 'username',
    });
  });

  it('keeps one bridge secret per vendor for assertion presets only', () => {
    const p = pctx();
    expect(bridgeSecret(p, 'authjs', 'authjs')).toBeUndefined();
    expect(bridgeSecret(p, 'devise', 'devise_active_record')).toBeUndefined();
    const first = bridgeSecret(p, 'authjs', 'authjs_jwt')!;
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const path = join(project, 'atlas-migrate', 'authjs', 'bridge-secret');
    expect(readFileSync(path, 'utf8').trim()).toBe(first);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // The same secret on the next run (the server already has it), a given one over it.
    expect(bridgeSecret(pctx(), 'authjs', 'authjs_jwt')).toBe(first);
    expect(bridgeSecret(pctx({ sets: { 'bridge-secret': 'given-secret-0123456789' } }), 'authjs', 'authjs_jwt')).toBe('given-secret-0123456789');
    expect(authJsPlugin.bridge!.sharedSecret!(pctx(), 'authjs_jwt')).toBe(first);
  });
});
