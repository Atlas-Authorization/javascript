import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SOURCE_PROFILES, type MigrationBundleWriter, type RecordIssue } from '@atlasauth/migrate';
import { MIGRATE_VENDORS } from '@atlasauth/upgrade';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ParsedArgs } from '../../args';
import type { RunContext } from '../../context';
import { CliError } from '../../errors';
import { fakeVendor, type Route } from '../export/fake-vendor.test-helper';
import type { CredentialSpec, PluginContext } from '../framework/plugin';
import { zitadelPlugin } from './plugin';

/** The ZITADEL plugin as the framework drives it: export (file and admin API), config, the bridge issuer and lazy settings. */

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
  adds: Array<{ model: string; data: Record<string, unknown> }> = [];
  describe(fields: unknown): void {
    this.described.push(fields);
  }
  warn(): void {}
  omit(): void {}
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
  dir = mkdtempSync(join(tmpdir(), 'atlas-zitadel-plugin-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ORIGIN = 'https://acme-abc123.zitadel.cloud';
const BCRYPT = '$2a$12$o6hx.Wog/wvFSkT/Bp/6DOxCtLRTDj7lm9on9suF/WaCGNVHbkfL6';
const ACME = { orgId: '1001', org: { name: 'Acme' }, loginPolicy: { allowRegister: false }, humanUsers: [{ userId: 'u1', user: { userName: 'jane@acme.com', email: { email: 'jane@acme.com', isEmailVerified: true }, hashedPassword: { value: BCRYPT, algorithm: 'bcrypt' } } }] };
const GLOBEX = { orgId: '1002', org: { name: 'Globex' }, humanUsers: [{ userId: 'u2', user: { userName: 'kim', email: { email: 'kim@globex.com' } } }] };

describe('zitadelPlugin', () => {
  it('points at its source profile and codemod, with one flag and env var per credential', () => {
    const profile = SOURCE_PROFILES.zitadel;
    expect(zitadelPlugin.source).toBe('zitadel');
    expect(zitadelPlugin.bridge?.preset).toBe(profile.bridgePreset);
    expect(zitadelPlugin.lazy?.preset).toBe(profile.lazyPreset);
    expect(zitadelPlugin.lazy?.secret?.flag).toBe('--zitadel-token');
    expect(MIGRATE_VENDORS as readonly string[]).toContain(zitadelPlugin.codemod);
    for (const step of [zitadelPlugin.config?.credentials ?? [], zitadelPlugin.export?.credentials ?? []]) {
      const flags = step.map((c) => c.flag);
      expect(new Set(flags).size).toBe(flags.length);
      for (const c of step) {
        expect(c.flag).toMatch(/^--[a-z0-9-]+$/);
        expect(c.env).toMatch(/^[A-Z0-9_]+$/);
      }
    }
  });

  it('exports a `zitadel export` file; organizations follow the instance unless told otherwise', async () => {
    const file = join(dir, 'export.json');
    writeFileSync(file, JSON.stringify({ orgs: [ACME, GLOBEX] }));
    const run = async (values: Record<string, unknown>) => {
      const w = new FakeWriter();
      await zitadelPlugin.export!.run(context(dir, { values: { 'zitadel-export': file, ...values } }).p, w.writer, noResume);
      return w;
    };
    const auto = await run({});
    expect(auto.of('user').map((u) => u.id)).toEqual(['u1', 'u2']);
    expect(auto.of('user')[0]).toMatchObject({ password: { algorithm: 'bcrypt', hash: BCRYPT } });
    expect(auto.of('organization').map((o) => o.name)).toEqual(['Acme', 'Globex']);
    expect((await run({ 'zitadel-orgs': 'skip' })).of('organization')).toEqual([]);
    expect((await run({ 'zitadel-url': ORIGIN })).described[0]).toMatchObject({ origin: 'ZITADEL acme-abc123.zitadel.cloud' });
    await expect(run({ 'zitadel-orgs': 'some' })).rejects.toThrow(/auto, all or skip/);
  });

  it('exports through the admin API with a service-user token, and asks for what is missing', async () => {
    const routes: Record<string, Route> = {
      'POST /admin/v1/export': { orgs: [ACME] },
      'POST /admin/v1/idps/templates/_search': { result: [] },
    };
    const api = fakeVendor(ORIGIN, routes);
    const { p, said } = context(dir, { values: { 'zitadel-url': 'acme-abc123.zitadel.cloud', 'zitadel-token': 'pat' }, fetch: api.fetchImpl });
    const w = new FakeWriter();
    await zitadelPlugin.export!.run(p, w.writer, noResume);
    expect(w.of('user')).toHaveLength(1);
    expect(api.calls[0]!.headers.get('authorization')).toBe('Bearer pat');
    expect(said).toContain('  reading the instance export');

    const noToken = context(dir, { values: { 'zitadel-url': ORIGIN } });
    await expect(zitadelPlugin.export!.run(noToken.p, new FakeWriter().writer, noResume)).rejects.toThrow(/zitadel-token/);
    await expect(zitadelPlugin.export!.run(context(dir).p, new FakeWriter().writer, noResume)).rejects.toThrow(/zitadel-export/);
  });

  it('translates an export file, learning the issuer from the instance URL', async () => {
    const file = join(dir, 'export-config.json');
    writeFileSync(file, JSON.stringify({ orgs: [ACME] }));
    const { p } = context(dir, { values: { 'zitadel-export': file, 'zitadel-url': ORIGIN } });
    const t = await zitadelPlugin.config!.translate(p);
    expect((t.documents.instance as { auth_config: Record<string, unknown> }).auth_config).toMatchObject({ signUpMode: 'restricted' });
    expect(zitadelPlugin.bridge!.vars(p, t)).toEqual({ issuer: ORIGIN });
    expect(zitadelPlugin.lazy!.config(p, t)).toEqual({ base_url: ORIGIN });
    await expect(zitadelPlugin.config!.translate(context(dir).p)).rejects.toThrow(/zitadel-export/);
  });

  it('refuses a bridge without an issuer and an unreadable export', async () => {
    expect(() => zitadelPlugin.bridge!.vars(context(dir).p)).toThrow(/issuer/);
    await expect(zitadelPlugin.config!.translate(context(dir, { values: { 'zitadel-export': join(dir, 'missing.json') } }).p)).rejects.toThrow(/could not read the export/);
  });
});
