import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtlasApiError } from '@atlasauth/backend';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryConfigStore } from '../../config';
import type { ConfigHttp } from '../../config-http';
import type { ManagementClient, RunContext } from '../../context';
import { captureIO, type CaptureIO } from '../../io';
import { run } from '../../run';
import { leafDiff } from './orchestrator';

/**
 * `atlas migrate better-auth` end to end over a copy of the split-options
 * fixture, against an in-memory Atlas API: the checkpoints, the gates, resume,
 * dry run and JSON output.
 */
const FIXTURE = join(__dirname, '..', '..', '..', 'fixtures', 'better-auth', 'split-options');

class FakeAtlas implements ConfigHttp {
  writes: Array<{ method: string; path: string; body: unknown }> = [];
  jobPolls = 0;
  /** Conflicts the dry run reports. */
  conflicts = 0;
  /** What polling the import returns: ready until it is applied. */
  stage = 'ready';

  private imp(status: string, extra: Record<string, unknown> = {}) {
    return {
      object: 'better_auth_import',
      id: 'bai_test',
      status,
      total: 3,
      progress: { total: 3, processed: status === 'completed' ? 3 : 0, succeeded: status === 'completed' ? 3 : 0, failed: 0, percent: status === 'completed' ? 100 : 0 },
      report: {
        models: [{ model: 'user', label: 'Users', found: 3, will_create: 3, will_update: 0, will_skip: 0 }],
        action_items: [],
        conflicts: this.conflicts ? [{ model: 'user', row_id: 'u1', code: 'email_taken', message: 'email in use', resolution: 'skip', existing_id: 'user_x' }] : [],
        conflicts_total: this.conflicts,
      },
      error: null,
      ...extra,
    };
  }

