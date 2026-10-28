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
import { authentikPlugin } from './plugin';

const DUMP = join(__dirname, '../export/__fixtures__/authentik/dump');

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
  dir = mkdtempSync(join(tmpdir(), 'atlas-authentik-plugin-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('authentikPlugin', () => {
  it('points at the source profile presets and a codemod `atlas migrate code` knows', () => {
    const profile = SOURCE_PROFILES[authentikPlugin.source];
    expect(authentikPlugin.bridge?.preset).toBe(profile.bridgePreset);
    expect(authentikPlugin.lazy?.preset).toBe(profile.lazyPreset);
    expect(MIGRATE_VENDORS as readonly string[]).toContain(authentikPlugin.codemod);
    for (const step of [authentikPlugin.config?.credentials ?? [], authentikPlugin.export?.credentials ?? []]) {
      expect(new Set(step.map((c) => c.flag)).size).toBe(step.length);
      for (const c of step) {
        expect(c.flag).toMatch(/^--[a-z0-9-]+$/);
        expect(c.env).toMatch(/^[A-Z0-9_]+$/);
      }
    }
    expect(authentikPlugin.export?.limits?.join(' ')).toMatch(/never returns password hashes/);
  });

  it('exports a folder of table dumps', async () => {
    const { p } = context(dir, { values: { 'authentik-dump': DUMP }, env: { AUTHENTIK_TRUST_EMAILS: 'true' } });
    const w = new FakeWriter();
    await authentikPlugin.export!.run(p, w.writer, noResume);
    expect(w.of('user')).toHaveLength(7);
    expect(w.of('user').every((u) => (u.emails as Array<{ verified: boolean }> | undefined)?.every((e) => e.verified) ?? true)).toBe(true);
    expect(w.of('mfa_factor').length).toBeGreaterThanOrEqual(4);
    expect(w.of('api_key')).toHaveLength(2);
    expect(w.described[0]).toMatchObject({ origin: 'authentik database dump' });
  });

  it('exports through the API with the token on the Authorization header only', async () => {
    const BASE = 'https://auth.example.com';
    const page = (results: unknown[]) => ({ pagination: { next: 0 }, results });
    const api = fakeVendor(BASE, {
      'GET /api/v3/core/groups/': page([]),
      'GET /api/v3/core/users/': page([{ pk: 1, uid: 'h1', username: 'ada', email: 'ada@example.com', is_active: true, attributes: {} }]),
    });
    const { p, said } = context(dir, { values: { 'authentik-url': BASE, 'authentik-sub-mode': 'hashed_user_id' }, env: { AUTHENTIK_TOKEN: 'tok-9' }, fetch: api.fetchImpl });
    const w = new FakeWriter();
    await authentikPlugin.export!.run(p, w.writer, noResume);
    expect(w.of('user')).toEqual([expect.objectContaining({ id: 'h1' })]);
    expect(api.calls.every((c) => c.headers.get('authorization') === 'Bearer tok-9' && !c.url.includes('tok-9'))).toBe(true);
    expect(said).toContain('  reading users');
  });

  it('names every way in, and rejects bad option values', async () => {
    const none = await failure(authentikPlugin.export!.run(context(dir).p, new FakeWriter().writer, noResume));
    expect(none).toBeInstanceOf(CliError);
    expect(none.message).toMatch(/authentik-dump/);
    expect(none.message).toMatch(/API token/);
    const badGroups = await failure(authentikPlugin.export!.run(context(dir, { values: { 'authentik-dump': DUMP, 'authentik-groups-as': 'teams' } }).p, new FakeWriter().writer, noResume));
    expect(badGroups.message).toMatch(/roles, organizations or skip/);
    const badMode = await failure(authentikPlugin.export!.run(context(dir, { values: { 'authentik-dump': DUMP, 'authentik-sub-mode': 'nope' } }).p, new FakeWriter().writer, noResume));
    expect(badMode.message).toMatch(/authentik-sub-mode/);
  });

  it('turns an unreadable dump into a vendor-prefixed CLI error', async () => {
    const err = await failure(authentikPlugin.export!.run(context(dir, { values: { 'authentik-dump': join(dir, 'missing') } }).p, new FakeWriter().writer, noResume));
    expect(err).toBeInstanceOf(CliError);
    expect(err.message).toMatch(/^authentik:/);
  });

  it('translates a blueprint file and cites it', async () => {
    const file = join(dir, 'blueprint.yaml');
    writeFileSync(file, 'version: 1\nentries:\n  - model: authentik_policies_password.passwordpolicy\n    identifiers:\n      name: pw\n    attrs:\n      length_min: 14\n');
    const t = await authentikPlugin.config!.translate(context(dir, { values: { 'authentik-blueprint': file } }).p);
    expect(t.report[0]).toMatchObject({ file, line: 3, status: 'mapped' });
    expect(t.documents.instance).toEqual({ auth_config: { passwordPolicy: { minLength: 14 } } });
    const none = await failure(authentikPlugin.config!.translate(context(dir).p));
    expect(none.message).toMatch(/authentik-blueprint/);
    const missing = await failure(authentikPlugin.config!.translate(context(dir, { values: { 'authentik-blueprint': join(dir, 'nope.yaml') } }).p));
    expect(missing).toBeInstanceOf(CliError);
  });

  it('builds the bridge variables and the lazy settings from flags over the translation', () => {
    const { p } = context(dir, { values: { 'authentik-issuer': 'https://auth.example.com/application/o/grafana/', 'authentik-client-id': 'grafana', 'authentik-url': 'https://auth.example.com/', 'authentik-flow-slug': 'corp-login', 'authentik-sub-mode': 'user_username' } });
    expect(authentikPlugin.bridge!.vars(p)).toEqual({ issuer: 'https://auth.example.com/application/o/grafana', client_id: 'grafana' });
    const t = { origin: 'x', documents: {}, report: [], env: [], mappings: { providers: {}, roles: {} }, lazy: { preset: 'authentik', config: { base_url: 'https://old.example.com', sub_mode: 'hashed_user_id' } } };
    expect(authentikPlugin.lazy!.config(p, t)).toEqual({ base_url: 'https://auth.example.com', sub_mode: 'user_username', flow_slug: 'corp-login' });
    const uuid = context(dir, { values: { 'authentik-sub-mode': 'user_uuid' } }).p;
    expect(() => authentikPlugin.lazy!.config(uuid)).toThrow(/database export/);
  });
});
