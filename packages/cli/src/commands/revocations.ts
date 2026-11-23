import { str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { envApiUrl, resolveAuth } from './shared';
import { readSse } from './listen';
import { REVOCATIONS, resourceCommand } from './resources';

const STREAM = '/v1/revocations/stream';

/**
 * `atlas revocations list [--after <cursor>] [--kinds session,api_key] [--wait-seconds <n>]` is one long poll;
 * `atlas revocations stream [--after <cursor>] [--kinds ...] [--count <n>]` follows the live feed and prints one JSON
 * frame per line (resume with --after <the last frame's cursor>). Ctrl-C stops it.
 */
export async function revocations(ctx: RunContext, args: ParsedArgs): Promise<number> {
  if (args.positionals[1] !== 'stream') return resourceCommand('revocations', REVOCATIONS)(ctx, args);
  const maxCount = str(args.values, 'count') ? Number(str(args.values, 'count')) : undefined;
  if (maxCount !== undefined && (!Number.isInteger(maxCount) || maxCount < 1)) throw new CliError('--count must be a positive integer.');
  const q = new URLSearchParams();
  for (const k of ['after', 'since', 'kinds'] as const) {
    const v = str(args.values, k);
    if (v) q.set(k, v);
  }
  const auth = resolveAuth(ctx, args.values);
  const base = (envApiUrl(ctx.env) ?? auth.apiUrl).replace(/\/+$/, '');
  const controller = new AbortController();
  const stop = () => controller.abort();
  ctx.signal?.addEventListener('abort', stop);
  const sigs = ctx.signal ? [] : (['SIGINT', 'SIGTERM'] as const);
  for (const s of sigs) process.once(s, stop);
  try {
    const res = await (ctx.fetch ?? globalThis.fetch)(`${base}${STREAM}${q.toString() ? `?${q}` : ''}`, {
      headers: { authorization: `Bearer ${auth.secretKey}`, accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new CliError(`The revocation stream was refused (HTTP ${res.status}). It needs the events:read scope.`);
    let seen = 0;
    for await (const msg of readSse(res.body)) {
      if (!msg.data) continue;
      ctx.io.out(msg.data);
      if (maxCount !== undefined && ++seen >= maxCount) break;
    }
    return 0;
  } catch (err) {
    if (controller.signal.aborted) return 0;
    throw err;
  } finally {
    ctx.signal?.removeEventListener('abort', stop);
    for (const s of sigs) process.removeListener(s, stop);
  }
}
