import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryConfigStore } from '../config';
import type { ConfigHttp } from '../config-http';
import type { ManagementClient, RunContext } from '../context';
import { captureIO, type CaptureIO } from '../io';
import { run } from '../run';

const PASSWORD = 'Zx9-correct-horse-battery-staple';
const BASE = '/v1/platform/atlas_id_apps/app_1/provisioned_accounts';

interface Call {
  method: string;
  path: string;
  body?: unknown;
  key?: string;
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'atlas-cli-idacct-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function harness(answers: Record<string, unknown>, opts: { env?: Record<string, string>; files?: Record<string, string>; profileKey?: string } = {}) {
  const calls: Call[] = [];
  const io: CaptureIO = captureIO();
  const make = (key: string): ConfigHttp => {
    const answer = (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body, key });
      const hit = answers[`${method} ${path}`];
      if (hit === undefined) throw new Error(`unexpected ${method} ${path}`);
      return Promise.resolve(hit);
    };
    return {
      get: (p) => answer('GET', p) as never,
      post: (p, b) => answer('POST', p, b) as never,
      put: (p, b) => answer('PUT', p, b) as never,
      patch: (p, b) => answer('PATCH', p, b) as never,
      delete: async (p) => void (await answer('DELETE', p)),
    };
  };
  const ctx: RunContext = {
    io,
    env: { XDG_CONFIG_HOME: home, ...opts.env },
    config: new MemoryConfigStore({
      active_profile: 'default',
      profiles: { default: { api_url: 'https://api.test', secret_key: opts.profileKey ?? 'sk_test_123456' } },
    }),
    prompt: { text: async () => '', secret: async () => '' },
    makeClient: () => ({}) as ManagementClient,
    makeHttp: (auth) => make(auth.secretKey),
    readFile: (p: string) => {
      if (opts.files && p in opts.files) return opts.files[p]!;
      throw new Error('ENOENT');
    },
    sleep: async () => undefined,
  };
  return { ctx, io, calls };
}

const account = (over: Record<string, unknown> = {}) => ({
  object: 'atlas_id_provisioned_account',
  id: 'iacct_1',
  email: 'reviewer@example.com',
  label: 'reviewer',
  kind: 'provisioned',
  two_factor_exempt: false,
  expires_at: null,
  expired: false,
  last_sign_in_at: null,
  ...over,
});

