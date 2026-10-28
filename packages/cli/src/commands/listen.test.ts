import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryConfigStore } from '../config';
import type { ManagementClient, RunContext } from '../context';
import { captureIO } from '../io';
import { run } from '../run';
import { readSse } from './listen';

const SECRET = 'whsec_listen_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const frame = (id: string, type: string) => ({
  id,
  type,
  headers: { 'content-type': 'application/json', 'atlas-id': id, 'atlas-timestamp': '1700000000000', 'atlas-signature': 'v1,abc' },
  body: JSON.stringify({ id, type, data: { id: 'user_1' } }),
});
const sse = (...blocks: string[]) => blocks.join('');
const webhook = (id: string, type: string) => `id: ${id}\nevent: webhook\ndata: ${JSON.stringify(frame(id, type))}\n\n`;

function streamOf(text: string, chunk = 17): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream({
    pull(c) {
      if (at >= bytes.length) return c.close();
      c.enqueue(bytes.slice(at, at + chunk));
      at += chunk;
    },
  });
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'atlas-cli-listen-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

interface Seen {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: string;
}

function setup(streams: string[], local: (req: Seen) => number = () => 200) {
  const seen: Seen[] = [];
  let n = 0;
  const fetchFake = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const req: Seen = { url, method: init?.method, headers, body: init?.body as string | undefined };
    seen.push(req);
    if (url.endsWith('/v1/listen/sessions')) {
      return new Response(JSON.stringify({ id: 'lsn_abc', secret: SECRET, events: ['user.*'], expires_at: Date.now() + 3600_000 }), { status: 201 });
    }
    if (url.includes('/stream')) {
      const text = streams[Math.min(n++, streams.length - 1)]!;
      return new Response(streamOf(text), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('ok', { status: local(req) });
  }) as unknown as typeof fetch;
  const ctx = (extra: Partial<RunContext> = {}): RunContext => ({
    io: captureIO(),
    env: { XDG_CONFIG_HOME: home },
    config: new MemoryConfigStore({ active_profile: 'default', profiles: { default: { api_url: 'https://api.test', secret_key: 'sk_test_123456' } } }),
    prompt: { text: async () => '', secret: async () => '' },
    makeClient: () => ({}) as ManagementClient,
    readFile: () => '',
    fetch: fetchFake,
    sleep: async () => undefined,
    ...extra,
  });
  return { seen, ctx };
}

describe('readSse', () => {
  it('parses events across chunk boundaries, comments and multi-line data', async () => {
    const out: unknown[] = [];
    for await (const m of readSse(streamOf(': hi\nretry: 2000\n\nevent: ready\ndata: {"a":1}\n\nid: e1\nevent: webhook\ndata: l1\ndata: l2\n\n', 5))) out.push(m);
    expect(out).toEqual([
      { event: 'ready', id: undefined, data: '{"a":1}' },
      { event: 'webhook', id: 'e1', data: 'l1\nl2' },
    ]);
  });
});

