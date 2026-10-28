import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryConfigStore } from '../config';
import type { ConfigHttp } from '../config-http';
import type { ManagementClient, RunContext } from '../context';
import { captureIO, type CaptureIO } from '../io';
import { run } from '../run';
import { parseDuration, parseWhen } from './webhooks';

const SECRET = 'whsec_secret_value_for_tests_0001';

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

function fakeHttp(answers: Record<string, unknown | ((call: Call) => unknown)>, calls: Call[]): ConfigHttp {
  const answer = (method: string, path: string, body?: unknown) => {
    const call = { method, path, body };
    calls.push(call);
    const hit = answers[`${method} ${path}`] ?? answers[`${method} ${path.split('?')[0]}`];
    if (hit === undefined) throw new Error(`unexpected ${method} ${path}`);
    return Promise.resolve(typeof hit === 'function' ? (hit as (c: Call) => unknown)(call) : hit);
  };
  return {
    get: (p) => answer('GET', p) as never,
    post: (p, b) => answer('POST', p, b) as never,
    put: (p, b) => answer('PUT', p, b) as never,
    patch: (p, b) => answer('PATCH', p, b) as never,
    delete: async (p) => void (await answer('DELETE', p)),
  };
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'atlas-cli-wh-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function ctx(io: CaptureIO, http: ConfigHttp, extra: Partial<RunContext> = {}): RunContext {
  return {
    io,
    env: { XDG_CONFIG_HOME: home },
    config: new MemoryConfigStore({
      active_profile: 'default',
      profiles: { default: { api_url: 'https://api.test', secret_key: 'sk_test_123456' } },
    }),
    prompt: { text: async () => '', secret: async () => '' },
    makeClient: () => ({}) as ManagementClient,
    makeHttp: () => http,
    readFile: () => '',
    sleep: async () => undefined,
    ...extra,
  };
}

describe('helpers', () => {
  it('parseDuration', () => {
    expect(parseDuration('10s', '--t')).toBe(10_000);
    expect(parseDuration('2m', '--t')).toBe(120_000);
    expect(parseDuration('5', '--t')).toBe(5000);
    expect(() => parseDuration('soon', '--t')).toThrow(/duration/);
  });
  it('parseWhen: ISO, relative, failing_since', () => {
    expect(parseWhen('2026-10-01T00:00:00Z', '--since')).toBe('2026-10-01T00:00:00.000Z');
    expect(parseWhen('1h', '--since', Date.parse('2026-10-01T12:00:00Z'))).toBe('2026-10-01T11:00:00.000Z');
    expect(parseWhen('failing_since', '--since')).toBe('failing_since');
    expect(() => parseWhen('yesterday-ish', '--since')).toThrow(/ISO date/);
  });
});

describe('webhooks test', () => {
  it('waits inline for the result and exits 0 on a 2xx', async () => {
    const calls: Call[] = [];
    const http = fakeHttp(
      { 'POST /v1/webhook_endpoints/wh_1/test': { delivery_id: 'del_1', status: 'delivered', http_status: 200, latency_ms: 41, error: null, response_snippet: 'ok' } },
      calls,
    );
    const io = captureIO();
    expect(await run(['webhooks', 'test', 'wh_1'], ctx(io, http))).toBe(0);
    expect(calls[0]!.path).toBe('/v1/webhook_endpoints/wh_1/test?wait=10s');
    expect(io.stdout()).toContain('delivered (HTTP 200) in 41 ms');
  });

  it('exits 1 when the endpoint answers non-2xx', async () => {
    const http = fakeHttp({ 'POST /v1/webhook_endpoints/wh_1/test': { delivery_id: 'd', status: 'failed', http_status: 500, error: 'webhook_http_5xx' } }, []);
    const io = captureIO();
    expect(await run(['webhooks', 'test', 'wh_1'], ctx(io, http))).toBe(1);
    expect(io.stderr()).toContain('2xx');
    expect(io.stdout()).toContain('webhook_http_5xx');
  });

  it('falls back to polling the delivery log when the API only queues the test', async () => {
    let polls = 0;
    const http = fakeHttp(
      {
        'POST /v1/webhook_endpoints/wh_1/test': { id: 'del_9', status: 'pending' },
        'GET /v1/webhook_endpoints/wh_1/deliveries': () =>
          ++polls < 3 ? { data: [{ id: 'del_9', status: 'pending' }] } : { data: [{ id: 'del_9', status: 'success', http_status: 204 }] },
      },
      [],
    );
    const io = captureIO();
    expect(await run(['webhooks', 'test', 'wh_1'], ctx(io, http))).toBe(0);
    expect(polls).toBe(3);
    expect(io.stdout()).toContain('HTTP 204');
  });

  it('--no-wait only queues', async () => {
    const calls: Call[] = [];
    const http = fakeHttp({ 'POST /v1/webhook_endpoints/wh_1/test': { id: 'del_1', status: 'pending' } }, calls);
    const io = captureIO();
    expect(await run(['webhooks', 'test', 'wh_1', '--no-wait', '--json'], ctx(io, http))).toBe(0);
    expect(calls[0]!.path).toBe('/v1/webhook_endpoints/wh_1/test');
    expect(JSON.parse(io.stdout()).id).toBe('del_1');
  });
});

