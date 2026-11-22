import { describe, expect, it } from 'vitest';
import { createRevocationMirror, createSessionDenyList } from './revocation-mirror';
import { memoryCursorStore, parseSseBlocks, revocationStream, type RevocationFrame } from './revocation-stream';

const frame = (over: Partial<RevocationFrame>): RevocationFrame => ({
  object: 'revocation',
  id: 'evt_1',
  seq: 1,
  type: 'session.revoked',
  kind: 'session',
  at: 1_000,
  user_id: 'user_1',
  ids: {},
  reason: 'signed_out',
  actor: { type: 'user', id: 'user_1' },
  revoked_at: 1_000,
  ...over,
});

const sse = (frames: RevocationFrame[], extra = '') =>
  new Response(`retry: 2000\n\nevent: ready\ndata: {"cursor":"0"}\n\n${frames.map((f) => `id: ${f.seq}\nevent: revocation\ndata: ${JSON.stringify(f)}\n\n`).join('')}${extra}`, {
    headers: { 'content-type': 'text/event-stream' },
  });

describe('parseSseBlocks', () => {
  it('splits blocks, ignores comments, keeps a partial tail', () => {
    const { blocks, rest } = parseSseBlocks(': keep-alive\n\nid: 1\nevent: revocation\ndata: {"a":1}\n\nid: 2\nevent: rev');
    expect(blocks).toEqual([{ id: '1', event: 'revocation', data: '{"a":1}' }]);
    expect(rest).toBe('id: 2\nevent: rev');
  });
});

describe('revocationStream', () => {
  it('delivers in order, moves the cursor after each handler, and resumes by it after the server closes', async () => {
    const urls: string[] = [];
    const seen: string[] = [];
    const store = memoryCursorStore();
    let handle: ReturnType<typeof revocationStream>;
    const responses = [sse([frame({ id: 'evt_1', seq: 1 }), frame({ id: 'evt_2', seq: 2 })]), sse([frame({ id: 'evt_3', seq: 3 })])];
    handle = revocationStream({
      secretKey: 'sk_test_x',
      baseUrl: 'https://api.example.com',
      cursorStore: store,
      sleep: async () => undefined,
      fetchImpl: (async (url: string) => {
        urls.push(String(url));
        const next = responses.shift();
        if (!next) {
          handle.stop();
          throw new Error('stopped');
        }
        return next;
      }) as unknown as typeof fetch,
      onEvent: (f) => void seen.push(f.id),
    });
    await handle.done;
    expect(seen).toEqual(['evt_1', 'evt_2', 'evt_3']);
    expect(await store.get()).toBe('3');
    expect(urls[0]).not.toContain('after=');
    expect(urls[1]).toContain('after=2');
  });

  it('a handler that throws keeps the cursor and the event is redelivered', async () => {
    const store = memoryCursorStore('0');
    let attempts = 0;
    const seen: string[] = [];
    let handle: ReturnType<typeof revocationStream>;
    handle = revocationStream({
      secretKey: 'sk_test_x',
      baseUrl: 'https://api.example.com',
      cursorStore: store,
      sleep: async () => undefined,
      fetchImpl: (async () => sse([frame({ id: 'evt_1', seq: 1 })])) as unknown as typeof fetch,
      onEvent: (f) => {
        attempts++;
        if (attempts === 1) throw new Error('db down');
        seen.push(f.id);
        handle.stop();
      },
    });
    await handle.done;
    expect(attempts).toBe(2);
    expect(seen).toEqual(['evt_1']);
    expect(await store.get()).toBe('1');
  });

  it('runs onReconnect before events when a cursor exists', async () => {
    const order: string[] = [];
    let handle: ReturnType<typeof revocationStream>;
    handle = revocationStream({
      secretKey: 'sk_test_x',
      baseUrl: 'https://api.example.com',
      cursorStore: memoryCursorStore('0'),
      sleep: async () => undefined,
      fetchImpl: (async () => sse([frame({ id: 'evt_1', seq: 1 })])) as unknown as typeof fetch,
      onReconnect: () => void order.push('reconnect'),
      onEvent: () => {
        order.push('event');
        handle.stop();
      },
    });
    await handle.done;
    expect(order).toEqual(['reconnect', 'event']);
  });

  it('long poll starts from the server cursor when there is none, then reads from it', async () => {
    const urls: string[] = [];
    const seen: string[] = [];
    const store = memoryCursorStore();
    let handle: ReturnType<typeof revocationStream>;
    const answers = [{ data: [], next_cursor: '7' }, { data: [frame({ id: 'evt_9', seq: 9 })], next_cursor: '9' }];
    handle = revocationStream({
      secretKey: 'sk_test_x',
      baseUrl: 'https://api.example.com',
      transport: 'poll',
      cursorStore: store,
      sleep: async () => undefined,
      fetchImpl: (async (url: string) => {
        urls.push(String(url));
        return new Response(JSON.stringify(answers.shift()), { headers: { 'content-type': 'application/json' } });
      }) as unknown as typeof fetch,
      onEvent: (f) => {
        seen.push(f.id);
        handle.stop();
      },
    });
    await handle.done;
    expect(urls[0]).not.toContain('after=');
    expect(urls[1]).toContain('after=7');
    expect(seen).toEqual(['evt_9']);
  });
});

