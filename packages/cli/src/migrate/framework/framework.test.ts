import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateImportKeyPair, openBundleText, type MigrationEntry } from '@atlasauth/migrate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryConfigStore } from '../../config';
import type { ConfigHttp } from '../../config-http';
import type { ManagementClient, RunContext } from '../../context';
import { captureIO, type CaptureIO } from '../../io';
import { run } from '../../run';
import { parseCanonicalRecords } from './custom';
import { parseSets } from './orchestrator';
import type { MigrationPlugin } from './plugin';
import { registerMigrationPlugin } from './registry';

/**
 * `atlas migrate <vendor>` end to end with a fake plugin over an in-memory
 * Atlas API: every step, the checkpoints, resume after a stop, dry run,
 * export segments with a cursor, the `migrate export <vendor>` alias and the
 * built-in `custom` plugin. The bundles are opened with the key the fake
 * instance handed out, so what the exporter wrote is checked record by record.
 */

const KEY = generateImportKeyPair();

class FakeAtlas implements ConfigHttp {
  writes: Array<{ method: string; path: string; body: unknown }> = [];
  /** Uploaded text per import id. */
  uploads = new Map<string, string[]>();
  status = new Map<string, string>();
  conflicts = 0;
  private next = 0;

  private imp(id: string) {
    const status = this.status.get(id) ?? 'uploading';
    return {
      object: 'migration_import',
      id,
      source: 'auth0',
      status,
      total: 3,
      progress: { total: 3, processed: status === 'completed' ? 3 : 0, succeeded: status === 'completed' ? 3 : 0, failed: 0, percent: status === 'completed' ? 100 : 0 },
      report: { models: [{ model: 'user', label: 'Users', found: 1, will_create: 1, will_update: 0, will_skip: 0 }], action_items: [], warnings: [], conflicts: [], conflicts_total: this.conflicts },
      error: null,
    };
  }

  async get<T>(path: string): Promise<T> {
    if (path === '/v1/instance') return { id: 'ins_test', environment: 'development', frontend_api_host: 'auth.example.test' } as T;
    const key = /^\/v1\/migrations\/(\w+)\/imports\/public_key$/.exec(path);
    if (key) return { object: 'migration_import_key', kid: 'mik_1', public_key: KEY.publicKey, fingerprint: 'aa:bb', compact: `mik_1:${KEY.publicKey}` } as T;
    const one = /^\/v1\/migrations\/\w+\/imports\/(mimp_\d+)$/.exec(path);
    if (one) {
      // Applying finishes on the first poll.
      if (this.status.get(one[1]!) === 'applying') this.status.set(one[1]!, 'completed');
      return this.imp(one[1]!) as T;
    }
    return { data: [] } as T;
  }
  async post<T>(path: string, body: unknown): Promise<T> {
    this.writes.push({ method: 'POST', path, body });
    if (/^\/v1\/migrations\/\w+\/imports$/.test(path)) {
      const id = `mimp_${++this.next}`;
      this.status.set(id, 'uploading');
      return this.imp(id) as T;
    }
    const m = /^\/v1\/migrations\/\w+\/imports\/(mimp_\d+)\/(finalize|apply)$/.exec(path);
    if (m) {
      this.status.set(m[1]!, m[2] === 'finalize' ? 'ready' : 'applying');
      return this.imp(m[1]!) as T;
    }
    return {} as T;
  }
  async put<T>(path: string, body: unknown): Promise<T> {
    this.writes.push({ method: 'PUT', path, body });
    const part = /^\/v1\/migrations\/\w+\/imports\/(mimp_\d+)\/parts\/(\d+)$/.exec(path);
    if (part) {
      const list = this.uploads.get(part[1]!) ?? [];
      list[Number(part[2]) - 1] = (body as { data: string }).data;
      this.uploads.set(part[1]!, list);
    }
    return {} as T;
  }
  async patch<T>(path: string, body: unknown): Promise<T> {
    this.writes.push({ method: 'PATCH', path, body });
    return {} as T;
  }
  async delete(path: string): Promise<void> {
    this.writes.push({ method: 'DELETE', path, body: undefined });
  }
}

