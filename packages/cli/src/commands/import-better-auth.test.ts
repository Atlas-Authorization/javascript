import { describe, expect, it } from 'vitest';
import type { ConfigHttp } from '../config-http';
import type { ManagementClient, RunContext } from '../context';
import { MemoryConfigStore } from '../config';
import { captureIO } from '../io';
import { run } from '../run';

/**
 * `atlas import --from better-auth --bundle <file>` against an in-memory Atlas:
 * upload in parts, finalize, the dry-run report, the apply (with polling), the
 * dry-run / conflict / invalid-bundle stops, resume by import id, and the
 * key + export-command hint.
 */

type Call = { method: string; path: string; body?: Record<string, unknown> };

const report = (conflicts = 0) => ({
  models: [{ model: 'user', label: 'Users', found: 2, will_create: 2, will_update: 0, will_skip: 0 }],
  skipped: [],
  skipped_total: 0,
  skipped_by_code: {},
  conflicts: conflicts ? [{ model: 'user', row_id: 'u1', code: 'email_collision', message: 'taken', resolution: 'skip', existing_id: 'user_1' }] : [],
  conflicts_total: conflicts,
  action_items: [{ code: 'stripe_not_configured', severity: 'required', message: 'Add your Stripe key.', count: 1, items: ['sub_1'] }],
  warnings: [],
  notes: {},
});

function fakeAtlas(calls: Call[], opts: { finalizeStatus?: string; conflicts?: number; applyStatus?: string; existing?: Record<string, unknown> } = {}) {
  let polls = 0;
  const imp = (status: string, extra: Record<string, unknown> = {}) => ({
    object: 'better_auth_import', id: 'baimp_1', status, analyzed_at: 1, report: report(opts.conflicts), result: null, progress: null, error: null, ...extra,
  });
  const http: ConfigHttp = {
    get: async (p) => {
      calls.push({ method: 'GET', path: p });
      if (p.endsWith('/public_key')) return { kid: 'ikey_1', public_key: 'pk', fingerprint: 'aa:bb', compact: 'ikey_1:pk' } as never;
      if (opts.existing && polls === 0 && !calls.some((c) => c.method === 'POST')) return opts.existing as never;
      polls += 1;
      return imp(polls < 2 ? 'applying' : 'completed', {
        progress: { total: 10, processed: polls < 2 ? 5 : 10, succeeded: 10, failed: 0, percent: polls < 2 ? 50 : 100 },
        result: { models: [{ model: 'user', label: 'Users', found: 2, created: 2, updated: 0, unchanged: 0, skipped: 0, failed: 0 }], completed_at: 1 },
      }) as never;
    },
    post: async (p, b) => {
      calls.push({ method: 'POST', path: p, body: b as Record<string, unknown> });
      if (p === '/v1/better_auth_imports') return imp('uploading') as never;
      if (p.endsWith('/finalize') || p.endsWith('/dry_run')) {
        const st = opts.finalizeStatus ?? 'ready';
        return imp(st, st === 'invalid' ? { analyzed_at: 1, error: { code: 'bundle_wrong_key', message: 'Wrong key.' } } : {}) as never;
      }
      if (p.endsWith('/apply')) return imp(opts.applyStatus ?? 'queued') as never;
      throw new Error(`unexpected POST ${p}`);
    },
    put: async (p, b) => {
      calls.push({ method: 'PUT', path: p, body: b as Record<string, unknown> });
      return {} as never;
    },
    patch: async () => ({}) as never,
    delete: async () => undefined,
  };
  return http;
}

function ctx(http: ConfigHttp, files: Record<string, string> = {}, answer = 'y'): RunContext & { io: ReturnType<typeof captureIO> } {
  return {
    io: captureIO(),
    env: {},
    config: new MemoryConfigStore({ active_profile: 'default', profiles: { default: { api_url: 'https://api.atlas.test', secret_key: 'sk_test_123456' } } }),
    prompt: { text: async () => answer, secret: async () => '' },
    makeClient: () => ({}) as ManagementClient,
    makeHttp: () => http,
    readFile: (p) => {
      if (!(p in files)) throw new Error(`no file ${p}`);
      return files[p]!;
    },
    sleep: async () => undefined,
  };
}

const BUNDLE = `${['{"format":"atlas-better-auth-bundle"}', 'chunk-one', 'chunk-two'].join('\n')}\n`;

