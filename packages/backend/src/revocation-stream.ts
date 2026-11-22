import { DEFAULT_API_URL } from './client/request';

/**
 * The revocation stream: everything that ends a session, a token family, an API key, a machine or a machine grant, or
 * a person's access, in one ordered feed you can resume by cursor. This file is the consumer: it connects (Server-Sent
 * Events, or long poll), hands each event to your handler, remembers the cursor, and reconnects with backoff.
 *
 * Delivery is at-least-once and in order: the cursor moves only after your handler returned, so a crash replays the
 * last event. Handlers must be idempotent (everything `createRevocationMirror` does is).
 */

export type RevocationKind = 'session' | 'user_sessions' | 'token_family' | 'grant' | 'api_key' | 'machine' | 'machine_grant' | 'user';

export interface RevocationFrame {
  object: 'revocation';
  /** The event id. */
  id: string;
  /** Commit-ordered position in the stream: the resume cursor. */
  seq: number;
  /** The event type (`session.revoked`, `api_key.revoked`, `machine.revoked`, ...). */
  type: string;
  kind: RevocationKind;
  /** When it happened (epoch ms). */
  at: number;
  /** The user the ended thing belonged to, when it has one. */
  user_id: string | null;
  /** Ids of what ended; only those the kind has (`session_id`, `api_key_id`, `machine_id`, `machine_grant_id`, `family_id`, `grant_id`, ...). */
  ids: Record<string, string | null>;
  reason: string | null;
  /** Who ended it. */
  actor: { type: string; id: string | null };
  /** `user_sessions`: how many sessions ended, and the one kept when the user signed out of the others only. */
  sessions_revoked?: number;
  kept_session_id?: string | null;
  /** When it ended (epoch ms); for `user_sessions` the cutoff every token issued before it falls under. */
  revoked_at: number | null;
}

/** Where the stream remembers how far it got. Back it with a table or a file to survive restarts. */
export interface RevocationCursorStore {
  get(): Promise<string | null> | string | null;
  set(cursor: string): Promise<void> | void;
}

export function memoryCursorStore(initial: string | null = null): RevocationCursorStore {
  let cursor = initial;
  return { get: () => cursor, set: (c) => void (cursor = c) };
}

export interface RevocationStreamOptions {
  /** A secret key with `events:read`. */
  secretKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Called once per event, in order. Throwing keeps the cursor where it was and retries after the backoff. */
  onEvent: (frame: RevocationFrame) => void | Promise<void>;
  /** Default: an in-memory cursor, so a restart resumes from "now". Pass a durable store to resume from where you stopped. */
  cursorStore?: RevocationCursorStore;
  /** Only these kinds. Default: all. */
  kinds?: RevocationKind[];
  /** `sse` (default) keeps one connection open; `poll` long-polls (use where a proxy buffers streams). */
  transport?: 'sse' | 'poll';
  /** Long-poll wait in seconds (1 to 30). Default 25. */
  waitSeconds?: number;
  /**
   * Called after every connection that follows an outage (and on the first one when a stored cursor exists),
   * before events are delivered. Run your reconcile here: `keyMirror.sync()`, `machineDenyList.sync()`. A key revoked
   * while you were disconnected arrives through the cursor anyway; this is the backstop for events older than the log's
   * retention or passed over by a gap.
   */
  onReconnect?: () => void | Promise<void>;
  onConnected?: (info: { cursor: string | null }) => void;
  onDisconnected?: (error: unknown) => void;
  backoff?: { minMs?: number; maxMs?: number };
  /** Treat a connection as dead after this long without any bytes (the server sends a heartbeat every 15 s). Default 45000. */
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  /** For tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RevocationStreamHandle {
  /** Stop after the event in flight. */
  stop(): void;
  /** Resolves once the stream has stopped. */
  done: Promise<void>;
}

/** Parse Server-Sent Events text into `{ id, event, data }` blocks; keeps a trailing partial block in `rest`. */
export function parseSseBlocks(buffer: string): { blocks: Array<{ id?: string; event: string; data: string }>; rest: string } {
  const blocks: Array<{ id?: string; event: string; data: string }> = [];
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? '';
  for (const part of parts) {
    let id: string | undefined;
    let event = 'message';
    const data: string[] = [];
    for (const line of part.split(/\r?\n/)) {
      if (line.startsWith(':') || line === '') continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'id') id = value;
      else if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length > 0 || event !== 'message') blocks.push({ ...(id !== undefined ? { id } : {}), event, data: data.join('\n') });
  }
  return { blocks, rest };
}