/** A fake vendor: one org, two users, one membership; optionally fails once after the org. */
const behaviour = { failAfterOrg: false, exportRuns: 0, cursors: [] as unknown[] };
const acme: MigrationPlugin = {
  vendor: 'acmeauth',
  source: 'auth0',
  label: 'Acme Auth',
  help: 'test plugin',
  config: {
    reads: 'the fake tenant',
    async translate(p) {
      return {
        origin: `acme tenant ${p.credential({ flag: 'acme-tenant', env: 'ACME_TENANT', label: 'tenant', required: false }) ?? 'default'}`,
        documents: { instance: { auth_config: { session: { idleMs: 3600000 } } }, roles: [], oauth_providers: [{ provider: 'google' }] },
        report: [
          { status: 'mapped', area: 'session', setting: 'session.lifetime', atlas: 'auth_config.session.idleMs', note: 'same' },
          { status: 'manual', area: 'rules', setting: 'rules[0]', note: 'rewrite as an Action' },
        ],
        env: [],
        mappings: { providers: { 'google-oauth2': 'google' }, roles: {} },
        bridge: { preset: 'auth0', vars: { domain: 'acme.example.com' } },
      };
    },
  },
  export: {
    reads: 'the fake tenant API',
    credentials: [{ flag: 'acme-token', env: 'ACME_TOKEN', label: 'the Acme API token', required: true, secret: true }],
    async run(p, writer, resume) {
      behaviour.exportRuns += 1;
      behaviour.cursors.push(resume.cursor);
      p.credential({ flag: 'acme-token', env: 'ACME_TOKEN', label: 'token', required: true });
      if (resume.cursor !== 'orgs_done') {
        await writer.add('organization', { id: 'org_1', name: 'Acme' });
        resume.checkpoint('orgs_done');
        if (behaviour.failAfterOrg) {
          behaviour.failAfterOrg = false;
          throw new Error('vendor API answered 503');
        }
      }
      await writer.add('user', { id: 'auth0|1', emails: [{ email: 'a@example.com', verified: true }], password: { algorithm: 'bcrypt', hash: '$2b$10$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyz01234' } });
      await writer.add('user', { id: 'auth0|2', emails: [{ email: 'b@example.com', verified: false }] });
      await writer.add('membership', { organization_id: 'org_1', user_id: 'auth0|1', role: 'admin' });
    },
  },
  bridge: { preset: 'auth0', vars: (_p, t) => t?.bridge?.vars ?? { domain: 'fallback.example.com' } },
  lazy: {
    preset: 'auth0',
    config: () => ({ domain: 'acme.example.com', client_id: 'cid12345' }),
    secret: { flag: 'acme-client-secret', env: 'ACME_CLIENT_SECRET', label: 'client secret', required: false, secret: true },
  },
};
registerMigrationPlugin(acme, { replace: true });

let app: string;
beforeEach(() => {
  app = mkdtempSync(join(tmpdir(), 'vendor-migrate-'));
  behaviour.failAfterOrg = false;
  behaviour.exportRuns = 0;
  behaviour.cursors = [];
});
afterEach(() => rmSync(app, { recursive: true, force: true }));

function ctx(io: CaptureIO, api: FakeAtlas, opts: { env?: NodeJS.ProcessEnv; answer?: string } = {}): RunContext {
  return {
    io,
    env: opts.env ?? {},
    config: new MemoryConfigStore({ active_profile: 'default', profiles: { default: { api_url: 'https://api.test', secret_key: 'sk_test_123456' } } }),
    prompt: { text: async () => opts.answer ?? '', secret: async () => '' },
    readFile: (p) => readFileSync(p, 'utf8'),
    makeClient: () => ({}) as unknown as ManagementClient,
    makeHttp: () => api,
    sleep: async () => {},
  };
}

const dir = () => join(app, 'atlas-migrate', 'acmeauth');
const state = () => JSON.parse(readFileSync(join(dir(), 'state.json'), 'utf8'));
const open = (file: string): MigrationEntry[] => openBundleText(readFileSync(file, 'utf8'), KEY.privateKeyJwk);
const recordsOf = (entries: MigrationEntry[]) => entries.filter((e) => e.type === 'record').map((e) => (e.type === 'record' ? `${e.model}:${String((e.data as { id?: string }).id ?? (e.data as { user_id?: string }).user_id)}` : ''));