describe('atlas import --from better-auth', () => {
  it('uploads, shows the dry run, applies after confirmation and polls to completion', async () => {
    const calls: Call[] = [];
    const c = ctx(fakeAtlas(calls), { 'b.bundle': BUNDLE });
    const code = await run(['import', '--from', 'better-auth', '--bundle', 'b.bundle', '--options', '{"import_sessions":false}'], c);
    expect(code).toBe(0);
    expect(calls.map((x) => `${x.method} ${x.path}`)).toEqual([
      'POST /v1/better_auth_imports',
      'PUT /v1/better_auth_imports/baimp_1/parts/1',
      'POST /v1/better_auth_imports/baimp_1/finalize',
      'POST /v1/better_auth_imports/baimp_1/apply',
      'GET /v1/better_auth_imports/baimp_1',
      'GET /v1/better_auth_imports/baimp_1',
    ]);
    expect(calls[0]!.body).toEqual({ options: { import_sessions: false } });
    expect(calls[1]!.body).toEqual({ data: BUNDLE });
    const out = c.io.stdout();
    expect(out).toContain('Dry run');
    expect(out).toContain('REQUIRED: Add your Stripe key.');
    expect(out).toContain('2 created');
  });

  it('--dry-run stops after the report', async () => {
    const calls: Call[] = [];
    const c = ctx(fakeAtlas(calls), { 'b.bundle': BUNDLE });
    expect(await run(['import', '--from', 'better-auth', '--bundle', 'b.bundle', '--dry-run'], c)).toBe(0);
    expect(calls.some((x) => x.path.endsWith('/apply'))).toBe(false);
    expect(c.io.stdout()).toContain('--import baimp_1');
  });

  it('answering no leaves the import unapplied', async () => {
    const calls: Call[] = [];
    const c = ctx(fakeAtlas(calls), { 'b.bundle': BUNDLE }, 'n');
    expect(await run(['import', '--from', 'better-auth', '--bundle', 'b.bundle'], c)).toBe(0);
    expect(calls.some((x) => x.path.endsWith('/apply'))).toBe(false);
  });

  it('stops on conflicts unless --confirm-conflicts, then sends confirm_conflicts', async () => {
    const calls: Call[] = [];
    const c = ctx(fakeAtlas(calls, { conflicts: 1 }), { 'b.bundle': BUNDLE });
    expect(await run(['import', '--from', 'better-auth', '--bundle', 'b.bundle', '--yes'], c)).not.toBe(0);
    expect(calls.some((x) => x.path.endsWith('/apply'))).toBe(false);

    const calls2: Call[] = [];
    const c2 = ctx(fakeAtlas(calls2, { conflicts: 1 }), { 'b.bundle': BUNDLE });
    expect(await run(['import', '--from', 'better-auth', '--bundle', 'b.bundle', '--yes', '--confirm-conflicts'], c2)).toBe(0);
    expect(calls2.find((x) => x.path.endsWith('/apply'))!.body).toEqual({ confirm_conflicts: true });
  });

  it('fails clearly on a bundle Atlas cannot open', async () => {
    const calls: Call[] = [];
    const c = ctx(fakeAtlas(calls, { finalizeStatus: 'invalid' }), { 'b.bundle': BUNDLE });
    expect(await run(['import', '--from', 'better-auth', '--bundle', 'b.bundle', '--yes'], c)).not.toBe(0);
    expect(c.io.stderr()).toContain('Wrong key');
  });

  it('--import <id> resumes a failed import', async () => {
    const calls: Call[] = [];
    const existing = { object: 'better_auth_import', id: 'baimp_1', status: 'failed', analyzed_at: 1, report: report(), result: null, progress: null, error: { code: 'apply_failed', message: 'x' } };
    const c = ctx(fakeAtlas(calls, { existing }));
    expect(await run(['import', '--from', 'better-auth', '--import', 'baimp_1', '--yes'], c)).toBe(0);
    expect(calls.map((x) => `${x.method} ${x.path}`).slice(0, 2)).toEqual(['GET /v1/better_auth_imports/baimp_1', 'POST /v1/better_auth_imports/baimp_1/apply']);
  });

  it('with no bundle, prints the import key and the export command', async () => {
    const calls: Call[] = [];
    const c = ctx(fakeAtlas(calls));
    expect(await run(['import', '--from', 'better-auth'], c)).toBe(0);
    expect(c.io.stdout()).toContain('npx atlas-better-auth-export --out better-auth.atlas-bundle --public-key ikey_1:pk');
  });
});