describe('atlas listen', () => {
  it('forwards each event to the local server with the signed headers and exits after --count', async () => {
    const { seen, ctx } = setup([sse(': session\n\n', 'event: ready\ndata: {}\n\n', webhook('evt_1', 'user.created'), webhook('evt_2', 'user.updated'))]);
    const c = ctx();
    const code = await run(['listen', '--forward-to', 'http://localhost:4000/webhooks/atlas', '--events', 'user.*', '--count', '2', '--product', 'acme'], c);
    expect(code).toBe(0);

    const create = seen[0]!;
    expect(create.url).toBe('https://api.test/v1/listen/sessions');
    expect(JSON.parse(create.body!)).toEqual({ events: ['user.*'] });
    expect(create.headers.authorization).toBe('Bearer sk_test_123456');

    const stream = seen[1]!;
    expect(stream.url).toContain('/v1/listen/sessions/lsn_abc/stream?');
    expect(new URL(stream.url).searchParams.get('events')).toBe('user.*');
    expect(new URL(stream.url).searchParams.get('max_events')).toBe('2');

    const forwarded = seen.filter((s) => s.url === 'http://localhost:4000/webhooks/atlas');
    expect(forwarded).toHaveLength(2);
    expect(forwarded[0]!.method).toBe('POST');
    expect(forwarded[0]!.headers['atlas-signature']).toBe('v1,abc');
    expect(forwarded[0]!.headers['atlas-id']).toBe('evt_1');
    expect(JSON.parse(forwarded[0]!.body!).type).toBe('user.created');

    const out = (c.io as ReturnType<typeof captureIO>).stdout();
    expect(out).toContain('user.created  evt_1  → 200');
    expect(out).toContain('user.updated  evt_2');
  });

  it('writes the session secret to a 0600 file and never prints it', async () => {
    const { ctx } = setup([sse(webhook('evt_1', 'user.created'))]);
    const c = ctx();
    await run(['listen', '--forward-to', 'http://localhost:4000/h', '--count', '1', '--product', 'acme'], c);
    const file = join(home, 'acme', 'webhook-listen.env');
    expect(readFileSync(file, 'utf8')).toContain(SECRET);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const io = c.io as ReturnType<typeof captureIO>;
    expect(`${io.stdout()}${io.stderr()}`).not.toContain(SECRET);
    expect(io.stdout()).toContain(file);
  });

  it('exits 1 with --count when the local server fails, and reports the status', async () => {
    const { ctx } = setup([sse(webhook('evt_1', 'user.created'))], () => 500);
    const c = ctx();
    expect(await run(['listen', '--forward-to', 'http://localhost:4000/h', '--count', '1'], c)).toBe(1);
    expect((c.io as ReturnType<typeof captureIO>).stdout()).toContain('→ 500');
  });

  it('reports a local server that is down without crashing the stream', async () => {
    const seen: string[] = [];
    const { ctx } = setup([sse(webhook('evt_1', 'user.created'))]);
    const base = ctx();
    const inner = base.fetch!;
    const c = ctx({
      fetch: (async (input: unknown, init?: RequestInit) => {
        if (String(input).startsWith('http://localhost')) {
          seen.push(String(input));
          throw new Error('connect ECONNREFUSED');
        }
        return inner(input as never, init);
      }) as typeof fetch,
    });
    expect(await run(['listen', '--forward-to', 'http://localhost:4000/h', '--count', '1'], c)).toBe(1);
    expect((c.io as ReturnType<typeof captureIO>).stdout()).toContain('ECONNREFUSED');
    expect(seen).toHaveLength(1);
  });

  it('reconnects with Last-Event-ID after a dropped stream', async () => {
    const { seen, ctx } = setup([sse(webhook('evt_1', 'user.created')), sse(webhook('evt_2', 'user.created'))]);
    expect(await run(['listen', '--forward-to', 'http://localhost:4000/h', '--count', '2'], ctx())).toBe(0);
    const streams = seen.filter((s) => s.url.includes('/stream'));
    expect(streams).toHaveLength(2);
    expect(streams[1]!.headers['last-event-id']).toBe('evt_1');
    expect(new URL(streams[1]!.url).searchParams.get('max_events')).toBe('1');
  });

  it('stops cleanly when the session expires', async () => {
    const { ctx } = setup([sse('event: expired\ndata: {}\n\n')]);
    const c = ctx();
    expect(await run(['listen', '--forward-to', 'http://localhost:4000/h'], c)).toBe(0);
    expect((c.io as ReturnType<typeof captureIO>).stdout()).toContain('expired');
  });

  it('--no-forward only prints; --json emits one object per event', async () => {
    const { seen, ctx } = setup([sse(webhook('evt_1', 'user.created'))]);
    const c = ctx();
    expect(await run(['listen', '--no-forward', '--count', '1', '--json'], c)).toBe(0);
    expect(seen.filter((s) => s.url.startsWith('http://localhost'))).toHaveLength(0);
    expect(JSON.parse((c.io as ReturnType<typeof captureIO>).stdout())).toMatchObject({ id: 'evt_1', type: 'user.created', forwarded: false });
  });

  it('needs --forward-to (or --no-forward) and an http(s) URL', async () => {
    const { ctx } = setup([sse()]);
    expect(await run(['listen'], ctx())).toBe(1);
    expect(await run(['listen', '--forward-to', 'ftp://x'], ctx())).toBe(1);
  });

  it('explains a refused session', async () => {
    const c = {
      ...setup([sse()]).ctx(),
      fetch: (async () => new Response('no', { status: 403 })) as unknown as typeof fetch,
    };
    expect(await run(['listen', '--forward-to', 'http://localhost:4000/h'], c)).toBe(1);
    expect((c.io as ReturnType<typeof captureIO>).stderr()).toContain('webhooks:write');
  });
});