describe('atlas migrate <vendor>', () => {
  it('runs every step: config files, a sealed export, import, bridge, lazy, verify', async () => {
    const io = captureIO();
    const api = new FakeAtlas();
    expect(await run(['migrate', 'acmeauth', app, '--yes', '--set', 'acme-token=tok', '--set', 'acme-client-secret=shh'], ctx(io, api))).toBe(0);
    const s = state();
    expect(Object.fromEntries(Object.entries(s.steps).map(([k, v]) => [k, (v as { status: string }).status]))).toEqual({
      preflight: 'done',
      config: 'done',
      export: 'done',
      import: 'done',
      bridge: 'done',
      lazy: 'done',
      code: 'skipped',
      verify: 'done',
    });
    expect(s.instance_id).toBe('ins_test');
    // Config: documents and both reports.
    const cfg = join(dir(), 'config');
    expect(existsSync(join(cfg, 'instance.json'))).toBe(true);
    expect(existsSync(join(cfg, 'roles.json'))).toBe(false);
    expect(readFileSync(join(cfg, 'acmeauth-report.md'), 'utf8')).toContain('rewrite as an Action');
    // Export: a bundle sealed to the instance key, in canonical order, source auth0.
    const entries = open(join(dir(), 'bundle.1.atlas'));
    expect(entries[0]).toMatchObject({ type: 'manifest', format: 'atlas-migration-bundle', source: 'auth0' });
    expect(recordsOf(entries)).toEqual(['organization:org_1', 'user:auth0|1', 'user:auth0|2', 'membership:auth0|1']);
    expect(entries[entries.length - 1]).toMatchObject({ type: 'end', counts: { organization: 1, user: 2, membership: 1 } });
    // Import: exactly what was exported went up, then finalize and apply.
    expect(api.uploads.get('mimp_1')!.join('')).toBe(readFileSync(join(dir(), 'bundle.1.atlas'), 'utf8'));
    const posts = api.writes.filter((w) => w.method === 'POST').map((w) => w.path);
    expect(posts).toEqual(['/v1/migrations/auth0/imports', '/v1/migrations/auth0/imports/mimp_1/finalize', '/v1/migrations/auth0/imports/mimp_1/apply']);
    // Bridge and lazy migration.
    const bridge = api.writes.find((w) => w.path === '/v1/migrations/auth0/bridge')!;
    expect(bridge.body).toMatchObject({ enabled: true, preset: 'auth0', preset_vars: { domain: 'acme.example.com' } });
    const lazy = api.writes.find((w) => w.path === '/v1/legacy_auth_connection')!;
    expect(lazy.body).toEqual({ enabled: true, strategy: 'preset', preset: 'auth0', preset_config: { domain: 'acme.example.com', client_id: 'cid12345' }, secret: 'shh' });
    expect(io.stdout()).toContain('checklist:');
  });

  it('stops on a missing credential and on a declined confirmation, then resumes', async () => {
    const io = captureIO();
    const api = new FakeAtlas();
    expect(await run(['migrate', 'acmeauth', app, '--yes'], ctx(io, api))).toBe(1);
    expect(io.stderr()).toContain('--set acme-token=<value>');
    expect(state().steps.config.status).toBe('done');
    expect(state().steps.export).toBeUndefined();

    // Without --resume an in-progress migration is refused.
    expect(await run(['migrate', 'acmeauth', app], ctx(io, api, { env: { ACME_TOKEN: 't' } }))).toBe(1);
    expect(io.stderr()).toContain('--resume');

    // The import confirmation is declined (no --yes, answer "no").
    expect(await run(['migrate', 'acmeauth', app, '--resume'], ctx(io, api, { env: { ACME_TOKEN: 't' }, answer: 'n' }))).toBe(0);
    expect(state().steps.export.status).toBe('done');
    expect(state().steps.import.status).toBe('awaiting_confirmation');
    expect(api.writes.some((w) => w.path.endsWith('/apply'))).toBe(false);

    expect(await run(['migrate', 'acmeauth', app, '--resume', '--yes'], ctx(io, api, { env: { ACME_TOKEN: 't' } }))).toBe(0);
    expect(state().steps.import.status).toBe('done');
    // The upload was not repeated: the import created before the stop is continued.
    expect(api.writes.filter((w) => w.path === '/v1/migrations/auth0/imports')).toHaveLength(1);
    expect(behaviour.exportRuns).toBe(1);
  });

  it('--dry-run changes nothing: no instance writes, no vendor call, no files', async () => {
    const io = captureIO();
    const api = new FakeAtlas();
    expect(await run(['migrate', 'acmeauth', app, '--dry-run', '--set', 'acme-token=t'], ctx(io, api))).toBe(0);
    expect(api.writes).toEqual([]);
    expect(behaviour.exportRuns).toBe(0);
    expect(existsSync(join(dir(), 'state.json'))).toBe(false);
    expect(existsSync(join(dir(), 'bundle.1.atlas'))).toBe(false);
  });

  it('an interrupted export keeps a sealed segment and resumes from the checkpoint', async () => {
    behaviour.failAfterOrg = true;
    const io = captureIO();
    const api = new FakeAtlas();
    expect(await run(['migrate', 'acmeauth', app, '--yes', '--set', 'acme-token=t', '--skip', 'config'], ctx(io, api))).toBe(1);
    expect(io.stdout()).toContain('vendor API answered 503');
    expect(state().export).toMatchObject({ segments: ['bundle.1.atlas'], cursor: 'orgs_done', complete: false });
    expect(recordsOf(open(join(dir(), 'bundle.1.atlas')))).toEqual(['organization:org_1']);

    expect(await run(['migrate', 'acmeauth', app, '--resume', '--yes', '--set', 'acme-token=t'], ctx(io, api))).toBe(0);
    expect(behaviour.cursors).toEqual([null, 'orgs_done']);
    expect(recordsOf(open(join(dir(), 'bundle.2.atlas')))).toEqual(['user:auth0|1', 'user:auth0|2', 'membership:auth0|1']);
    expect(state().export).toMatchObject({ segments: ['bundle.1.atlas', 'bundle.2.atlas'], cursor: null, complete: true, counts: { organization: 1, user: 2, membership: 1 } });
    // Both segments imported, in order.
    expect(state().import.done).toEqual(['bundle.1.atlas', 'bundle.2.atlas']);
    expect(api.writes.filter((w) => w.path.endsWith('/apply')).map((w) => w.path)).toEqual(['/v1/migrations/auth0/imports/mimp_1/apply', '/v1/migrations/auth0/imports/mimp_2/apply']);
  });

  it('`migrate export <vendor>` is `migrate <vendor> export`: only the export runs', async () => {
    const io = captureIO();
    const api = new FakeAtlas();
    expect(await run(['migrate', 'export', 'acmeauth', app, '--set', 'acme-token=t'], ctx(io, api))).toBe(0);
    expect(state().steps).toEqual({ export: expect.objectContaining({ status: 'done' }) });
    expect(api.writes).toEqual([]);
    // …and a separate import run picks the bundle up.
    expect(await run(['migrate', 'acmeauth', 'import', app, '--yes'], ctx(io, api))).toBe(0);
    expect(state().import.done).toEqual(['bundle.1.atlas']);
  });

  it('refuses an unknown vendor and lists the plugins', async () => {
    const io = captureIO();
    expect(await run(['migrate', 'nosuchvendor', app], ctx(io, new FakeAtlas()))).toBe(1);
    expect(io.stderr()).toContain('Other vendors:');
    expect(io.stderr()).toContain('custom');
    expect(io.stderr()).toContain('acmeauth');
  });
});

