import { list, str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { envApiUrl, resolveAuth, wantsJson } from './shared';
import { readSse } from './listen';
import { parseDuration } from './webhooks';

const SOURCES = ['traces', 'audit', 'events'] as const;
type Source = (typeof SOURCES)[number];

interface Line {
  at: number;
  source: Source;
  id: string;
  summary: string;
  raw: unknown;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * `atlas logs tail [--source traces,audit,events] [--user-id <id>] [--code <code>] [--count <n>] [--timeout <dur>] [--interval <dur>] [--json]`
 *
 * A live log of what the instance is doing, built from three surfaces that already exist:
 * `traces` are the requests Atlas refused and why (the diagnostics traces), `audit` is the
 * audit log (what was changed and by whom), `events` is the live event stream (a listen session).
 * Traces and audit entries are polled every --interval (default 2s) and printed oldest first;
 * nothing before the command started is shown. Ctrl-C stops it.
 */
export async function logs(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const v = args.values;
  if (args.positionals[1] !== 'tail') throw new CliError("Usage: atlas logs tail [--source traces,audit,events] (see 'atlas logs --help').");
  const json = wantsJson(v);
  const sources = (list(v, 'source').length ? list(v, 'source') : ['traces', 'audit']) as Source[];
  for (const s of sources) if (!SOURCES.includes(s)) throw new CliError(`--source takes ${SOURCES.join(', ')} (got '${s}').`);
  const maxCount = str(v, 'count') ? Number(str(v, 'count')) : undefined;
  if (maxCount !== undefined && (!Number.isInteger(maxCount) || maxCount < 1)) throw new CliError('--count must be a positive integer.');
  const timeoutMs = str(v, 'timeout') ? parseDuration(str(v, 'timeout')!, '--timeout') : undefined;
  const intervalMs = Math.max(500, str(v, 'interval') ? parseDuration(str(v, 'interval')!, '--interval') : 2000);

  const auth = resolveAuth(ctx, v);
  const base = (envApiUrl(ctx.env) ?? auth.apiUrl).replace(/\/+$/, '');
  const doFetch = ctx.fetch ?? globalThis.fetch;
  const bearer = { authorization: `Bearer ${auth.secretKey}`, accept: 'application/json' };
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const controller = new AbortController();
  const stop = () => controller.abort();
  ctx.signal?.addEventListener('abort', stop);
  const sigs = ctx.signal ? [] : (['SIGINT', 'SIGTERM'] as const);
  for (const s of sigs) process.once(s, stop);
  const deadline = timeoutMs ? Date.now() + timeoutMs : undefined;
  let printed = 0;
  const done = () => controller.signal.aborted || (maxCount !== undefined && printed >= maxCount) || (deadline !== undefined && Date.now() >= deadline);

  const emit = (lines: Line[]) => {
    for (const l of lines.sort((a, b) => a.at - b.at)) {
      if (done()) return;
      if (json) ctx.io.out(JSON.stringify({ source: l.source, id: l.id, at: l.at, ...(l.raw as object) })); // one object per line (NDJSON) so a pipe can read it as it streams
      else ctx.io.out(`${iso(l.at)}  ${l.source.padEnd(6)}  ${l.summary}`);
      printed += 1;
    }
    if (maxCount !== undefined && printed >= maxCount) controller.abort();
  };

  const get = async <T>(path: string): Promise<T> => {
    const res = await doFetch(`${base}${path}`, { headers: bearer, signal: controller.signal });
    if (!res.ok) throw new CliError(`${path.split('?')[0]} answered HTTP ${res.status}. Does this key have the scope it needs (diagnostics:read for traces, audit:read for audit, webhooks:write for events)?`);
    return (await res.json()) as T;
  };

  const seen = new Set<string>();
  const remember = (id: string): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > 5000) for (const k of [...seen].slice(0, 2500)) seen.delete(k);
    return true;
  };
  const startedAt = Date.now();

  const pollTraces = async (): Promise<Line[]> => {
    const q = new URLSearchParams({ since: String(startedAt) });
    for (const k of ['user-id', 'code'] as const) if (str(v, k)) q.set(k.replace('-', '_'), str(v, k)!);
    const res = await get<{ data: Array<{ id: string; method: string; path: string; status: number; code: string; reason: string | null; decided_by: string | null; created_at: number }> }>(`/v1/diagnostics/traces?${q}`);
    return res.data.filter((t) => remember(`t:${t.id}`)).map((t): Line => ({ at: t.created_at, source: 'traces', id: t.id, summary: `${t.status} ${t.method} ${t.path}  ${t.code}${t.decided_by ? `  (${t.decided_by})` : ''}`, raw: t }));
  };
  const pollAudit = async (): Promise<Line[]> => {
    const res = await get<{ data: Array<{ id: string; action: string; actor_type: string; actor_id: string | null; target_type: string | null; target_id: string | null; created_at: number }> }>('/v1/audit_logs?limit=50');
    return res.data
        .filter((a) => a.created_at >= startedAt && remember(`a:${a.id}`))
        .map((a): Line => ({ at: a.created_at, source: 'audit', id: a.id, summary: `${a.action}  ${a.actor_type}${a.actor_id ? `:${a.actor_id}` : ''}${a.target_id ? ` -> ${a.target_type ?? ''}:${a.target_id}` : ''}`, raw: a }));
  };
  const streamEvents = async () => {
    const created = await doFetch(`${base}/v1/listen/sessions`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: '{}', signal: controller.signal });
    if (!created.ok) throw new CliError(`Could not start an event session (HTTP ${created.status}); events need webhooks:write.`);
    const session = (await created.json()) as { id: string };
    while (!done()) {
      const res = await doFetch(`${base}/v1/listen/sessions/${session.id}/stream`, { headers: { ...bearer, accept: 'text/event-stream' }, signal: controller.signal });
      if (!res.ok || !res.body) throw new CliError(`The event stream was refused (HTTP ${res.status}).`);
      for await (const msg of readSse(res.body)) {
        if (msg.event === 'expired') return;
        if (msg.event !== 'webhook') continue;
        const frame = JSON.parse(msg.data) as { id: string; type: string; body: string };
        emit([{ at: Date.now(), source: 'events', id: frame.id, summary: `${frame.type}  ${frame.id}`, raw: { type: frame.type } }]);
        if (done()) return;
      }
      await sleep(1000);
    }
  };

  try {
    if (!json) ctx.io.out(`Tailing ${sources.join(', ')}. Ctrl-C to stop.`);
    const tasks: Array<Promise<void>> = [];
    if (sources.includes('events')) tasks.push(streamEvents().catch((e) => { if (!controller.signal.aborted) throw e; }));
    if (sources.includes('traces') || sources.includes('audit')) {
      tasks.push(
        (async () => {
          while (!done()) {
            // One batch per round, so lines from both sources come out in time order.
            emit([...(sources.includes('traces') ? await pollTraces() : []), ...(sources.includes('audit') ? await pollAudit() : [])]);
            if (!done()) await sleep(intervalMs);
          }
        })().catch((e) => { if (!controller.signal.aborted) throw e; }),
      );
    }
    await Promise.all(tasks);
    return 0;
  } finally {
    ctx.signal?.removeEventListener('abort', stop);
    for (const s of sigs) process.removeListener(s, stop);
  }
}
