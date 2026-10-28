import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SOURCE_PROFILES, type MigrationBundleWriter, type RecordIssue } from '@atlasauth/migrate';
import { MIGRATE_VENDORS } from '@atlasauth/upgrade';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ParsedArgs } from '../../args';
import type { RunContext } from '../../context';
import { CliError } from '../../errors';
import { fakeVendor } from '../export/fake-vendor.test-helper';
import type { CredentialSpec, PluginContext } from '../framework/plugin';
import { hankoPlugin } from './plugin';

const DUMP = join(__dirname, '../export/__fixtures__/hanko/db');

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
    fetch: opts.fetch ?? ((async () => { throw new Error('no vendor API in this test'); }) as typeof fetch),
    say: (line) => void said.push(line),
    dryRun: false,
  };
  return { p, said };
}

class FakeWriter {
  described: Array<Record<string, unknown>> = [];
  adds: Array<{ model: string; data: Record<string, unknown> }> = [];
  describe(fields: unknown): void {
    this.described.push(fields as Record<string, unknown>);
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
const failure = (run: Promise<unknown>) => run.then(() => new Error('expected a failure'), (e: unknown) => e as Error);

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-hanko-plugin-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('hankoPlugin', () => {
  it('points at the source profile presets and a codemod `atlas migrate code` knows', () => {
    const profile = SOURCE_PROFILES[hankoPlugin.source];
    expect(hankoPlugin.bridge?.preset).toBe(profile.bridgePreset);
    expect(hankoPlugin.lazy?.preset).toBe(profile.lazyPreset);
    expect(MIGRATE_VENDORS as readonly string[]).toContain(hankoPlugin.codemod);
    for (const step of [hankoPlugin.config?.credentials ?? [], hankoPlugin.export?.credentials ?? []]) {
      expect(new Set(step.map((c) => c.flag)).size).toBe(step.length);
      for (const c of step) {
        expect(c.flag).toMatch(/^--[a-z0-9-]+$/);
        expect(c.env).toMatch(/^[A-Z0-9_]+$/);
      }
    }
    expect(hankoPlugin.export?.limits?.join(' ')).toMatch(/never returns password hashes or TOTP secrets/);
  });

  it('exports a database dump, with passkeys when the relying-party id is given', async () => {
    const w = new FakeWriter();
    await hankoPlugin.export!.run(context(dir, { values: { 'hanko-dump': DUMP, 'hanko-rp-id': 'example.com' } }).p, w.writer, noResume);
    expect(w.of('user')).toHaveLength(3);
    expect(w.of('passkey')).toHaveLength(2);
    expect(w.of('mfa_factor')).toHaveLength(1);
    expect(w.described[0]).toMatchObject({ origin: 'Hanko database dump', rpId: 'example.com' });
    const without = new FakeWriter();
    await hankoPlugin.export!.run(context(dir, { values: { 'hanko-dump': DUMP } }).p, without.writer, noResume);
    expect(without.of('passkey')).toHaveLength(0);
  });

  it('exports through the Admin API with the key as a bearer header, and reads the signing keys from the public API', async () => {
    const ADMIN = 'https://admin.hanko.test';
    const api = fakeVendor(ADMIN, {
      'GET /users': [{ id: 'u1' }],
      'GET /users/u1': { id: 'u1', emails: [{ id: 'e1', address: 'ada@example.com', is_verified: true, is_primary: true }] },
      'GET /.well-known/jwks.json': { keys: [{ kty: 'RSA', kid: 'k1', n: 'abc', e: 'AQAB' }] },
    });
    const { p, said } = context(dir, { values: { 'hanko-admin-url': ADMIN, 'hanko-api-url': 'https://api.hanko.test' }, env: { HANKO_API_KEY: 'key-7' }, fetch: api.fetchImpl });
    const w = new FakeWriter();
    await hankoPlugin.export!.run(p, w.writer, noResume);
    expect(w.of('user')).toEqual([expect.objectContaining({ id: 'u1' })]);
    expect(w.of('jwks')).toHaveLength(1);
    expect(api.calls.some((c) => c.headers.get('authorization') === 'Bearer key-7')).toBe(true);
    expect(api.calls.every((c) => !c.url.includes('key-7'))).toBe(true);
    expect(said).toContain('  reading users');
  });

  it('names every way in and turns vendor errors into CLI errors', async () => {
    const none = await failure(hankoPlugin.export!.run(context(dir).p, new FakeWriter().writer, noResume));
    expect(none).toBeInstanceOf(CliError);
    expect(none.message).toMatch(/hanko-dump/);
    expect(none.message).toMatch(/hanko-admin-url/);
    const bad = await failure(hankoPlugin.export!.run(context(dir, { values: { 'hanko-dump': join(dir, 'missing') } }).p, new FakeWriter().writer, noResume));
    expect(bad).toBeInstanceOf(CliError);
    expect(bad.message).toMatch(/^Hanko:/);
  });

  it('translates config.yaml from the project folder or a flag, and says what to do for Hanko Cloud', async () => {
    writeFileSync(join(dir, 'config.yaml'), 'password:\n  enabled: true\n  min_length: 12\n');
    const t = await hankoPlugin.config!.translate(context(dir, { values: { 'hanko-api-url': 'https://auth.example.com/' } }).p);
    expect(t.documents.instance).toEqual({ auth_config: { strategies: { password: true }, passwordPolicy: { minLength: 12 } } });
    expect(t.report.find((r) => r.setting === 'password.min_length')).toMatchObject({ file: join(dir, 'config.yaml'), line: 3 });
    expect(t.bridge).toEqual({ preset: 'hanko', vars: { base_url: 'https://auth.example.com' } });
    const missing = await failure(hankoPlugin.config!.translate(context(join(dir, 'nowhere')).p));
    expect(missing).toBeInstanceOf(CliError);
    expect(missing.message).toMatch(/Hanko Cloud/);
  });

  it('picks the custom-issuer bridge preset when an issuer is given, and builds the lazy settings', () => {
    const plain = context(dir, { values: { 'hanko-api-url': 'https://auth.example.com' } }).p;
    expect(hankoPlugin.bridge!.presetFor!(plain)).toBe('hanko');
    expect(hankoPlugin.bridge!.vars(plain)).toEqual({ base_url: 'https://auth.example.com' });
    const custom = context(dir, { values: { 'hanko-api-url': 'https://auth.example.com', 'hanko-issuer': 'https://example.com/' } }).p;
    expect(hankoPlugin.bridge!.presetFor!(custom)).toBe('hanko_jwt');
    expect(hankoPlugin.bridge!.vars(custom)).toEqual({ base_url: 'https://auth.example.com', issuer: 'https://example.com' });
    expect(hankoPlugin.lazy!.config(plain)).toEqual({ base_url: 'https://auth.example.com' });
  });
});
