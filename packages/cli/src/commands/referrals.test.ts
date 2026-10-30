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
 * in-memory Atlas API and an in-memory Referalli merchant API.
 */

type Call = { method: string; path: string; body?: unknown };

const MERCHANT_KEY = 'rk_live_merchant_key_never_printed';
const CONN_SECRET = 'rcs_connection_secret_never_printed';
const WEBHOOK_SECRET = 'whsec_webhook_secret_never_printed';
const INBOUND_URL = 'https://api.atlas.test/v1/webhooks/referrals/ins_1';
/** The Atlas side of a production instance: the settings PATCH answers with the inbound URL. */
const ATLAS = {
  'GET /v1/instance': { id: 'ins_1', environment: 'production' },
  'PATCH /v1/instance/referrals': { inbound: { url: INBOUND_URL } },
  'POST /v1/instance/referrals/test': undefined as unknown,
};

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

type Remote = Array<{ url: string; init: RequestInit }>;

/** An in-memory Referalli merchant API, routed by `METHOD path`; `over` replaces answers (404 for anything unknown). */
function referalliApi(record: Remote, over: Record<string, { status: number; body: unknown }> = {}) {
  const routes: Record<string, { status: number; body: unknown }> = {
    'GET /v1/org': { status: 200, body: { id: 'org_1', livemode: true } },
    'POST /v1/auth/connections': { status: 201, body: { id: 'conn_1', secret: CONN_SECRET, trackingToken: 'tt_pub_1', signupsUrl: 'x' } },
    'PATCH /v1/auth/connections/conn_1': { status: 200, body: { id: 'conn_1', signatureVersion: 'v2' } },
    'POST /v1/webhook-endpoints': { status: 201, body: { id: 'whe_1', url: INBOUND_URL, secret: WEBHOOK_SECRET } },
    ...over,
  };
  return (async (url: string | URL, init?: RequestInit) => {
    record.push({ url: String(url), init: init ?? {} });
    const r = routes[`${init?.method ?? 'GET'} ${new URL(String(url)).pathname}`] ?? { status: 404, body: { error: { message: 'not found' } } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

const sent = (remote: Remote, method: string, path: string) =>
  remote.find((r) => (r.init.method ?? 'GET') === method && new URL(r.url).pathname === path);

const PING_OK = {
  ok: true,
  http_status: 200,
  latency_ms: 42,
  ping: { ok: true, org_name: 'Acme', program_id: 'prg_1', program_name: 'Main', auto_enroll_users: true, clock_skew_ms: 1200 },
};

describe('atlas referrals connect --provider referalli', () => {
  it('creates the connection with the merchant key, stores id + secret on the instance, pings, and never prints a secret', async () => {
    const io = captureIO();
    const calls: Call[] = [];
    const remote: Array<{ url: string; init: RequestInit }> = [];
    const code = await run(
      [
        'referrals', 'connect', '--provider', 'referalli', '--program', 'prg_1',
        '--base-url', 'https://referrals.example.com/', '--referalli-key', MERCHANT_KEY,
        '--auto-enroll', '--destination', 'https://app.example.com/login', '--enable',
      ],
      makeCtx(io, calls, { ...ATLAS, 'POST /v1/instance/referrals/test': PING_OK }, { fetch: referalliApi(remote) }),
    );
    expect(code).toBe(0);
    expect(remote.map((r) => `${r.init.method ?? 'GET'} ${r.url}`)).toEqual([
      'GET https://referrals.example.com/v1/org',
      'POST https://referrals.example.com/v1/auth/connections',
      'PATCH https://referrals.example.com/v1/auth/connections/conn_1',
      'POST https://referrals.example.com/v1/webhook-endpoints',
    ]);
    for (const r of remote) {
      const headers = r.init.headers as Record<string, string>;
      expect(headers.authorization).toBe(`Bearer ${MERCHANT_KEY}`);
      expect(headers['referalli-version']).toBe('2026-10-21');
    }
    expect(JSON.parse(sent(remote, 'PATCH', '/v1/auth/connections/conn_1')!.init.body as string)).toEqual({ signatureVersion: 'v2' });
    expect(JSON.parse(sent(remote, 'POST', '/v1/webhook-endpoints')!.init.body as string)).toEqual({
      url: INBOUND_URL,
      topics: ['referral.created', 'referral.held', 'referral.paused', 'referral.resumed', 'referral.approved', 'referral.voided', 'referral.reassigned'],
      legacySignature: false,
    });
    expect(JSON.parse(sent(remote, 'POST', '/v1/auth/connections')!.init.body as string)).toEqual({
      provider: 'atlas',
      instanceId: 'ins_1',
      programId: 'prg_1',
      autoEnrollUsers: true,
      destinationUrl: 'https://app.example.com/login',
    });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /v1/instance',
      'PATCH /v1/instance/referrals',
      'PATCH /v1/instance/referrals',
      'POST /v1/instance/referrals/test',
      'PATCH /v1/instance/referrals',
    ]);
    expect(calls[1]!.body).toEqual({
      provider: 'referalli',
      endpoint_url: 'https://referrals.example.com',
      connection_id: 'conn_1',
      signing_secret: CONN_SECRET,
      program_id: 'prg_1',
      auto_enroll_users: true,
      tracking_token: 'tt_pub_1',
    });
    expect(calls[2]!.body).toEqual({ inbound_secret: WEBHOOK_SECRET, inbound_endpoint_id: 'whe_1' });
    expect(calls[4]!.body).toEqual({ enabled: true });
    const all = io.stdout() + io.stderr();
    expect(all).not.toContain(MERCHANT_KEY);
    expect(all).not.toContain(CONN_SECRET);
    expect(all).not.toContain(WEBHOOK_SECRET);
    expect(io.stderr()).toBe('');
    expect(io.stdout()).toContain('Referral changes on Referalli sync back to Atlas (webhook whe_1).');
    expect(io.stdout()).toContain('Organization:       Acme');
    expect(io.stdout()).toContain('Program:            Main (prg_1)');
    expect(io.stdout()).toContain('Referral attribution is on.');
  });

  it('reads the key from a file and refuses a missing base URL or program', async () => {
    const io = captureIO();
    const calls: Call[] = [];
    const remote: Array<{ url: string; init: RequestInit }> = [];
    const ctx = makeCtx(io, calls, { ...ATLAS, 'POST /v1/instance/referrals/test': PING_OK }, {
      fetch: referalliApi(remote),
      readFile: () => `# merchant key\nREFERALLI_API_KEY=${MERCHANT_KEY}\n`,
    });
    expect(await run(['referrals', 'connect', '--program', 'prg_1', '--base-url', 'https://r.example.com', '--referalli-key-file', 'k.env'], ctx)).toBe(0);
    expect((remote[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${MERCHANT_KEY}`);

    const io2 = captureIO();
    expect(await run(['referrals', 'connect', '--program', 'prg_1', '--referalli-key', 'k'], makeCtx(io2, [], {}))).toBe(1);
    expect(io2.stderr()).toContain('--base-url');
    const io3 = captureIO();
    expect(await run(['referrals', 'connect', '--base-url', 'https://r.example.com'], makeCtx(io3, [], {}))).toBe(1);
    expect(io3.stderr()).toContain('--program');
    const io4 = captureIO();
    expect(await run(['referrals', 'connect', '--program', 'p', '--base-url', 'http://r.example.com', '--referalli-key', 'k'], makeCtx(io4, [], {}))).toBe(1);
    expect(io4.stderr()).toContain('https');
  });

  it('reports a refused merchant key without echoing it', async () => {
    const io = captureIO();
    const remote: Array<{ url: string; init: RequestInit }> = [];
    const code = await run(
      ['referrals', 'connect', '--program', 'prg_1', '--base-url', 'https://r.example.com', '--referalli-key', MERCHANT_KEY],
      makeCtx(io, [], ATLAS, {
        fetch: referalliApi(remote, {
          'GET /v1/org': { status: 401, body: { error: { message: 'invalid key' } } },
          'POST /v1/auth/connections': { status: 401, body: { error: { message: 'invalid key' } } },
        }),
      }),
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
      ['referrals', 'connect', '--program', 'prg_1', '--base-url', 'https://r.example.com', '--referalli-key', MERCHANT_KEY],
      makeCtx(
        io,
        [],
        { ...ATLAS, 'PATCH /v1/instance/referrals': new AtlasApiError(422, [{ code: 'VALIDATION', message: 'bad' } as never]) },
        { fetch: referalliApi(remote) },
      ),
    );
    expect(code).toBe(1);
    const file = join(home, 'atlasauth', 'referalli-connection-conn_1.env');
    expect(readFileSync(file, 'utf8')).toContain(`REFERALLI_CONNECTION_SECRET=${CONN_SECRET}`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(io.stdout() + io.stderr()).not.toContain(CONN_SECRET);
  });

  it('does not turn referrals on when the ping fails', async () => {
    const io = captureIO();
    const calls: Call[] = [];
    const code = await run(
      ['referrals', 'connect', '--program', 'prg_1', '--base-url', 'https://r.example.com', '--referalli-key', MERCHANT_KEY, '--enable'],
      makeCtx(
        io,
        calls,
        {
          ...ATLAS,
          'POST /v1/instance/referrals/test': { ok: false, http_status: 401, latency_ms: 10, error: { code: 'signature_rejected', message: 'Signature rejected' } },
        },
        { fetch: referalliApi([]) },
      ),
    );
    expect(code).toBe(1);
    // The connection and the webhook secret are saved; referrals are not turned on.
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(2);
    expect(calls.some((c) => (c.body as Record<string, unknown> | undefined)?.enabled === true)).toBe(false);
    expect(io.stdout()).toContain('Connection test failed (HTTP 401, 10 ms): Signature rejected.');
  });
});

describe('atlas referrals connect --provider referalli: test vs live, v2 and sync', () => {
  const args = ['referrals', 'connect', '--program', 'prg_1', '--base-url', 'https://r.example.com', '--referalli-key', MERCHANT_KEY];

  it('refuses a live key for a development instance before creating anything', async () => {
    const io = captureIO();
    const remote: Remote = [];
    const code = await run(args, makeCtx(io, [], { ...ATLAS, 'GET /v1/instance': { id: 'ins_1', environment: 'development' } }, { fetch: referalliApi(remote) }));
    expect(code).toBe(1);
    expect(io.stderr()).toContain('reaches live data but instance ins_1 is development');
    expect(io.stderr()).toContain('rk_test_');
    expect(sent(remote, 'POST', '/v1/auth/connections')).toBeUndefined();
  });

  it('refuses a test org for a production instance; --allow-mode-mismatch goes ahead with a warning', async () => {
    const remoteOver = { 'GET /v1/org': { status: 200, body: { id: 'org_t', livemode: false } } };
    const io = captureIO();
    expect(await run(args, makeCtx(io, [], ATLAS, { fetch: referalliApi([], remoteOver) }))).toBe(1);
    expect(io.stderr()).toContain('reaches test data but instance ins_1 is production');
    const io2 = captureIO();
    const remote: Remote = [];
    const code = await run([...args, '--allow-mode-mismatch'], makeCtx(io2, [], { ...ATLAS, 'POST /v1/instance/referrals/test': PING_OK }, { fetch: referalliApi(remote, remoteOver) }));
    expect(code).toBe(0);
    expect(io2.stderr()).toContain('warning: the Referalli key reaches test data');
    expect(sent(remote, 'POST', '/v1/auth/connections')).toBeDefined();
  });

  it('falls back to the key prefix when Referalli reports no mode: rk_test_ suits a development instance', async () => {
    const io = captureIO();
    const remote: Remote = [];
    const testKey = 'rk_test_merchant_key_never_printed';
    const code = await run(
      ['referrals', 'connect', '--program', 'prg_1', '--base-url', 'https://r.example.com', '--referalli-key', testKey],
      makeCtx(io, [], { ...ATLAS, 'GET /v1/instance': { id: 'ins_1', environment: 'development' }, 'POST /v1/instance/referrals/test': PING_OK }, {
        fetch: referalliApi(remote, { 'GET /v1/org': { status: 200, body: { id: 'org_1' } } }),
      }),
    );
    expect(code).toBe(0);
    expect(io.stderr()).toBe('');
  });

  it('--no-sync registers no webhook; a refused webhook or v2 switch is a warning, not a failure', async () => {
    const io = captureIO();
    const remote: Remote = [];
    expect(await run([...args, '--no-sync'], makeCtx(io, [], { ...ATLAS, 'POST /v1/instance/referrals/test': PING_OK }, { fetch: referalliApi(remote) }))).toBe(0);
    expect(sent(remote, 'POST', '/v1/webhook-endpoints')).toBeUndefined();

    const io2 = captureIO();
    const calls: Call[] = [];
    const code = await run(
      [...args, '--json'],
      makeCtx(io2, calls, { ...ATLAS, 'POST /v1/instance/referrals/test': PING_OK }, {
        fetch: referalliApi([], {
          'PATCH /v1/auth/connections/conn_1': { status: 400, body: { error: { message: 'unknown field signatureVersion' } } },
          'POST /v1/webhook-endpoints': { status: 403, body: { error: { message: 'admins only' } } },
        }),
      }),
    );
    expect(code).toBe(0);
    expect(io2.stderr()).toContain('require v2 signatures on the connection (HTTP 400)');
    expect(io2.stderr()).toContain('register the referral event webhook (HTTP 403)');
    expect(JSON.parse(io2.stdout())).toMatchObject({ signature_v2_required: false, sync_endpoint_id: null, livemode: true });
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
  });

  it('keeps the webhook secret in a 0600 file when saving it on the instance fails', async () => {
    const io = captureIO();
    let patches = 0;
    const code = await run(
      args,
      makeCtx(
        io,
        [],
        {
          ...ATLAS,
          'PATCH /v1/instance/referrals': () => {
            patches += 1;
            if (patches === 2) throw new AtlasApiError(500, [{ code: 'INTERNAL', message: 'boom' } as never]);
            return { inbound: { url: INBOUND_URL } };
          },
          'POST /v1/instance/referrals/test': PING_OK,
        },
        { fetch: referalliApi([]) },
      ),
    );
    expect(code).toBe(0);
    const file = join(home, 'atlasauth', 'referalli-webhook-whe_1.env');
    expect(readFileSync(file, 'utf8')).toContain(`REFERALLI_WEBHOOK_SECRET=${WEBHOOK_SECRET}`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(io.stdout() + io.stderr()).not.toContain(WEBHOOK_SECRET);
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
    expect(io.stderr()).toContain('--provider must be one of referalli, webhook');
  });
});

describe('atlas referrals resync', () => {
  it('re-reports one user, with a dry run flag, and prints the code and link', async () => {
    const io = captureIO();
    const calls: Call[] = [];
    const code = await run(
      ['referrals', 'resync', 'user_1', '--dry-run'],
      makeCtx(io, calls, {
        'POST /v1/users/user_1/referral/resync?dry_run=true': {
          user_id: 'user_1',
          call_id: 'rfc_1',
          call_status: 'succeeded',
          error: null,
          referral: { referral_code: 'ENROLLED1', referral_link: 'https://app.example.com/join?ref=ENROLLED1' },
        },
      }),
    );
    expect(code).toBe(0);
    expect(io.stdout()).toContain('Re-reported user_1: call rfc_1 succeeded (dry run, nothing sent).');
    expect(io.stdout()).toContain('Referral code ENROLLED1, link https://app.example.com/join?ref=ENROLLED1.');
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

  it("sends each user's own codes from --own-map and --own-metadata-path and names the ones taken", async () => {
    const io = captureIO();
    const calls: Call[] = [];
    const code = await run(
      ['referrals', 'backfill', '--since', '2026-01-01', '--own-map', 'own.csv', '--own-metadata-path', 'public_metadata.my_code'],
      makeCtx(
        io,
        calls,
        {
          'POST /v1/instance/referrals/backfill': {
            id: 'rbf_2',
            status: 'running',
            own_codes_set: 1,
            own_codes_taken: ['usr_2'],
            calls: { pending: 2, succeeded: 0, failed: 0, skipped: 0, held: 0 },
          },
        },
        { readFile: () => 'usr_1,ALICEOWN\nusr_2,TAKEN1\n' },
      ),
    );
    expect(code).toBe(0);
    expect(calls[0]!.body).toEqual({
      since: '2026-01-01',
      own_codes: { usr_1: 'ALICEOWN', usr_2: 'TAKEN1' },
      own_code_metadata_path: 'public_metadata.my_code',
    });
    expect(io.stdout()).toContain('1 own code(s) kept.');
    expect(io.stderr()).toContain('already belong to another user, not set: usr_2');
    const io2 = captureIO();
    expect(await run(['referrals', 'backfill', '--since', '2026-01-01', '--own-map', 'x'], makeCtx(io2, [], {}, { readFile: () => 'usr_1,!!' }))).toBe(1);
    expect(io2.stderr()).toContain("--own-map line 1: '!!' is not a valid code");
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
          provider: 'referalli',
          endpoint_url: 'https://r.example.com',
          program_id: 'prg_1',
          connection_id: 'conn_1',
          signing_secret_set: true,
          forward_lifecycle: true,
          connection: { failed_calls_7d: 2, retrying_calls: 1, alert: { code: 'signature_rejected', message: 'HTTP 401' } },
          inbound: {
            url: INBOUND_URL,
            secret_set: true,
            endpoint_id: 'whe_1',
            last_event: { at: Date.parse('2026-10-22T09:00:00Z'), type: 'referral.voided', outcome: 'applied' },
          },
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
    expect(out).toContain('Two-way sync:         on (webhook whe_1)');
    expect(out).toContain(`Inbound URL:          ${INBOUND_URL}`);
    expect(out).toContain('Last event:           referral.voided → applied at 2026-10-22T09:00:00.000Z');
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
    expect(io.stdout()).toContain('--provider referalli');
    const io2 = captureIO();
    expect(await run(['referrals', 'nope'], makeCtx(io2, [], {}))).toBe(1);
  });
});

describe('the old Referally names', () => {
  it('--provider referally, --referally-key and REFERALLY_* still work, each with a notice', async () => {
    const io = captureIO();
    const calls: Call[] = [];
    const remote: Remote = [];
    const code = await run(
      ['referrals', 'connect', '--provider', 'referally', '--program', 'prg_1', '--referally-key', MERCHANT_KEY],
      makeCtx(
        io,
        calls,
        { ...ATLAS, 'POST /v1/instance/referrals/test': PING_OK },
        { fetch: referalliApi(remote), env: { XDG_CONFIG_HOME: home, REFERALLY_BASE_URL: 'https://referrals.example.com' } },
      ),
    );
    expect(code).toBe(0);
    expect(io.stderr()).toContain("'--provider referally' is the old name of '--provider referalli'");
    expect(io.stderr()).toContain("'--referally-key' is the old name of '--referalli-key'");
    expect(io.stderr()).toContain("'REFERALLY_BASE_URL' is the old name of 'REFERALLI_BASE_URL'");
    expect(calls.find((c) => c.method === 'PATCH' && c.path === '/v1/instance/referrals')?.body).toMatchObject({ provider: 'referalli' });
    expect(io.stdout() + io.stderr()).not.toContain(MERCHANT_KEY);
  });

  it('REFERALLY_API_KEY and --referally-key-file are read too', async () => {
    const io = captureIO();
    const remote: Remote = [];
    const code = await run(
      ['referrals', 'connect', '--program', 'prg_1', '--base-url', 'https://referrals.example.com'],
      makeCtx(io, [], { ...ATLAS, 'POST /v1/instance/referrals/test': PING_OK }, {
        fetch: referalliApi(remote),
        env: { XDG_CONFIG_HOME: home, REFERALLY_API_KEY: MERCHANT_KEY },
      }),
    );
    expect(code).toBe(0);
    expect(io.stderr()).toContain("'REFERALLY_API_KEY' is the old name of 'REFERALLI_API_KEY'");
    expect(sent(remote, 'GET', '/v1/org')?.init.headers).toMatchObject({ authorization: `Bearer ${MERCHANT_KEY}` });
  });
});

describe('atlas referrals connect --provider referalli --oauth', () => {
  const AUTHORIZE = 'https://referalli.com/v1/oauth/authorize?client_id=atlas&scope=connections%3Awrite&state=abc';

  it('prints the link, waits for the connection to appear, then pings', async () => {
    const io = captureIO();
    const calls: Call[] = [];
    let reads = 0;
    const code = await run(
      ['referrals', 'connect', '--provider', 'referalli', '--oauth', '--enable'],
      makeCtx(io, calls, {
        'POST /v1/instance/referrals/referalli/install': { authorize_url: AUTHORIZE, expires_at: Date.now() + 600_000 },
        'GET /v1/instance/referrals': () => {
          reads += 1;
          // Read 1 is the state before; the merchant finishes by the third read.
          return reads < 3
            ? { provider: 'webhook', connection_id: null }
            : { provider: 'referalli', connection_id: 'conn_9', program_id: 'prg_9', signing_secret_set: true };
        },
        'POST /v1/instance/referrals/test': PING_OK,
      }),
    );
    expect(code).toBe(0);
    expect(io.stdout()).toContain(AUTHORIZE);
    expect(io.stdout()).toContain('Connected to referalli (connection conn_9, program prg_9)');
    expect(io.stdout()).toContain('Referral attribution is on.');
    expect(calls.some((c) => c.method === 'PATCH' && JSON.stringify(c.body) === '{"enabled":true}')).toBe(true);
    // No key or secret is involved at all.
    expect(calls.some((c) => JSON.stringify(c.body ?? '').includes('signing_secret'))).toBe(false);
  });

  it('points to the key flow when the deployment does not offer one-click yet', async () => {
    const io = captureIO();
    const code = await run(
      ['referrals', 'connect', '--provider', 'referalli', '--oauth'],
      makeCtx(io, [], {
        'GET /v1/instance/referrals': { provider: 'webhook', connection_id: null },
        'POST /v1/instance/referrals/referalli/install': new AtlasApiError(422, [{ code: 'REFERRALS_NOT_CONFIGURED', message: 'not available' }]),
      }),
    );
    expect(code).not.toBe(0);
    expect(io.stderr()).toContain('not available on this Atlas');
    expect(io.stderr()).toContain('--referalli-key-file');
  });

  it('gives up when the link expires', async () => {
    const io = captureIO();
    const code = await run(
      ['referrals', 'connect', '--provider', 'referalli', '--oauth'],
      makeCtx(io, [], {
        'POST /v1/instance/referrals/referalli/install': { authorize_url: AUTHORIZE, expires_at: Date.now() - 1 },
        'GET /v1/instance/referrals': { provider: 'webhook', connection_id: null },
      }),
    );
    expect(code).not.toBe(0);
    expect(io.stderr()).toContain('expired');
  });
});

describe('atlas referrals conformance', () => {
  it('runs the suite against the connected Referalli and exits 1 when a case fails', async () => {
    const io = captureIO();
    // A platform that answers 404 to everything: every case but the 404 ones fails.
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'no' } }), { status: 404, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const code = await run(
      ['referrals', 'conformance', '--secret-file', '/secret', '--only', 'auth.'],
      makeCtx(
        io,
        [],
        { 'GET /v1/instance/referrals': { provider: 'referalli', endpoint_url: 'https://referalli.example.com', connection_id: 'conn_1' } },
        { fetch: fetchImpl, readFile: () => 'conn_secret_0123456789\n' },
      ),
    );
    expect(code).toBe(1);
    expect(io.stdout()).toContain('FAIL  auth.bad_signature_is_401');
    expect(io.stdout()).toContain('PASS  auth.unknown_connection_is_404_or_423');
    expect(io.stdout() + io.stderr()).not.toContain('conn_secret_0123456789');
  });

  it('needs the secret from a file, because Atlas never shows it', async () => {
    const io = captureIO();
    const code = await run(
      ['referrals', 'conformance'],
      makeCtx(io, [], { 'GET /v1/instance/referrals': { provider: 'referalli', endpoint_url: 'https://r.example.com', connection_id: 'c' } }),
    );
    expect(code).not.toBe(0);
    expect(io.stderr()).toContain('--secret-file');
  });
});