export function revocationStream(options: RevocationStreamOptions): RevocationStreamHandle {
  const store = options.cursorStore ?? memoryCursorStore();
  const doFetch = options.fetchImpl ?? fetch;
  const base = (options.baseUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
  const minMs = options.backoff?.minMs ?? 500;
  const maxMs = options.backoff?.maxMs ?? 30_000;
  const idleMs = options.idleTimeoutMs ?? 45_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const stopper = new AbortController();
  options.signal?.addEventListener('abort', () => stopper.abort());
  const kinds = options.kinds && options.kinds.length > 0 ? `&kinds=${encodeURIComponent(options.kinds.join(','))}` : '';
  const headers = { authorization: `Bearer ${options.secretKey}` };

  /** One connection (GET /v1/revocations long-poll or GET /v1/revocations/stream SSE): delivers events until it ends. Returns normally when the server closed it cleanly. */
  const connectOnce = async (afterConnect: () => Promise<void>): Promise<void> => {
    const cursor = await store.get();
    const url = options.transport === 'poll'
      ? `${base}/v1/revocations?wait=${Math.min(30, Math.max(1, options.waitSeconds ?? 25))}${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}${kinds}`
      : `${base}/v1/revocations/stream?${cursor ? `after=${encodeURIComponent(cursor)}` : ''}${kinds}`;
    const attempt = new AbortController();
    const abort = () => attempt.abort();
    stopper.signal.addEventListener('abort', abort);
    let idle: ReturnType<typeof setTimeout> | undefined;
    const armIdle = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(abort, options.transport === 'poll' ? (Math.max(1, options.waitSeconds ?? 25) + 15) * 1000 : idleMs);
    };
    try {
      armIdle();
      const res = await doFetch(url, { headers: { ...headers, accept: options.transport === 'poll' ? 'application/json' : 'text/event-stream' }, signal: attempt.signal });
      if (!res.ok) throw Object.assign(new Error(`revocation stream answered ${res.status}`), { status: res.status });
      await afterConnect();
      options.onConnected?.({ cursor });
      if (options.transport === 'poll') {
        const page = (await res.json()) as { data: RevocationFrame[]; next_cursor: string | null };
        // No cursor yet: the answer is "from now"; remember where now is and poll from there.
        if (!cursor && page.data.length === 0 && page.next_cursor !== null) await store.set(page.next_cursor);
        for (const frame of page.data) {
          await options.onEvent(frame);
          await store.set(String(frame.seq));
        }
        return;
      }
      if (!res.body) throw new Error('revocation stream: the response has no body');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        armIdle();
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseBlocks(buffer);
        buffer = parsed.rest;
        for (const block of parsed.blocks) {
          if (block.event === 'revocation') {
            const frame = JSON.parse(block.data) as RevocationFrame;
            await options.onEvent(frame);
            await store.set(String(frame.seq));
          } else if (block.event === 'ready') {
            const ready = JSON.parse(block.data) as { cursor?: string };
            if (!(await store.get()) && ready.cursor) await store.set(ready.cursor);
          } else if (block.event === 'reconnect') {
            return;
          }
        }
      }
    } finally {
      if (idle) clearTimeout(idle);
      stopper.signal.removeEventListener('abort', abort);
      attempt.abort();
    }
  };

  const done = (async () => {
    let delay = minMs;
    let first = true;
    let healthy = false;
    while (!stopper.signal.aborted) {
      try {
        const hadCursor = (await store.get()) !== null;
        await connectOnce(async () => {
          if ((!first || hadCursor) && options.onReconnect) await options.onReconnect();
        });
        first = false;
        healthy = true;
        delay = minMs;
        // A clean end (the server rotated the connection, or a long poll answered): reconnect straight away.
        if (options.transport === 'poll') continue;
      } catch (error) {
        if (stopper.signal.aborted) break;
        first = false;
        healthy = false;
        options.onDisconnected?.(error);
        const status = (error as { status?: number }).status;
        // A refused credential will not heal by retrying quickly.
        await sleep(status === 401 || status === 403 ? maxMs : delay);
        delay = Math.min(maxMs, delay * 2);
      }
      if (healthy && options.transport !== 'poll') await sleep(minMs);
    }
  })();

  return { stop: () => stopper.abort(), done };
}