describe('atlas id-accounts', () => {
  it('needs a platform key', async () => {
    const h = harness({});
    expect(await run(['id-accounts', 'list', '--app', 'app_1'], h.ctx)).toBe(1);
    expect(h.io.stderr()).toContain('platform key');
    expect(h.calls).toHaveLength(0);
  });

  it('provision sends the body with a per-app scoped platform key and writes the password to a 0600 file', async () => {
    const h = harness(
      { [`POST ${BASE}`]: account({ password: PASSWORD, two_factor_exempt: true }) },
      { env: { ATLAS_PLATFORM_KEY: 'psk_live_scoped_app' } },
    );
    expect(
      await run(['id-accounts', 'provision', '--app', 'app_1', '--email', 'reviewer@example.com', '--label', 'reviewer', '--two-factor-exempt', '--expires-at', '2026-12-31', '--product', 'acme'], h.ctx),
    ).toBe(0);
    expect(h.calls[0]).toEqual({
      method: 'POST',
      path: BASE,
      key: 'psk_live_scoped_app',
      body: { email: 'reviewer@example.com', label: 'reviewer', email_verified: true, two_factor_exempt: true, expires_at: '2026-12-31' },
    });
    const file = join(home, 'acme', 'id-account-iacct_1.env');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain(`ATLAS_ID_TEST_PASSWORD=${PASSWORD}`);
    expect(text).toContain('ATLAS_ID_TEST_EMAIL=reviewer@example.com');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(`${h.io.stdout()}${h.io.stderr()}`).not.toContain(PASSWORD);
    expect(h.io.stdout()).toContain('0600');
    expect(h.io.stdout()).toContain('exempt from two-factor');
  });

  it('uses a platform key stored in the profile', async () => {
    const h = harness({ [`GET ${BASE}`]: { object: 'list', data: [], limit: 25, total: 0 } }, { profileKey: 'psk_live_profile' });
    expect(await run(['id-accounts', 'list', '--app', 'app_1'], h.ctx)).toBe(0);
    expect(h.calls[0]!.key).toBe('psk_live_profile');
  });

  it('reads a chosen password from a file, never from argv, and enforces the length', async () => {
    const h = harness(
      { [`POST ${BASE}`]: account({ password: PASSWORD }) },
      { env: { ATLAS_PLATFORM_KEY: 'psk_x' }, files: { '/pw.txt': `# comment\nATLAS_ID_TEST_PASSWORD=${PASSWORD}\n`, '/short.txt': 'short\n' } },
    );
    const base = ['id-accounts', 'provision', '--app', 'app_1', '--email', 'a@example.com', '--label', 'ci', '--product', 'acme'];
    expect(await run([...base, '--password-file', '/pw.txt'], h.ctx)).toBe(0);
    expect(h.calls[0]!.body).toMatchObject({ password: PASSWORD });
    const bad = harness({}, { env: { ATLAS_PLATFORM_KEY: 'psk_x' }, files: { '/short.txt': 'short\n' } });
    expect(await run([...base, '--password-file', '/short.txt'], bad.ctx)).toBe(1);
    expect(bad.io.stderr()).toContain('at least 12');
    expect(bad.calls).toHaveLength(0);
  });

  it('provision requires --app, --email and --label', async () => {
    const h = harness({}, { env: { ATLAS_PLATFORM_KEY: 'psk_x' } });
    expect(await run(['id-accounts', 'provision', '--email', 'a@example.com', '--label', 'x'], h.ctx)).toBe(1);
    expect(h.io.stderr()).toContain('--app');
    expect(await run(['id-accounts', 'provision', '--app', 'app_1', '--email', 'a@example.com'], h.ctx)).toBe(1);
    expect(h.io.stderr()).toContain('--label');
  });

  it('--json never carries the password and names the secret file', async () => {
    const h = harness({ [`POST ${BASE}`]: account({ password: PASSWORD }) }, { env: { ATLAS_PLATFORM_KEY: 'psk_x' } });
    expect(await run(['id-accounts', 'provision', '--app', 'app_1', '--email', 'a@example.com', '--label', 'ci', '--product', 'acme', '--json'], h.ctx)).toBe(0);
    expect(h.io.stdout()).not.toContain(PASSWORD);
    const out = JSON.parse(h.io.stdout());
    expect(out.password).toBeUndefined();
    expect(out.secret_file).toBe(join(home, 'acme', 'id-account-iacct_1.env'));
  });

  it('--print-secret is the explicit opt-out and warns first', async () => {
    const h = harness({ [`POST ${BASE}`]: account({ password: PASSWORD }) }, { env: { ATLAS_PLATFORM_KEY: 'psk_x' } });
    expect(await run(['id-accounts', 'provision', '--app', 'app_1', '--email', 'a@example.com', '--label', 'ci', '--print-secret'], h.ctx)).toBe(0);
    expect(h.io.stdout()).toContain(`ATLAS_ID_TEST_PASSWORD=${PASSWORD}`);
    expect(h.io.stderr()).toContain('warning');
    expect(readdirSync(home)).toEqual([]);
  });

  it('list prints a table with 2FA and expiry', async () => {
    const h = harness(
      {
        [`GET ${BASE}`]: {
          object: 'list',
          data: [account({ two_factor_exempt: true }), account({ id: 'iacct_2', email: 'ci@example.com', label: 'ci', expires_at: Date.parse('2026-12-31T00:00:00Z') })],
          limit: 25,
          total: 2,
        },
      },
      { env: { ATLAS_PLATFORM_KEY: 'psk_x' } },
    );
    expect(await run(['id-accounts', 'list', '--app', 'app_1'], h.ctx)).toBe(0);
    const out = h.io.stdout();
    expect(out).toContain('reviewer@example.com');
    expect(out).toContain('exempt');
    expect(out).toContain('never');
    expect(out).toContain('2 of 25');
  });

  it('rotate posts to the password route and replaces the file', async () => {
    const h = harness({ [`POST ${BASE}/iacct_1/password`]: account({ password: `${PASSWORD}-2` }) }, { env: { ATLAS_PLATFORM_KEY: 'psk_x' } });
    const argv = ['id-accounts', 'rotate', 'iacct_1', '--app', 'app_1', '--product', 'acme'];
    expect(await run(argv, h.ctx)).toBe(0);
    expect(h.calls[0]).toMatchObject({ method: 'POST', path: `${BASE}/iacct_1/password`, body: {} });
    const file = join(home, 'acme', 'id-account-iacct_1.env');
    expect(readFileSync(file, 'utf8')).toContain(`${PASSWORD}-2`);
    const again = harness({ [`POST ${BASE}/iacct_1/password`]: account({ password: `${PASSWORD}-3` }) }, { env: { ATLAS_PLATFORM_KEY: 'psk_x' } });
    expect(await run(argv, again.ctx)).toBe(0);
    expect(readFileSync(file, 'utf8')).toContain(`${PASSWORD}-3`);
    expect(`${h.io.stdout()}${h.io.stderr()}`).not.toContain(PASSWORD);
  });

  it('remove deletes the account', async () => {
    const h = harness({ [`DELETE ${BASE}/iacct_1`]: {} }, { env: { ATLAS_PLATFORM_KEY: 'psk_x' } });
    expect(await run(['id-accounts', 'remove', 'iacct_1', '--app', 'app_1'], h.ctx)).toBe(0);
    expect(h.calls[0]).toMatchObject({ method: 'DELETE', path: `${BASE}/iacct_1` });
    expect(h.io.stdout()).toContain('Removed iacct_1');
  });

  it('names every subcommand in the unknown-subcommand error and has help', async () => {
    const h = harness({}, { env: { ATLAS_PLATFORM_KEY: 'psk_x' } });
    expect(await run(['id-accounts', 'frob'], h.ctx)).toBe(1);
    expect(h.io.stderr()).toContain('provision, list, rotate, remove');
    const help = harness({});
    expect(await run(['id-accounts', '--help'], help.ctx)).toBe(0);
    expect(help.io.stdout()).toContain('--two-factor-exempt');
  });
});
