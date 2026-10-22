import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtlasApiError } from '@atlasauth/backend';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigHttp } from '../config-http';
import type { ManagementClient, RunContext } from '../context';
import { MemoryConfigStore } from '../config';
import { captureIO, type CaptureIO } from '../io';
import { run } from '../run';
import { describeTestLines, parseCodeCsv, pingSkewMs } from './referrals';

/**
 * `atlas referrals connect | backfill | status`, driven through `run()` with an
 * in-memory Atlas API and an in-memory Referally merchant API.
 */

type Call = { method: string; path: string; body?: unknown };

const MERCHANT_KEY = 'rk_live_merchant_key_never_printed';
const CONN_SECRET = 'rcs_connection_secret_never_printed';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'atlas-cli-referrals-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function fakeHttp(calls: Call[], answers: Partial<Record<string, unknown | ((body: unknown) => unknown)>>): ConfigHttp {
  const send = async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    const a = answers[`${method} ${path}`];
    if (a instanceof Error) throw a;
    return (typeof a === 'function' ? (a as (b: unknown) => unknown)(body) : a ?? {}) as never;
  };
  return {
    get: (p) => send('GET', p),
    post: (p, b) => send('POST', p, b),
    put: (p, b) => send('PUT', p, b),
    patch: (p, b) => send('PATCH', p, b),
    delete: async (p) => {
      await send('DELETE', p);
    },
  };
}

function makeCtx(
  io: CaptureIO,
  calls: Call[],
  answers: Parameters<typeof fakeHttp>[1],
  extra: Partial<RunContext> = {},
): RunContext {
  return {
    io,
    env: { XDG_CONFIG_HOME: home },
    config: new MemoryConfigStore({
      active_profile: 'default',
      profiles: { default: { api_url: 'https://api.atlas.test', secret_key: 'sk_test_123456' } },
    }),
    prompt: { text: async () => '', secret: async () => '' },
    makeClient: () => ({}) as ManagementClient,
    makeHttp: () => fakeHttp(calls, answers),
    readFile: () => '',
    sleep: async () => undefined,
    ...extra,
  };
}