describe('webhooks deliveries', () => {
  it('passes filters through and renders a table with a next-page hint', async () => {
    const calls: Call[] = [];
    const http = fakeHttp(
      {
        'GET /v1/webhook_endpoints/wh_1/deliveries': {
          data: [{ id: 'del_2', event_type: 'user.created', status: 'failed', http_status: 500, attempt_number: 2, error: 'webhook_http_5xx', created_at: 0 }],
          has_more: true,
          next_cursor: 'del_2',
        },
      },
      calls,
    );
    const io = captureIO();
    expect(
      await run(['webhooks', 'deliveries', 'wh_1', '--status', 'failed', '--event-type', 'user.created', '--since', '2026-10-01T00:00:00Z', '--limit', '5', '--starting-after', 'del_9'], ctx(io, http)),
    ).toBe(0);
    const q = new URLSearchParams(calls[0]!.path.split('?')[1]);
    expect(q.get('status')).toBe('failed');
    expect(q.get('event_type')).toBe('user.created');
    expect(q.get('since')).toBe('2026-10-01T00:00:00.000Z');
    expect(q.get('limit')).toBe('5');
    expect(q.get('starting_after')).toBe('del_9');
    expect(io.stdout()).toContain('webhook_http_5xx');
    expect(io.stdout()).toContain('--starting-after del_2');
  });
});

describe('webhooks update', () => {
  it('patches only the given fields', async () => {
    const calls: Call[] = [];
    const http = fakeHttp({ 'PATCH /v1/webhook_endpoints/wh_1': { id: 'wh_1' } }, calls);
    const io = captureIO();
    expect(await run(['webhooks', 'update', 'wh_1', '--url', 'https://new.example/h', '--events', 'user.created,user.updated', '--inactive'], ctx(io, http))).toBe(0);
    expect(calls[0]!.body).toEqual({ url: 'https://new.example/h', enabled_events: ['user.created', 'user.updated'], active: false });
  });
  it('refuses an empty update and contradictory flags', async () => {
    const http = fakeHttp({}, []);
    expect(await run(['webhooks', 'update', 'wh_1'], ctx(captureIO(), http))).toBe(1);
    expect(await run(['webhooks', 'update', 'wh_1', '--active', '--inactive'], ctx(captureIO(), http))).toBe(1);
  });
});

describe('webhooks redeliver / replay', () => {
  it('redelivers one delivery', async () => {
    const calls: Call[] = [];
    const http = fakeHttp({ 'POST /v1/webhook_endpoints/wh_1/deliveries/del_3/redeliver': { id: 'del_4', status: 'pending' } }, calls);
    const io = captureIO();
    expect(await run(['webhooks', 'redeliver', 'wh_1', '--delivery', 'del_3'], ctx(io, http))).toBe(0);
    expect(io.stdout()).toContain('del_4');
  });
  it('redelivers a failed window in bulk', async () => {
    const calls: Call[] = [];
    const http = fakeHttp({ 'POST /v1/webhook_endpoints/wh_1/redeliver': { queued: 3 } }, calls);
    const io = captureIO();
    expect(await run(['webhooks', 'redeliver', 'wh_1', '--since', '2026-10-01T00:00:00Z', '--until', '2026-10-02T00:00:00Z'], ctx(io, http))).toBe(0);
    expect(calls[0]!.body).toEqual({ since: '2026-10-01T00:00:00.000Z', until: '2026-10-02T00:00:00.000Z', status: 'failed' });
    expect(io.stdout()).toContain('Queued 3 redeliveries');
  });
  it('needs a delivery or a window', async () => {
    expect(await run(['webhooks', 'redeliver', 'wh_1'], ctx(captureIO(), fakeHttp({}, [])))).toBe(1);
  });
  it('replay defaults to since=failing_since', async () => {
    const calls: Call[] = [];
    const http = fakeHttp({ 'POST /v1/webhook_endpoints/wh_1/replay': { queued: 7 } }, calls);
    const io = captureIO();
    expect(await run(['webhooks', 'replay', 'wh_1'], ctx(io, http))).toBe(0);
    expect(calls[0]!.path).toBe('/v1/webhook_endpoints/wh_1/replay?since=failing_since');
    expect(io.stdout()).toContain('7 held event');
  });
});