describe('createRevocationMirror', () => {
  it('revokes API keys in the key mirror and feeds the machine and session deny lists', async () => {
    const applied: unknown[] = [];
    const mirror = createRevocationMirror({
      secretKey: 'sk_test_x',
      keyMirror: { applyWebhook: async (e) => (applied.push(e), true), sync: async () => undefined },
    });
    await mirror.apply(frame({ kind: 'api_key', type: 'api_key.revoked', ids: { api_key_id: 'k1' }, reason: 'revoked_by_api', revoked_at: 5 }));
    expect(applied).toEqual([{ type: 'api_key.revoked', data: { id: 'k1', revoked_at: 5, revoked_reason: 'revoked_by_api' } }]);

    await mirror.apply(frame({ kind: 'machine', type: 'machine.revoked', ids: { machine_id: 'mach_1' }, revoked_at: 10_000 }));
    await mirror.apply(frame({ kind: 'machine_grant', type: 'machine_grant.revoked', ids: { machine_grant_id: 'mg', machine_id: 'mach_2', audience: 'https://api.example.com' }, revoked_at: 10_000 }));
    expect(mirror.machines.size()).toBe(2);

    await mirror.apply(frame({ kind: 'session', ids: { session_id: 'sess_1' }, revoked_at: Date.now() }));
    expect(mirror.sessions.isSessionRevoked({ sid: 'sess_1' })).toBe(true);
    expect(mirror.sessions.isSessionRevoked({ sid: 'sess_2' })).toBe(false);
  });
});

describe('createSessionDenyList', () => {
  it('a user_sessions cutoff kills tokens issued before it, spares the kept session and later tokens', () => {
    const at = 1_700_000_000_000;
    const list = createSessionDenyList({ now: () => at + 1000 });
    list.apply(frame({ kind: 'user_sessions', type: 'user.sessions_revoked', user_id: 'u1', kept_session_id: 'sess_keep', revoked_at: at }));
    expect(list.isSessionRevoked({ sid: 'sess_a', sub: 'u1', iat: at / 1000 - 10 })).toBe(true);
    expect(list.isSessionRevoked({ sid: 'sess_keep', sub: 'u1', iat: at / 1000 - 10 })).toBe(false);
    expect(list.isSessionRevoked({ sid: 'sess_b', sub: 'u1', iat: at / 1000 + 10 })).toBe(false);
    expect(list.isSessionRevoked({ sid: 'sess_c', sub: 'u2', iat: at / 1000 - 10 })).toBe(false);
  });

  it('a ban (user kind) ends every token of the user, whatever its issue time', () => {
    const at = 1_700_000_000_000;
    const list = createSessionDenyList({ now: () => at + 1000 });
    list.apply(frame({ kind: 'user', type: 'user.banned', user_id: 'u1', revoked_at: at }));
    expect(list.isSessionRevoked({ sid: 's', sub: 'u1', iat: at / 1000 - 10 })).toBe(true);
  });
});
