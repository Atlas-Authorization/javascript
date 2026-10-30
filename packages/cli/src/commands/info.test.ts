import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtlasApiError } from '@atlasauth/backend';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigHttp } from '../config-http';
import { MemoryConfigStore } from '../config';
import type { ManagementClient, RunContext } from '../context';
import { captureIO, type CaptureIO } from '../io';
import { run } from '../run';
import { compareVersions, keyPrefix, redactSecrets } from './info';

/**
 * `atlas info`: a temp project on disk, an in-memory Atlas API and a fake npm
 * registry. The load-bearing property is that NO secret ever reaches stdout,
 * whatever the API, the env or the project's .env files contain.
 */
const SECRET = 'sk_live_super_secret_value_never_printed_1234';
const PUBLISHABLE = 'pk_live_ins_2abcDEF';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-cli-info-'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'shop',
      dependencies: { next: '^15.0.0', '@atlasauth/nextjs': '^0.3.0', '@atlasauth/react': '^0.14.0', react: '^18.3.1' },
    }),
  );
  for (const [name, version] of [
    ['next', '15.1.2'],
    ['@atlasauth/nextjs', '0.3.4'],
    ['@atlasauth/react', '0.14.0'],
  ] as const) {
    const d = join(dir, 'node_modules', ...name.split('/'));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name, version }));
  }
  writeFileSync(join(dir, '.env.local'), `NEXT_PUBLIC_ATLAS_PUBLISHABLE_KEY=${PUBLISHABLE}\nATLAS_SECRET_KEY=${SECRET}\n`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fakeHttp(answers: Record<string, unknown>): ConfigHttp {
  const get = async (path: string) => {
    const a = answers[`GET ${path}`];
    if (a instanceof Error) throw a;
    return a as never;
  };
  return { get, post: get, put: get, patch: get, delete: async () => undefined };
}

const npm = (latest: Record<string, string>, healthStatus = 200) =>
  (async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith('/v1/health')) return new Response('{"ok":true}', { status: healthStatus });
    const m = /registry\.npmjs\.org\/(.+)\/latest$/.exec(u);
    const name = m ? decodeURIComponent(m[1]!) : '';
    if (latest[name]) return new Response(JSON.stringify({ version: latest[name] }), { status: 200 });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;

function ctxWith(io: CaptureIO, answers: Record<string, unknown>, extra: Partial<RunContext> = {}): RunContext {
  return {
    io,
    env: { ATLAS_SECRET_KEY: SECRET, ATLAS_API_URL: 'https://api.atlas.test' },
    config: new MemoryConfigStore(),
    prompt: { text: async () => '', secret: async () => '' },
    makeClient: () => ({}) as ManagementClient,
    makeHttp: () => fakeHttp(answers),
    readFile: (p) => readFileSync(p, 'utf8'),
    fetch: npm({ '@atlasauth/nextjs': '0.4.0', '@atlasauth/react': '0.14.0', '@atlasauth/cli': '99.0.0' }),
    ...extra,
  };
}

const INSTANCE = {
  'GET /v1/instance': { id: 'ins_2abcDEF', environment: 'production', publishable_key: PUBLISHABLE, frontend_api_host: 'auth.shop.test' },
  'GET /v1/instance/preflight': {
    ok: false,
    findings: [
      { severity: 'error', code: 'no_allowed_origins', message: 'x', fix: 'y' },
      { severity: 'warning', code: 'dev_email_sender', message: 'x', fix: 'y' },
      { severity: 'info', code: 'mfa_off', message: 'x', fix: 'y' },
    ],
  },
};

describe('atlas info', () => {
  it('prints versions, SDK updates, instance, latency and preflight — and never a secret', async () => {
    const io = captureIO();
    expect(await run(['info', dir], ctxWith(io, INSTANCE))).toBe(0);
    const out = io.stdout();
    expect(out).toContain('Next.js 15.1.2');
    expect(out).toMatch(/@atlasauth\/nextjs\s+0\.3\.4 {2}\(update available: 0\.4\.0\)/);
    expect(out).toMatch(/@atlasauth\/react\s+0\.14\.0$/m);
    expect(out).toContain('update available: 99.0.0');
    expect(out).toContain('sk_live_… (env ATLAS_SECRET_KEY)');
    expect(out).toContain('ins_2abcDEF (production)');
    expect(out).toContain('pk_live_… (.env.local NEXT_PUBLIC_ATLAS_PUBLISHABLE_KEY)  matches instance');
    expect(out).toMatch(/health 200 in \d+ ms, instance \d+ ms/);
    expect(out).toContain('1 error(s), 1 warning(s), 1 info');
    expect(out).toContain('no_allowed_origins');
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain('super_secret');
  });

  it('--json carries the same report, redacted', async () => {
    const io = captureIO();
    await run(['info', dir, '--json'], ctxWith(io, INSTANCE));
    const report = JSON.parse(io.stdout());
    expect(report.object).toBe('atlas_info');
    expect(report.project.framework).toEqual({ name: 'Next.js', package: 'next', version: '15.1.2' });
    expect(report.project.packages).toEqual([
      { name: '@atlasauth/nextjs', wanted: '^0.3.0', installed: '0.3.4', latest: '0.4.0', update_available: true },
      { name: '@atlasauth/react', wanted: '^0.14.0', installed: '0.14.0', latest: '0.14.0', update_available: false },
    ]);
    expect(report.instance).toMatchObject({
      configured: true,
      secret_key_prefix: 'sk_live_',
      instance_id: 'ins_2abcDEF',
      publishable_key_prefix: 'pk_live_',
      publishable_key_matches_instance: true,
    });
    expect(report.preflight).toMatchObject({ ran: true, errors: 1, warnings: 1, info: 1 });
    expect(io.stdout()).not.toContain(SECRET);
  });

  it('flags a publishable key from a different instance', async () => {
    const io = captureIO();
    const answers = { ...INSTANCE, 'GET /v1/instance': { ...INSTANCE['GET /v1/instance'], publishable_key: 'pk_live_ins_other' } };
    await run(['info', dir], ctxWith(io, answers));
    expect(io.stdout()).toContain('MISMATCH');
  });

  it('reports failures as data, not as a crash', async () => {
    const io = captureIO();
    const answers = {
      'GET /v1/instance': new AtlasApiError(401, [{ code: 'UNAUTHENTICATED', message: 'Bad key' }]),
      'GET /v1/instance/preflight': new AtlasApiError(401, [{ code: 'UNAUTHENTICATED', message: 'Bad key' }]),
    };
    const offline = (async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as typeof fetch;
    expect(await run(['info', dir], ctxWith(io, answers, { fetch: offline }))).toBe(0);
    const out = io.stdout();
    expect(out).toContain('instance lookup');
    expect(out).toContain('HTTP 401');
    expect(out).toMatch(/reachable\s+no \(getaddrinfo ENOTFOUND\)/);
    expect(out).toContain('failed: HTTP 401');
  });

  it('works with no credential at all', async () => {
    const io = captureIO();
    expect(await run(['info', dir], ctxWith(io, {}, { env: {} }))).toBe(0);
    const out = io.stdout();
    expect(out).toContain('not configured');
    expect(out).toContain('not run (no instance credential)');
  });
});

describe('info helpers', () => {
  it('keyPrefix keeps only the key kind', () => {
    expect(keyPrefix('sk_live_abc')).toBe('sk_live_');
    expect(keyPrefix('pk_test_ins_1')).toBe('pk_test_');
    expect(keyPrefix('psk_123')).toBe('psk_');
    expect(keyPrefix('atlas_live_sk_4fGqAbC')).toBe('atlas_live_sk_');
  });

  it('redactSecrets masks secret-shaped tokens', () => {
    expect(redactSecrets(`key=${SECRET} ok`)).toBe('key=sk_live_[redacted] ok');
    expect(redactSecrets('whsec_abcdefghij and pk_live_ins_1')).toBe('whsec_[redacted] and pk_live_ins_1');
    // The suite format, which the legacy-only pattern let through in the clear.
    expect(redactSecrets('key atlas_live_sk_4fGqAbCdEfGh123 here')).toBe('key atlas_live_sk_[redacted] here');
    expect(redactSecrets('atlas_test_psk_AbCdEfGh1234')).toBe('atlas_test_psk_[redacted]');
  });

  it('compareVersions orders releases and prereleases', () => {
    expect(compareVersions('0.3.4', '0.4.0')).toBe(-1);
    expect(compareVersions('^0.14.0', '0.14.0')).toBe(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
  });
});
