import { list, str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { printJson } from '../output';
import { deliverSecret } from '../secrets';
import { resolveAuth, wantsJson } from './shared';
import { parseDuration } from './webhooks';

interface Frame {
  id: string;
  type: string;
  headers: Record<string, string>;
  body: string;
}

/** Parse a Server-Sent Events byte stream into `{event, id, data}` messages. */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; id?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let at: number;
      while ((at = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at).replace(/^\r?\n\r?\n/, '');
        let event = 'message';
        let id: string | undefined;
        const data: string[] = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          const val = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') event = val;
          else if (field === 'id') id = val;
          else if (field === 'data') data.push(val);
        }
        if (data.length || event !== 'message') yield { event, id, data: data.join('\n') };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * `atlas listen --forward-to <url> [--events user.*,session.created]`: the
 * Stripe-CLI pattern for local webhook development. Opens a signed event
 * stream from the instance, POSTs each event to your local server with the
 * normal `atlas-id` / `atlas-timestamp` / `atlas-signature` headers, and
 * prints what your server answered. The signing secret is for this session
 * only and is written to a 0600 file; point your verifier at it.
 */
export async function listen(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const v = args.values;
  const json = wantsJson(v);
  const forwardTo = str(v, 'forward-to');
  if (!forwardTo && v['no-forward'] !== true) {
    throw new CliError('listen needs --forward-to <url> (for example http://localhost:4000/webhooks/atlas), or --no-forward to only print events.');
  }
  if (forwardTo && !/^https?:\/\//i.test(forwardTo)) throw new CliError(`--forward-to must be an http(s) URL, got '${forwardTo}'.`);
  const events = list(v, 'events');
  const maxCount = str(v, 'count') ? Number(str(v, 'count')) : undefined;
  if (maxCount !== undefined && (!Number.isInteger(maxCount) || maxCount < 1)) throw new CliError('--count must be a positive integer.');
  const timeoutMs = str(v, 'timeout') ? parseDuration(str(v, 'timeout')!, '--timeout') : undefined;

  const auth = resolveAuth(ctx, v);
  const base = auth.apiUrl.replace(/\/+$/, '');
  const doFetch = ctx.fetch ?? globalThis.fetch;
  const bearer = { authorization: `Bearer ${auth.secretKey}` };

  const controller = new AbortController();
  const stop = () => controller.abort();
  ctx.signal?.addEventListener('abort', stop);
  const sigs = ctx.signal ? [] : (['SIGINT', 'SIGTERM'] as const);
  for (const s of sigs) process.once(s, stop);
  const cleanup = () => {
    ctx.signal?.removeEventListener('abort', stop);
    for (const s of sigs) process.removeListener(s, stop);
  };

  try {
    // 1. A session: id, session-only secret.
    const created = await doFetch(`${base}/v1/listen/sessions`, {
      method: 'POST',
      headers: { ...bearer, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(events.length ? { events } : {}),
      signal: controller.signal,
    });
    if (!created.ok) {
      throw new CliError(`Could not start a listen session (HTTP ${created.status}). Is this key allowed webhooks:write, and does the API support listen?`);
    }
    const session = (await created.json()) as { id: string; secret: string; events: string[]; expires_at: number };
    const secretFile = deliverSecret({
      io: json ? { out: () => undefined, err: ctx.io.err } : ctx.io,
      env: ctx.env,
      product: str(v, 'product') ?? 'atlasauth',
      fileName: 'webhook-listen.env',
      entries: { ATLAS_WEBHOOK_SECRET: session.secret },
      label: 'The listen signing secret',
      printSecret: v['print-secret'] === true,
      force: true,
      comment: 'Signing secret for `atlas listen`. Valid for this session only; verify forwarded events with it.',
    }).path;
    if (!json) {
      ctx.io.out(`Listening for ${session.events.join(', ')} until ${new Date(session.expires_at).toISOString()}${forwardTo ? `, forwarding to ${forwardTo}` : ''}. Ctrl-C to stop.`);
      if (secretFile) ctx.io.out(`Verify with the secret in ${secretFile} (ATLAS_WEBHOOK_SECRET).`);
    }

    // 2. The stream, reconnecting with Last-Event-ID until the session ends.
    const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let lastId: string | undefined;
    let seen = 0;
    let failures = 0;
    let forwardFailures = 0;
    const deadline = timeoutMs ? Date.now() + timeoutMs : undefined;
    while (!controller.signal.aborted) {
      if (deadline && Date.now() >= deadline) break;
      const params = new URLSearchParams();
      if (events.length) params.set('events', events.join(','));
      if (maxCount) params.set('max_events', String(maxCount - seen));
      if (deadline) params.set('max_wait_seconds', String(Math.max(1, Math.ceil((deadline - Date.now()) / 1000))));
      const headers: Record<string, string> = { ...bearer, accept: 'text/event-stream' };
      if (lastId) headers['last-event-id'] = lastId;
      let res: Response;
      try {
        res = await doFetch(`${base}/v1/listen/sessions/${session.id}/stream?${params}`, {
          headers,
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) break;
        if (++failures > 5) throw new CliError(`Lost the event stream: ${err instanceof Error ? err.message : String(err)}`);
        await sleep(1000 * failures);
        continue;
      }
      if (!res.ok || !res.body) {
        throw new CliError(`The event stream was refused (HTTP ${res.status}). ${res.status === 422 ? 'The session expired: run atlas listen again.' : ''}`.trim());
      }
      failures = 0;
      let expired = false;
      try {
        for await (const msg of readSse(res.body)) {
          if (msg.event === 'expired') {
            expired = true;
            break;
          }
          if (msg.event !== 'webhook') continue;
          if (msg.id) lastId = msg.id;
          const frame = JSON.parse(msg.data) as Frame;
          seen++;
          const t0 = Date.now();
          let status: number | null = null;
          let error: string | null = null;
          if (forwardTo) {
            try {
              const out = await doFetch(forwardTo, { method: 'POST', headers: frame.headers, body: frame.body, redirect: 'manual', signal: controller.signal });
              status = out.status;
              await out.arrayBuffer().catch(() => undefined);
            } catch (err) {
              error = err instanceof Error ? err.message : String(err);
            }
          }
          const ms = Date.now() - t0;
          const ok = status !== null && status >= 200 && status < 300;
          if (forwardTo && !ok) forwardFailures++;
          if (json) printJson(ctx.io, { id: frame.id, type: frame.type, forwarded: Boolean(forwardTo), http_status: status, error, latency_ms: ms });
          else ctx.io.out(`${new Date().toISOString()}  ${frame.type}  ${frame.id}${forwardTo ? `  → ${status ?? 'failed'}${error ? ` (${error})` : ''} ${ms}ms` : ''}`);
          if (maxCount && seen >= maxCount) {
            controller.abort();
            break;
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          if (++failures > 5) throw new CliError(`Lost the event stream: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (expired) {
        if (!json) ctx.io.out('The listen session expired. Run atlas listen again for a new one.');
        break;
      }
      if (controller.signal.aborted || (maxCount && seen >= maxCount)) break;
      if (deadline && Date.now() >= deadline) break;
      await sleep(1000);
    }
    return forwardTo && forwardFailures > 0 && maxCount !== undefined ? 1 : 0;
  } catch (err) {
    if (controller.signal.aborted && !(err instanceof CliError)) return 0;
    throw err;
  } finally {
    cleanup();
  }
}