describe('webhook secrets go to files, never the terminal', () => {
  it('rotate writes the new secret to a 0600 file and says when the old one stops', async () => {
    const calls: Call[] = [];
    const http = fakeHttp(
      { 'POST /v1/webhook_endpoints/wh_1/rotate_secret': { secret: SECRET, overlap_seconds: 3600, previous_secret_expires_at: Date.parse('2026-10-01T01:00:00Z'), warning: 'Deploy the new secret.' } },
      calls,
    );
    const io = captureIO();
    expect(await run(['webhooks', 'rotate', 'wh_1', '--overlap', '3600', '--product', 'acme'], ctx(io, http))).toBe(0);
    expect(calls[0]!.body).toEqual({ overlap_seconds: 3600 });
    const file = join(home, 'acme', 'webhook-wh_1.env');
    expect(readFileSync(file, 'utf8')).toContain(SECRET);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(`${io.stdout()}${io.stderr()}`).not.toContain(SECRET);
    expect(io.stdout()).toContain('2026-10-01T01:00:00.000Z');
    // A second rotation replaces the file by design.
    const http2 = fakeHttp({ 'POST /v1/webhook_endpoints/wh_1/rotate_secret': { secret: `${SECRET}_2`, overlap_seconds: 0 } }, []);
    expect(await run(['webhooks', 'rotate', 'wh_1', '--now', '--product', 'acme'], ctx(captureIO(), http2))).toBe(0);
    expect(readFileSync(file, 'utf8')).toContain(`${SECRET}_2`);
  });

  it('rotate rejects --now with --overlap', async () => {
    expect(await run(['webhooks', 'rotate', 'wh_1', '--now', '--overlap', '5'], ctx(captureIO(), fakeHttp({}, [])))).toBe(1);
  });

  it('reveal writes to a file; --print-secret prints it with a warning', async () => {
    const http = fakeHttp({ 'POST /v1/webhook_endpoints/wh_1/reveal_secret': { object: 'webhook_secret', secret: SECRET } }, []);
    const io = captureIO();
    expect(await run(['webhooks', 'reveal', 'wh_1', '--product', 'acme'], ctx(io, http))).toBe(0);
    expect(io.stdout()).not.toContain(SECRET);
    expect(readFileSync(join(home, 'acme', 'webhook-wh_1.env'), 'utf8')).toContain(SECRET);

    const io2 = captureIO();
    expect(await run(['webhooks', 'reveal', 'wh_1', '--print-secret'], ctx(io2, http))).toBe(0);
    expect(io2.stdout()).toContain(`ATLAS_WEBHOOK_SECRET=${SECRET}`);
    expect(io2.stderr()).toContain('warning');
  });

  it('upsert uses PUT by_url and keeps quiet about a secret it did not create', async () => {
    const calls: Call[] = [];
    const http = fakeHttp({ 'PUT /v1/webhook_endpoints/by_url': { id: 'wh_1', url: 'https://x.example/h' } }, calls);
    const io = captureIO();
    expect(await run(['webhooks', 'upsert', '--url', 'https://x.example/h', '--events', 'user.created'], ctx(io, http))).toBe(0);
    expect(calls[0]).toMatchObject({ method: 'PUT', body: { url: 'https://x.example/h', enabled_events: ['user.created'] } });
    expect(io.stdout()).toContain('already existed');
  });

  it('create still posts and writes the secret file', async () => {
    const http = fakeHttp({ 'POST /v1/webhook_endpoints': { id: 'wh_2', url: 'https://x.example/h', secret: SECRET } }, []);
    const io = captureIO();
    expect(await run(['webhooks', 'create', '--url', 'https://x.example/h', '--product', 'acme', '--json'], ctx(io, http))).toBe(0);
    expect(io.stdout()).not.toContain(SECRET);
    expect(JSON.parse(io.stdout()).secret_file).toBe(join(home, 'acme', 'webhook-wh_2.env'));
  });

  it('names every subcommand in the unknown-subcommand error', async () => {
    const io = captureIO();
    expect(await run(['webhooks', 'frob'], ctx(io, fakeHttp({}, [])))).toBe(1);
    expect(io.stderr()).toContain('rotate, reveal');
  });
});