describe('atlas migrate custom', () => {
  it('exports a local file of canonical records into a bundle that opens to the same records', async () => {
    const file = join(app, 'records.ndjson');
    const lines = [
      { model: 'membership', data: { organization_id: 'o1', user_id: 'u1', role: 'member' } },
      { model: 'user', data: { id: 'u1', emails: [{ email: 'u1@example.com', verified: true }] } },
      { model: 'organization', data: { id: 'o1', name: 'Org One' } },
      { model: 'user', data: { id: 'u2' } },
      { model: 'widget', data: { id: 'w1' } },
      { type: 'manifest', format: 'atlas-migration-bundle' },
    ];
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const io = captureIO();
    const api = new FakeAtlas();
    expect(await run(['migrate', 'custom', 'export', app, '--file', file], ctx(io, api))).toBe(0);
    const entries = openBundleText(readFileSync(join(app, 'atlas-migrate', 'custom', 'bundle.1.atlas'), 'utf8'), KEY.privateKeyJwk);
    expect(entries[0]).toMatchObject({ type: 'manifest', source: 'custom' });
    const records = entries.filter((e) => e.type === 'record');
    expect(records).toEqual([
      { type: 'record', model: 'organization', data: { id: 'o1', name: 'Org One' } },
      { type: 'record', model: 'user', data: { id: 'u1', emails: [{ email: 'u1@example.com', verified: true }] } },
      { type: 'record', model: 'membership', data: { organization_id: 'o1', user_id: 'u1', role: 'member' } },
    ]);
    const end = entries[entries.length - 1] as Extract<MigrationEntry, { type: 'end' }>;
    expect(end.counts).toEqual({ organization: 1, user: 1, membership: 1 });
    // The user with no identifier and the unknown model are left out and reported.
    expect(end.omitted.widget?.count).toBe(1);
    expect(end.omitted.user?.count).toBe(1);
  });

  it('parses a JSON array and refuses broken input', () => {
    expect(parseCanonicalRecords('[{"model":"user","data":{"id":"a"}}]').records).toHaveLength(1);
    expect(() => parseCanonicalRecords('[{"model":')).toThrow(/not valid JSON/);
    expect(() => parseCanonicalRecords('{"model":"user","data":{}}\nnope')).toThrow(/Line 2/);
  });

  it('parseSets reads name=value pairs', () => {
    expect(parseSets(['a=b', 'url=https://x.test/?q=1'])).toEqual({ a: 'b', url: 'https://x.test/?q=1' });
    expect(() => parseSets(['novalue'])).toThrow(/name=value/);
  });
});