function referallyFetch(record: Array<{ url: string; init: RequestInit }>, status = 201, body: unknown = { id: 'conn_1', secret: CONN_SECRET, trackingToken: 'tt_pub_1', signupsUrl: 'x' }) {
  return (async (url: string | URL, init?: RequestInit) => {
    record.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

const PING_OK = {
  ok: true,
  http_status: 200,
  latency_ms: 42,
  ping: { ok: true, org_name: 'Acme', program_id: 'prg_1', program_name: 'Main', auto_enroll_users: true, clock_skew_ms: 1200 },
};

describe('atlas referrals connect --provider referally', () => {
  it('creates the connection with the merchant key, stores id + secret on the instance, pings, and never prints a secret', async () => {
    const io = captureIO();
    const calls: Call[] = [];
    const remote: Array<{ url: string; init: RequestInit }> = [];
    const code = await run(
      [
        'referrals', 'connect', '--provider', 'referally', '--program', 'prg_1',
        '--base-url', 'https://referrals.example.com/', '--referally-key', MERCHANT_KEY,
        '--auto-enroll', '--destination', 'https://app.example.com/login', '--enable',
      ],
      makeCtx(io, calls, { 'GET /v1/instance': { id: 'ins_1' }, 'POST /v1/instance/referrals/test': PING_OK }, { fetch: referallyFetch(remote) }),
    );
    expect(code).toBe(0);
    expect(remote).toHaveLength(1);
    expect(remote[0]!.url).toBe('https://referrals.example.com/v1/auth/connections');
    const headers = remote[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${MERCHANT_KEY}`);
    expect(headers['referally-version']).toBe('2026-10-21');
    expect(JSON.parse(remote[0]!.init.body as string)).toEqual({
      provider: 'atlas',
      instanceId: 'ins_1',
      programId: 'prg_1',
      autoEnrollUsers: true,
      destinationUrl: 'https://app.example.com/login',
    });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /v1/instance',
      'PATCH /v1/instance/referrals',
      'POST /v1/instance/referrals/test',
      'PATCH /v1/instance/referrals',
    ]);
    expect(calls[1]!.body).toEqual({
      provider: 'referally',
      endpoint_url: 'https://referrals.example.com',
      connection_id: 'conn_1',
      signing_secret: CONN_SECRET,
      program_id: 'prg_1',
      auto_enroll_users: true,
      tracking_token: 'tt_pub_1',
    });
    expect(calls[3]!.body).toEqual({ enabled: true });
    const all = io.stdout() + io.stderr();
    expect(all).not.toContain(MERCHANT_KEY);
    expect(all).not.toContain(CONN_SECRET);
    expect(io.stdout()).toContain('Organization:       Acme');
    expect(io.stdout()).toContain('Program:            Main (prg_1)');
    expect(io.stdout()).toContain('Referral attribution is on.');
  });

  it('reads the key from a file and refuses a missing base URL or program', async () => {
    const io = captureIO();
    const calls: Call[] = [];
    const remote: Array<{ url: string; init: RequestInit }> = [];
    const ctx = makeCtx(io, calls, { 'GET /v1/instance': { id: 'ins_1' }, 'POST /v1/instance/referrals/test': PING_OK }, {
      fetch: referallyFetch(remote),
      readFile: () => `# merchant key\nREFERALLY_API_KEY=${MERCHANT_KEY}\n`,
    });
    expect(await run(['referrals', 'connect', '--program', 'prg_1', '--base-url', 'https://r.example.com', '--referally-key-file', 'k.env'], ctx)).toBe(0);
    expect((remote[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${MERCHANT_KEY}`);

    const io2 = captureIO();
    expect(await run(['referrals', 'connect', '--program', 'prg_1', '--referally-key', 'k'], makeCtx(io2, [], {}))).toBe(1);
    expect(io2.stderr()).toContain('--base-url');
    const io3 = captureIO();
    expect(await run(['referrals', 'connect', '--base-url', 'https://r.example.com'], makeCtx(io3, [], {}))).toBe(1);
    expect(io3.stderr()).toContain('--program');
    const io4 = captureIO();
    expect(await run(['referrals', 'connect', '--program', 'p', '--base-url', 'http://r.example.com', '--referally-key', 'k'], makeCtx(io4, [], {}))).toBe(1);
    expect(io4.stderr()).toContain('https');
  });

  it('reports a refused merchant key without echoing it', async () => {
    const io = captureIO();
    const remote: Array<{ url: string; init: RequestInit }> = [];
    const code = await run(
      ['referrals', 'connect', '--program', 'prg_1', '--base-url', 'https://r.example.com', '--referally-key', MERCHANT_KEY],
      makeCtx(io, [], { 'GET /v1/instance': { id: 'ins_1' } }, { fetch: referallyFetch(remote, 401, { error: { message: 'invalid key' } }) }),
    );
    expect(code).toBe(1);
    expect(io.stderr()).toContain('HTTP 401');
    expect(io.stderr()).toContain('Check the merchant key');
    expect(io.stderr()).not.toContain(MERCHANT_KEY);
  });

  it('keeps the shown-once secret in a 0600 file when saving it on the instance fails', async () => {
    const io = captureIO();
    const remote: Array<{ url: string; init: RequestInit }> = [];
    const code = await run(
      ['referrals', 'connect', '--program', 'prg_1', '--base-url', 'https://r.example.com', '--referally-key', MERCHANT_KEY],
      makeCtx(
        io,
        [],
        { 'GET /v1/instance': { id: 'ins_1' }, 'PATCH /v1/instance/referrals': new AtlasApiError(422, [{ code: 'VALIDATION', message: 'bad' } as never]) },
        { fetch: referallyFetch(remote) },
      ),
    );
    expect(code).toBe(1);
    const file = join(home, 'atlasauth', 'referally-connection-conn_1.env');
    expect(readFileSync(file, 'utf8')).toContain(`REFERALLY_CONNECTION_SECRET=${CONN_SECRET}`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(io.stdout() + io.stderr()).not.toContain(CONN_SECRET);
  });

  it('does not turn referrals on when the ping fails', async () => {
    const io = captureIO();
    const calls: Call[] = [];
    const code = await run(
      ['referrals', 'connect', '--program', 'prg_1', '--base-url', 'https://r.example.com', '--referally-key', MERCHANT_KEY, '--enable'],
      makeCtx(
        io,
        calls,
        {
          'GET /v1/instance': { id: 'ins_1' },
          'POST /v1/instance/referrals/test': { ok: false, http_status: 401, latency_ms: 10, error: { code: 'signature_rejected', message: 'Signature rejected' } },
        },
        { fetch: referallyFetch([]) },
      ),
    );
    expect(code).toBe(1);
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
    expect(io.stdout()).toContain('Connection test failed (HTTP 401, 10 ms): Signature rejected.');
  });
});

describe('atlas referrals connect --provider webhook', () => {
  it('generates a signing secret into a 0600 file when none is given', async () => {
    const io = captureIO();
    const calls: Call[] = [];
    const code = await run(
      ['referrals', 'connect', '--provider', 'webhook', '--endpoint', 'https://platform.example.com/atlas', '--json'],
      makeCtx(io, calls, { 'POST /v1/instance/referrals/test': { ok: true, http_status: 404, latency_ms: 5 } }),
    );
    expect(code).toBe(0);
    const patch = calls[0]!.body as Record<string, string>;
    expect(patch.provider).toBe('webhook');
    expect(patch.endpoint_url).toBe('https://platform.example.com/atlas');
    expect(patch.signing_secret).toMatch(/^rfs_[A-Za-z0-9_-]{43}$/);
    const file = join(home, 'atlasauth', 'referrals-signing-secret.env');
    expect(readFileSync(file, 'utf8')).toContain(patch.signing_secret);
    const out = JSON.parse(io.stdout());
    expect(out.secret_file).toBe(file);
    expect(io.stdout()).not.toContain(patch.signing_secret);
  });

  it('uses a secret from a file', async () => {
    const io = captureIO();
    const calls: Call[] = [];
    await run(
      ['referrals', 'connect', '--provider', 'webhook', '--endpoint', 'https://platform.example.com/atlas', '--secret-file', 's'],
      makeCtx(io, calls, { 'POST /v1/instance/referrals/test': { ok: true } }, { readFile: () => 'abcdefghijklmnopqrstuvwxyz\n' }),
    );
    expect((calls[0]!.body as Record<string, string>).signing_secret).toBe('abcdefghijklmnopqrstuvwxyz');
  });

  it('refuses an unknown provider', async () => {
    const io = captureIO();
    expect(await run(['referrals', 'connect', '--provider', 'acme'], makeCtx(io, [], {}))).toBe(1);
    expect(io.stderr()).toContain('--provider must be one of referally, webhook');
  });
});

describe('atlas referrals backfill', () => {
  it('sends since + codes from a CSV and follows the job with --wait', async () => {
    const io = captureIO();
    const calls: Call[] = [];
    let polls = 0;
    const code = await run(
      ['referrals', 'backfill', '--since', '2026-01-01', '--map', 'codes.csv', '--metadata-path', 'public_metadata.referral_code', '--wait'],
      makeCtx(
        io,
        calls,
        {
          'POST /v1/instance/referrals/backfill': { id: 'rbf_1', status: 'queued' },
          'GET /v1/instance/referrals/backfill/rbf_1': () =>
            ++polls < 2
              ? { id: 'rbf_1', status: 'running' }
              : {
                  id: 'rbf_1',
                  status: 'completed',
                  users_scanned: 3,
                  calls_queued: 2,
                  users_skipped: 1,
                  calls: { pending: 0, succeeded: 2, failed: 0, skipped: 0, held: 0 },
                },
        },
        { readFile: () => 'customerRef,code\nusr_1,WJXQGLBW\nusr_2;K7Q2MZ4P\n' },
      ),
    );
    expect(code).toBe(0);
    expect(calls[0]!.body).toEqual({
      since: '2026-01-01',
      codes: { usr_1: 'WJXQGLBW', usr_2: 'K7Q2MZ4P' },
      code_metadata_path: 'public_metadata.referral_code',
    });
    expect(polls).toBe(2);
    expect(io.stdout()).toContain('Backfill rbf_1: completed (3 users, 2 calls queued, 1 skipped, 2 sent, 0 failed).');
  });

  it('validates --since, --map and --metadata-path', async () => {
    const io = captureIO();
    expect(await run(['referrals', 'backfill'], makeCtx(io, [], {}))).toBe(1);
    expect(io.stderr()).toContain('--since');
    const io2 = captureIO();
    expect(await run(['referrals', 'backfill', '--since', '2026-01-01', '--map', 'x'], makeCtx(io2, [], {}, { readFile: () => 'usr_1,!!' }))).toBe(1);
    expect(io2.stderr()).toContain("line 1: '!!' is not a valid code");
    const io3 = captureIO();
    expect(await run(['referrals', 'backfill', '--since', '2026-01-01', '--metadata-path', 'code'], makeCtx(io3, [], {}))).toBe(1);
  });
});

describe('atlas referrals status', () => {
  it('prints the connection and only the referral preflight findings', async () => {
    const io = captureIO();
    const code = await run(
      ['referrals', 'status'],
      makeCtx(io, [], {
        'GET /v1/instance/referrals': {
          enabled: true,
          provider: 'referally',
          endpoint_url: 'https://r.example.com',
          program_id: 'prg_1',
          connection_id: 'conn_1',
          signing_secret_set: true,
          forward_lifecycle: true,
          connection: { failed_calls_7d: 2, retrying_calls: 1, alert: { code: 'signature_rejected', message: 'HTTP 401' } },
        },
        'GET /v1/instance/preflight': {
          findings: [
            { severity: 'warning', code: 'referrals_clock_skew', message: 'Clock off by 90 s', fix: 'Sync the clock.' },
            { severity: 'error', code: 'email_sender_unverified', message: 'x', fix: 'y' },
          ],
        },
      }),
    );
    expect(code).toBe(0);
    const out = io.stdout();
    expect(out).toContain('Referral attribution: on');
    expect(out).toContain('Connection ID:        conn_1');
    expect(out).toContain('Alert:                signature_rejected: HTTP 401');
    expect(out).toContain('referrals_clock_skew');
    expect(out).not.toContain('email_sender_unverified');
  });

  it('exits 1 on a referral preflight error', async () => {
    const io = captureIO();
    const code = await run(
      ['referrals', 'status', '--json'],
      makeCtx(io, [], {
        'GET /v1/instance/referrals': { enabled: true, provider: 'webhook', endpoint_url: null, program_id: null, connection_id: null, signing_secret_set: false },
        'GET /v1/instance/preflight': { findings: [{ severity: 'error', code: 'referrals_secret_invalid', message: 'x', fix: 'y' }] },
      }),
    );
    expect(code).toBe(1);
    expect(JSON.parse(io.stdout()).findings[0].code).toBe('referrals_secret_invalid');
  });
});

describe('referrals helpers', () => {
  it('computes clock skew and warns over 60 s', () => {
    expect(pingSkewMs({ clock_skew_ms: 5 }, 0)).toBe(5);
    expect(pingSkewMs({ server_time: '2026-10-21T14:00:00Z' }, Date.parse('2026-10-21T14:01:30Z'))).toBe(-90_000);
    expect(pingSkewMs({}, 0)).toBeNull();
    const lines = describeTestLines({ ok: true, ping: { server_time: '2026-10-21T14:00:00Z' } }, Date.parse('2026-10-21T14:01:30Z'));
    expect(lines.join('\n')).toContain('more than 60 seconds');
  });

  it('parses a code CSV', () => {
    expect(parseCodeCsv('user_id,code\nu1,ABC123\n\n# x\nu2\tDEF456')).toEqual({ u1: 'ABC123', u2: 'DEF456' });
    expect(() => parseCodeCsv('u1')).toThrow(/expected customerRef,code/);
  });

  it('has help', async () => {
    const io = captureIO();
    expect(await run(['referrals', '--help'], makeCtx(io, [], {}))).toBe(0);
    expect(io.stdout()).toContain('--provider referally');
    const io2 = captureIO();
    expect(await run(['referrals', 'nope'], makeCtx(io2, [], {}))).toBe(1);
  });
});
