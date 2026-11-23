import { DEFAULT_API_URL } from './client/request';
import { parseSseBlocks } from './revocation-stream';

/** One event a listen session forwards: the exact headers and JSON body a webhook delivery would carry, signed with the session secret. */
export interface ListenEvent {
  id: string;
  type: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface ListenEventsOptions {
  /** A secret key that can read the instance's events. */
  secretKey: string;
  /** The session id from `atlas.listen.createSession()`. */
  sessionId: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Only these event types or patterns (`user.*`). Default: the session's own filter. */
  events?: string[];
  /** Resume after this event id instead of starting at "now". */
  after?: string;
  /** End the stream after this many events, or after this many seconds (scripts, CI). */
  maxEvents?: number;
  maxWaitSeconds?: number;
  signal?: AbortSignal;
}

/**
 * Read a listen session's Server-Sent Events stream (GET /v1/listen/sessions/{id}/stream) as an async iterator. It ends
 * when the session expires, when `maxEvents` / `maxWaitSeconds` is reached, or when `signal` aborts. Verify each event
 * with the session secret exactly as a webhook delivery (`atlas-signature` over the body).
 *
 * ```ts
 * const session = await atlas.listen.createSession({ events: ['user.*'] });
 * for await (const event of listenEvents({ secretKey, sessionId: session.id! })) console.log(event.type);
 * ```
 */
export async function* listenEvents(options: ListenEventsOptions): AsyncGenerator<ListenEvent, void, undefined> {
  const base = (options.baseUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
  const query = new URLSearchParams();
  if (options.events?.length) query.set('events', options.events.join(','));
  if (options.after) query.set('after', options.after);
  if (options.maxEvents !== undefined) query.set('max_events', String(options.maxEvents));
  if (options.maxWaitSeconds !== undefined) query.set('max_wait_seconds', String(options.maxWaitSeconds));
  const qs = query.toString();
  const res = await (options.fetchImpl ?? fetch)(`${base}/v1/listen/sessions/${encodeURIComponent(options.sessionId)}/stream${qs ? `?${qs}` : ''}`, {
    headers: { authorization: `Bearer ${options.secretKey}`, accept: 'text/event-stream' },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!res.ok) throw Object.assign(new Error(`listen stream answered ${res.status}`), { status: res.status });
  if (!res.body) throw new Error('listen stream: the response has no body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseBlocks(buffer);
      buffer = parsed.rest;
      for (const block of parsed.blocks) {
        if (block.event === 'webhook') yield JSON.parse(block.data) as ListenEvent;
        else if (block.event === 'expired') return;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
