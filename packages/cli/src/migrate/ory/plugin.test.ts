import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { oryPlugin } from './plugin';

/** The Ory plugin as the framework drives it: export (dump folder and Admin API), config, bridge presets and lazy settings. */

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
  dir = mkdtempSync(join(tmpdir(), 'atlas-ory-plugin-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const BCRYPT = '$2a$12$o6hx.Wog/wvFSkT/Bp/6DOxCtLRTDj7lm9on9suF/WaCGNVHbkfL6';

describe('oryPlugin', () => {
  it('points at its source profile and codemod, with one flag and env var per credential', () => {
    const profile = SOURCE_PROFILES.ory;
    expect(oryPlugin.source).toBe('ory');
    // Before the bridge step chooses a mode, the preset is the profile's.
    expect(oryPlugin.bridge?.preset).toBe(profile.bridgePreset);
    expect(oryPlugin.lazy?.preset).toBe(profile.lazyPreset);
    expect(MIGRATE_VENDORS as readonly string[]).toContain(oryPlugin.codemod);
    for (const step of [oryPlugin.config?.credentials ?? [], oryPlugin.export?.credentials ?? []]) {
      const flags = step.map((c) => c.flag);
      expect(new Set(flags).size).toBe(flags.length);
      for (const c of step) {
        expect(c.flag).toMatch(/^--[a-z0-9-]+$/);
        expect(c.env).toMatch(/^[A-Z0-9_]+$/);
      }
    }
  });

  it('exports a dump folder, with passkeys bound to the relying-party id', async () => {
    const dump = join(dir, 'dump');
    mkdirSync(dump, { recursive: true });
    writeFileSync(join(dump, 'identities.json'), JSON.stringify([{ id: 'i1', schema_id: 'default', state: 'active', traits: { email: 'jane@example.com' }, created_at: '2024-01-01T00:00:00Z' }]));
    writeFileSync(join(dump, 'identity_credential_types.json'), JSON.stringify([{ id: 't1', name: 'password' }, { id: 't2', name: 'webauthn' }]));
    writeFileSync(
      join(dump, 'identity_credentials.json'),
      JSON.stringify([
        { id: 'c1', identity_id: 'i1', identity_credential_type_id: 't1', config: { hashed_password: BCRYPT } },
        { id: 'c2', identity_id: 'i1', identity_credential_type_id: 't2', config: { credentials: [{ id: 'AQIDBA==', public_key: 'pQECAyYgASFY', authenticator: { sign_count: 1 }, is_passwordless: true }] } },
      ]),
    );
    const { p } = context(dir, { values: { 'ory-dump': dump, 'ory-rp-id': 'example.com' } });
    const w = new FakeWriter();
    await oryPlugin.export!.run(p, w.writer, noResume);
    expect(w.of('user')[0]).toMatchObject({ id: 'i1', password: { algorithm: 'bcrypt', hash: BCRYPT } });
    expect(w.of('passkey')[0]).toMatchObject({ user_id: 'i1', rp_id: 'example.com' });
    expect(w.described[0]).toMatchObject({ origin: 'Ory Kratos database dump', rpId: 'example.com' });
  });

  it('exports an Ory Network project through the Admin API with its API key, and insists on the key', async () => {
    const origin = 'https://happy-moore-abc.projects.oryapis.com';
    const api = fakeVendor(origin, { 'GET /admin/identities?page_size=250&include_credential=oidc': [{ id: 'i1', traits: { email: 'jane@example.com' } }] });
    const { p } = context(dir, { values: { 'ory-admin-url': origin, 'ory-api-key': 'ory_pat_x' }, fetch: api.fetchImpl });
    const w = new FakeWriter();
    await oryPlugin.export!.run(p, w.writer, noResume);
    expect(w.of('user')).toHaveLength(1);
    expect(api.calls[0]!.headers.get('authorization')).toBe('Bearer ory_pat_x');

    const noKey = context(dir, { values: { 'ory-admin-url': origin }, fetch: api.fetchImpl });
    await expect(oryPlugin.export!.run(noKey.p, new FakeWriter().writer, noResume)).rejects.toThrow(/project API key/);
  });

  it('names every way in when neither a dump nor an admin URL is given', async () => {
    const { p } = context(dir);
    const err = await oryPlugin.export!.run(p, new FakeWriter().writer, noResume).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as Error).message).toMatch(/ory-dump/);
    expect((err as Error).message).toMatch(/ory-admin-url/);
  });

  it('translates a kratos.yml and cites its lines; refuses to run with nothing to read', async () => {
    const file = join(dir, 'kratos.yml');
    writeFileSync(file, 'serve:\n  public:\n    base_url: https://auth.example.com/\nsession:\n  lifespan: 48h\n');
    const { p } = context(dir, { values: { 'ory-config': file } });
    const t = await oryPlugin.config!.translate(p);
    expect(t.report.find((r) => r.setting === 'session.lifespan')).toMatchObject({ file, line: 5 });
    expect(oryPlugin.lazy!.config(p, t)).toEqual({ base_url: 'https://auth.example.com' });
    await expect(oryPlugin.config!.translate(context(dir).p)).rejects.toThrow(/nothing to read/);
  });

  it('splits an Ory Network project JSON into Kratos and Hydra configs', async () => {
    const file = join(dir, 'project.json');
    writeFileSync(file, JSON.stringify({ slug: 'happy-moore-abc', services: { identity: { config: { session: { lifespan: '1h' } } }, oauth2: { config: { ttl: { access_token: '5m' } } } } }));
    const { p } = context(dir, { values: { 'ory-config': file } });
    const t = await oryPlugin.config!.translate(p);
    expect(t.report.map((r) => r.setting)).toEqual(expect.arrayContaining(['session.lifespan', 'ttl.access_token']));
  });

  describe('bridge', () => {
    const pick = (values: Record<string, unknown>) => {
      const { p } = context(dir, { values });
      const vars = oryPlugin.bridge!.vars(p);
      return { preset: oryPlugin.bridge!.preset, vars };
    };

    it('asks Kratos with the cookie by default, naming the cookie after the project on Ory Network', () => {
      expect(pick({ 'ory-public-url': 'https://auth.example.com/' })).toEqual({ preset: 'ory_whoami', vars: { base_url: 'https://auth.example.com', cookie_name: 'ory_kratos_session' } });
      expect(pick({ 'ory-public-url': 'https://happy-moore-abc.projects.oryapis.com' }).vars).toEqual({ base_url: 'https://happy-moore-abc.projects.oryapis.com', cookie_name: 'ory_session_happy-moore-abc' });
      expect(pick({ 'ory-public-url': 'https://auth.example.com', 'ory-cookie-name': 'sess' }).vars.cookie_name).toBe('sess');
    });

    it('offers token modes, and the imported session table without a URL', () => {
      expect(pick({ 'ory-public-url': 'https://auth.example.com', 'ory-bridge': 'whoami-token' })).toEqual({ preset: 'ory_whoami_token', vars: { base_url: 'https://auth.example.com' } });
      expect(pick({})).toEqual({ preset: 'ory', vars: {} });
      expect(pick({ 'ory-bridge': 'session-token', 'ory-public-url': 'https://auth.example.com' })).toEqual({ preset: 'ory', vars: {} });
    });

    it('refuses an unknown mode and a whoami bridge without Kratos\' URL', () => {
      expect(() => pick({ 'ory-bridge': 'magic' })).toThrow(/whoami-cookie, whoami-token or session-token/);
      expect(() => pick({ 'ory-bridge': 'whoami-cookie' })).toThrow(/public URL/);
    });
  });

  it('lazy migration takes the public URL and the email trait', () => {
    const { p } = context(dir, { values: { 'ory-public-url': 'https://auth.example.com', 'ory-email-trait': 'mail' } });
    expect(oryPlugin.lazy!.config(p)).toEqual({ base_url: 'https://auth.example.com', email_trait: 'mail' });
  });
});