  async get<T>(path: string): Promise<T> {
    if (path === '/v1/instance') {
      return { id: 'ins_test', environment: 'development', frontend_api_host: 'auth.split.example', allowed_origins: ['https://old.split.example'], auth_config_resolved: { strategies: { password: true } } } as T;
    }
    if (path === '/v1/instance/preflight') return { ok: true, findings: [{ severity: 'warning', code: 'X' }] } as T;
    if (path.startsWith('/v1/users?')) return { data: [], total_count: 3 } as T;
    if (path.startsWith('/v1/organizations?')) return { data: [], total_count: 1 } as T;
    if (path === '/v1/better_auth_imports/public_key') return { object: 'better_auth_import_key', kid: 'bik_1', compact: 'bik_1:pk_test' } as T;
    if (path === '/v1/better_auth_imports/bai_test') {
      this.jobPolls += 1;
      return this.imp(this.stage) as T;
    }
    if (path === '/v1/organization_settings_schema') throw new AtlasApiError(404, [{ code: 'NOT_FOUND', message: 'none' }]);
    return { data: [] } as T;
  }
  async post<T>(path: string, body: unknown): Promise<T> {
    this.writes.push({ method: 'POST', path, body });
    if (path === '/v1/better_auth_imports') return this.imp('uploading') as T;
    if (path === '/v1/better_auth_imports/bai_test/finalize') return this.imp('ready') as T;
    if (path === '/v1/better_auth_imports/bai_test/apply') {
      this.stage = 'completed';
      return this.imp('applying') as T;
    }
    return {} as T;
  }
  async put<T>(path: string, body: unknown): Promise<T> {
    this.writes.push({ method: 'PUT', path, body });
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

let app: string;
beforeEach(() => {
  app = mkdtempSync(join(tmpdir(), 'ba-migrate-'));
  cpSync(FIXTURE, app, { recursive: true });
  writeFileSync(
    join(app, '.env'),
    ['BETTER_AUTH_SECRET=test-secret-at-least-16', 'BETTER_AUTH_URL=https://app.split.example', 'DISCORD_CLIENT_ID=d-id', 'DISCORD_CLIENT_SECRET=d-secret', 'TURNSTILE_SECRET_KEY=t-secret'].join('\n'),
  );
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

const state = () => JSON.parse(readFileSync(join(app, 'atlas-migrate', 'state.json'), 'utf8'));

describe('atlas migrate better-auth', () => {
  it('stops at apply until every placeholder has a value, without writing to the instance', async () => {
    const io = captureIO();
    const api = new FakeAtlas();
    expect(await run(['migrate', 'better-auth', app, '--yes'], ctx(io, api))).toBe(1);
    expect(io.stdout()).toContain('[apply] blocked: Set CAPTCHA_SITE_KEY');
    expect(api.writes).toEqual([]);
    expect(state().steps.translate.status).toBe('done');
    expect(existsSync(join(app, 'atlas-migrate', 'config', 'better-auth-report.md'))).toBe(true);
  });

  it('runs the whole program across a resume: apply, export handoff, import, bridge, code, verify', async () => {
    const env = { CAPTCHA_SITE_KEY: 'site-key' };
    const api = new FakeAtlas();
    const first = captureIO();
    expect(await run(['migrate', 'better-auth', app, '--yes'], ctx(first, api, { env }))).toBe(0);
    const out = first.stdout();
    expect(out).toContain('+ allowed_origins https://app.split.example');
    expect(out).toContain('~ auth_config.strategies.passkey: (unset) -> true');
    expect(out).toContain(`npx atlas-better-auth-export --out ${join(app, 'atlas-migrate', 'better-auth.bundle')} --public-key bik_1:pk_test`);
    expect(state().steps.export.status).toBe('action_needed');

    // The captcha secret is stored before the config that turns the captcha on.
    const paths = api.writes.map((w) => `${w.method} ${w.path}`);
    expect(paths.indexOf('PUT /v1/instance/captcha_secret')).toBeLessThan(paths.indexOf('PATCH /v1/instance'));
    expect(api.writes.find((w) => w.path === '/v1/instance/captcha_secret')?.body).toEqual({ provider: 'turnstile', secret: 't-secret' });
    const patch = api.writes.find((w) => w.method === 'PATCH' && w.path === '/v1/instance')?.body as { allowed_origins: string[] };
    expect(patch.allowed_origins).toEqual(['https://old.split.example', 'https://app.split.example']);
    expect(paths).toContain('PUT /v1/oauth_providers/discord');
    expect(paths.indexOf('POST /v1/permissions')).toBeLessThan(paths.indexOf('POST /v1/roles'));
    // Secrets go to the API only, never to disk.
    const instanceFile = readFileSync(join(app, 'atlas-migrate', 'config', 'instance.json'), 'utf8');
    expect(instanceFile).not.toContain('t-secret');
    expect(readFileSync(join(app, 'atlas-migrate', 'config', 'oauth_providers.json'), 'utf8')).toContain('${DISCORD_CLIENT_SECRET}');

    // The exporter ran; resume picks up at export.
    mkdirSync(join(app, 'atlas-migrate'), { recursive: true });
    writeFileSync(join(app, 'atlas-migrate', 'better-auth.bundle'), '{"sealed":"bundle"}');
    const second = captureIO();
    const api2 = new FakeAtlas();
    expect(await run(['migrate', 'better-auth', app, '--resume', '--yes'], ctx(second, api2, { env }))).toBe(0);
    const out2 = second.stdout();
    expect(out2).toContain('[apply] already done');
    expect(out2).toContain('Dry run (import bai_test):');
    expect(out2).toContain('Users: 3 found, 3 new, 0 existing, 0 skipped');
    const importCalls = api2.writes.filter((w) => w.path.startsWith('/v1/better_auth_imports')).map((w) => `${w.method} ${w.path}`);
    expect(importCalls).toEqual([
      'POST /v1/better_auth_imports',
      'PUT /v1/better_auth_imports/bai_test/parts/1',
      'POST /v1/better_auth_imports/bai_test/finalize',
      'POST /v1/better_auth_imports/bai_test/apply',
    ]);
    expect(api2.writes.find((w) => w.path === '/v1/better_auth_imports/bai_test/parts/1')?.body).toEqual({ data: '{"sealed":"bundle"}\n' });
    expect(api2.writes.find((w) => w.path === '/v1/better_auth_imports/bai_test/apply')?.body).toEqual({});
    expect(api2.jobPolls).toBeGreaterThan(0);
    const bridge = api2.writes.find((w) => w.path === '/v1/migrations/better_auth/bridge');
    expect(bridge?.method).toBe('PUT');
    expect(bridge?.body).toMatchObject({ enabled: true, cookie_prefix: 'better-auth', live_fallback: { secret: 'test-secret-at-least-16' } });
    expect((bridge?.body as { ends_at: number }).ends_at).toBeGreaterThan(Date.now());
    expect(out2).toContain('users on the instance: 3 (import: 3 of 3 rows landed)');
    expect(out2).toContain('https://auth.split.example/hosted/sign-in');
    const s = state();
    for (const step of ['preflight', 'translate', 'apply', 'export', 'import', 'bridge', 'code', 'verify']) {
      expect(s.steps[step].status).toBe('done');
    }
  });

  it('stops on dry-run conflicts until --confirm-conflicts, then reuses the uploaded import', async () => {
    const env = { CAPTCHA_SITE_KEY: 'site-key' };
    mkdirSync(join(app, 'atlas-migrate'), { recursive: true });
    writeFileSync(join(app, 'atlas-migrate', 'better-auth.bundle'), '{"sealed":"bundle"}');
    const api = new FakeAtlas();
    api.conflicts = 1;
    const io = captureIO();
    expect(await run(['migrate', 'better-auth', app, '--yes'], ctx(io, api, { env }))).toBe(0);
    expect(io.stdout()).toContain('conflicts with existing Atlas data: 1');
    expect(state().steps.import).toMatchObject({ status: 'action_needed', detail: { import_id: 'bai_test' } });
    expect(api.writes.some((w) => w.path.endsWith('/apply'))).toBe(false);

    // On resume the saved import is polled, not re-uploaded; the conflicts are confirmed on apply.
    const api2 = new FakeAtlas();
    api2.conflicts = 1;
    const again = captureIO();
    expect(await run(['migrate', 'better-auth', app, '--resume', '--yes', '--confirm-conflicts'], ctx(again, api2, { env }))).toBe(0);
    expect(api2.writes.some((w) => w.method === 'POST' && w.path === '/v1/better_auth_imports')).toBe(false);
    expect(api2.writes.find((w) => w.path === '/v1/better_auth_imports/bai_test/apply')?.body).toEqual({ confirm_conflicts: true });
    expect(state().steps.import.status).toBe('done');
  });

  it('--dry-run walks every step, writes nothing to the instance and keeps no state', async () => {
    const io = captureIO();
    const api = new FakeAtlas();
    expect(await run(['migrate', 'better-auth', app, '--dry-run'], ctx(io, api))).toBe(0);
    expect(api.writes).toEqual([]);
    expect(existsSync(join(app, 'atlas-migrate', 'state.json'))).toBe(false);
    const out = io.stdout();
    expect(out).toContain('Plan (dry run');
    expect(out).toContain('still to set before applying: CAPTCHA_SITE_KEY');
    expect(out).toContain('[export] planned');
    expect(out).toContain('[code] planned');
    expect(out).toContain('[verify] planned');
  });

  it('asks before applying; a "no" stops with a checkpoint, and an existing run needs --resume', async () => {
    const env = { CAPTCHA_SITE_KEY: 'site-key' };
    const io = captureIO();
    const api = new FakeAtlas();
    expect(await run(['migrate', 'better-auth', app], ctx(io, api, { env, answer: 'n' }))).toBe(0);
    expect(state().steps.apply.status).toBe('awaiting_confirmation');
    expect(api.writes).toEqual([]);

    const again = captureIO();
    expect(await run(['migrate', 'better-auth', app], ctx(again, new FakeAtlas(), { env }))).toBe(1);
    expect(again.stderr()).toContain('A migration is in progress');
  });

  it('--json reports every step and stops at the first gate without --yes', async () => {
    const io = captureIO();
    expect(await run(['migrate', 'better-auth', app, '--json'], ctx(io, new FakeAtlas(), { env: { CAPTCHA_SITE_KEY: 'k' } }))).toBe(0);
    const result = JSON.parse(io.stdout());
    expect(result.object).toBe('better_auth_migration');
    expect(result.instance_id).toBe('ins_test');
    expect(result.steps.map((s: { id: string; status: string }) => `${s.id}:${s.status}`)).toEqual([
      'preflight:done',
      'translate:done',
      'apply:awaiting_confirmation',
      'export:pending',
      'import:pending',
      'bridge:pending',
      'code:pending',
      'verify:pending',
    ]);
  });

  it('--skip leaves steps out and rejects unknown step names', async () => {
    const io = captureIO();
    expect(await run(['migrate', 'better-auth', app, '--skip', 'nope'], ctx(io, new FakeAtlas()))).toBe(1);
    expect(io.stderr()).toContain("--skip: unknown step 'nope'");
  });
});

describe('atlas migrate better-auth config', () => {
  it('translates offline and needs no login', async () => {
    const io = captureIO();
    const c = ctx(io, new FakeAtlas());
    c.config = new MemoryConfigStore();
    expect(await run(['migrate', 'better-auth', 'config', app, '--json'], c)).toBe(0);
    const result = JSON.parse(io.stdout());
    expect(result.object).toBe('better_auth_config_translation');
    expect(result.files).toContain('roles.json');
    expect(result.counts.manual).toBeGreaterThan(0);
    expect(existsSync(join(app, 'atlas-migrate', 'config', 'permissions.json'))).toBe(true);
  });

  it('errors cleanly when there is no betterAuth() call', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'ba-empty-'));
    const io = captureIO();
    expect(await run(['migrate', 'better-auth', 'config', empty], ctx(io, new FakeAtlas()))).toBe(1);
    expect(io.stderr()).toContain('No betterAuth({...}) call found');
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('leafDiff', () => {
  it('lists only the leaves that change', () => {
    expect(leafDiff({ a: { b: 1, c: [1, 2] }, d: true }, { a: { b: 1, c: [1] }, d: false })).toEqual([
      { path: 'a.c', from: [1], to: [1, 2] },
      { path: 'd', from: false, to: true },
    ]);
  });
});
