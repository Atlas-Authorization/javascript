import type { WebhookEndpoint } from '@atlasauth/backend';
import { limit, list, str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { fmtTime, printJson, renderTable, type Column } from '../output';
import { httpFor } from '../project';
import { deliverSecret } from '../secrets';
import { requireArg, requireClient, resolveAuth, wantsJson } from './shared';

const COLUMNS: Column<WebhookEndpoint>[] = [
  { header: 'ID', get: (w) => w.id },
  { header: 'URL', get: (w) => w.url },
  { header: 'ACTIVE', get: (w) => w.active },
  { header: 'EVENTS', get: (w) => w.enabled_events },
  { header: 'CREATED', get: (w) => fmtTime(w.created_at) },
];

/** One row of `GET /v1/webhook_endpoints/:id/deliveries` (and the inline result of a synchronous test). */
export interface Delivery {
  id: string;
  delivery_id?: string;
  event_id?: string;
  event_type?: string | null;
  attempt_number?: number;
  status?: string;
  http_status?: number | null;
  latency_ms?: number | null;
  error?: string | null;
  response_snippet?: string | null;
  signature_header_sent?: string | null;
  next_retry_at?: number | null;
  delivered_at?: number | null;
  created_at?: number;
}

const DELIVERY_COLUMNS: Column<Delivery>[] = [
  { header: 'ID', get: (d) => d.id },
  { header: 'EVENT', get: (d) => d.event_type },
  { header: 'STATUS', get: (d) => d.status },
  { header: 'HTTP', get: (d) => d.http_status },
  { header: 'ATTEMPT', get: (d) => d.attempt_number },
  { header: 'ERROR', get: (d) => d.error },
  { header: 'CREATED', get: (d) => fmtTime(d.created_at) },
];

/** Delivery states that mean the attempt is over. */
const SETTLED = new Set(['delivered', 'succeeded', 'failed', 'exhausted', 'dead']);

/** `10s`, `500ms`, `2m` or a bare number of seconds → milliseconds. */
export function parseDuration(raw: string, flag: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(raw.trim());
  if (!m) throw new CliError(`${flag} must be a duration like 10s, 2m, 1h or 7d (got '${raw}').`);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[(m[2] ?? 's') as 'ms'];
  return Math.round(Number(m[1]) * unit);
}

/**
 * A `--since` / `--until` value as the ISO timestamp the API takes: an ISO date
 * or datetime passes through, `2h` / `7d` mean "that long ago", and the
 * keyword `failing_since` is left for the server to resolve.
 */
export function parseWhen(raw: string, flag: string, now = Date.now()): string {
  if (raw === 'failing_since') return raw;
  if (/^\d+(\.\d+)?(ms|s|m|h|d)$/.test(raw)) return new Date(now - parseDuration(raw, flag)).toISOString();
  const t = Date.parse(raw);
  if (Number.isNaN(t)) throw new CliError(`${flag} must be an ISO date (2026-10-01T00:00:00Z) or a relative time like 2h or 7d (got '${raw}').`);
  return new Date(t).toISOString();
}

const endpointPath = (id: string) => `/v1/webhook_endpoints/${encodeURIComponent(id)}`;

function query(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, v);
  const text = q.toString();
  return text ? `?${text}` : '';
}

/**
 * `atlas webhooks list | create | upsert | update | test | deliveries |
 * redeliver | replay | rotate | reveal`. Every signing secret (create, upsert,
 * rotate, reveal) goes to a 0600 file, never to the terminal unless
 * --print-secret.
 */
export async function webhooks(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const sub = args.positionals[1];
  const json = wantsJson(args.values);
  const v = args.values;

  const deliver = (endpointId: string, secret: string, label: string, comment: string, replace = false): string => {
    const io = json ? { out: () => undefined, err: ctx.io.err } : ctx.io;
    return (
      deliverSecret({
        io,
        env: ctx.env,
        product: str(v, 'product') ?? 'atlasauth',
        fileName: `webhook-${endpointId}.env`,
        entries: { ATLAS_WEBHOOK_SECRET: secret },
        label,
        printSecret: v['print-secret'] === true,
        force: v.force === true || replace,
        comment,
      }).path ?? ''
    );
  };
  const api = () => {
    const auth = resolveAuth(ctx, v);
    return httpFor(ctx, { secretKey: auth.secretKey, apiUrl: auth.apiUrl });
  };

  switch (sub) {
    case 'list': {
      const { client } = requireClient(ctx, v);
      const page = await client.webhooks.endpoints.list();
      if (json) printJson(ctx.io, page);
      else ctx.io.out(renderTable(COLUMNS, page.data));
      return 0;
    }

    case 'create':
    case 'upsert': {
      const url = str(v, 'url');
      if (!url) throw new CliError(`webhooks ${sub} requires --url <https-url>.`);
      const events = list(v, 'events');
      const body = { url, ...(events.length ? { enabled_events: events } : {}) };
      const http = api();
      // `upsert` is the idempotent form: one endpoint per URL, secret revealed only when it is created.
      const endpoint =
        sub === 'create'
          ? await http.post<WebhookEndpoint & { secret?: string }>('/v1/webhook_endpoints', body)
          : await http.put<WebhookEndpoint & { secret?: string }>('/v1/webhook_endpoints/by_url', body);
      const { secret, ...rest } = endpoint;
      let secretFile: string | undefined;
      if (secret) {
        secretFile = deliver(endpoint.id, secret, 'The signing secret', `Signing secret for webhook endpoint ${endpoint.id} (${url}).`);
      }
      if (json) printJson(ctx.io, v['print-secret'] === true ? endpoint : { ...rest, secret_file: secretFile ?? null });
      else if (sub === 'create' || secret) ctx.io.out(`Created webhook endpoint ${endpoint.id} → ${endpoint.url}.`);
      else ctx.io.out(`Webhook endpoint ${endpoint.id} → ${endpoint.url} already existed (updated, secret unchanged).`);
      return 0;
    }

    case 'update': {
      const id = requireArg(args.positionals, 2, 'endpoint-id');
      if (v.active === true && v.inactive === true) throw new CliError('Pass --active or --inactive, not both.');
      const body: Record<string, unknown> = {};
      const url = str(v, 'url');
      if (url) body.url = url;
      const events = list(v, 'events');
      if (events.length) body.enabled_events = events;
      if (v.active === true) body.active = true;
      if (v.inactive === true) body.active = false;
      if (Object.keys(body).length === 0) throw new CliError('webhooks update needs at least one of --url, --events, --active, --inactive.');
      const updated = await api().patch<WebhookEndpoint>(endpointPath(id), body);
      if (json) printJson(ctx.io, updated);
      else ctx.io.out(`Updated webhook endpoint ${updated.id ?? id}: ${Object.keys(body).join(', ')}.`);
      return 0;
    }

    case 'test': {
      const id = requireArg(args.positionals, 2, 'endpoint-id');
      const http = api();
      const timeoutMs = parseDuration(str(v, 'timeout') ?? '10s', '--timeout');
      const wait = v['no-wait'] !== true;
      const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
      const sent = await http.post<Delivery>(`${endpointPath(id)}/test${wait ? `?wait=${secs}s` : ''}`, {});
      let result: Delivery = sent;
      // An API that only queues the test answers `queued` with no HTTP status: poll the log for the outcome.
      if (wait && !SETTLED.has(sent.status ?? '') && sent.http_status == null) {
        const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
        const deliveryId = sent.delivery_id ?? sent.id;
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const page = await http.get<{ data: Delivery[] }>(`${endpointPath(id)}/deliveries?limit=20`);
          const row = page.data.find((d) => d.id === deliveryId);
          if (row) result = { ...sent, ...row };
          if (row && (SETTLED.has(row.status ?? '') || row.http_status != null)) break;
          if (Date.now() >= deadline) break;
          await sleep(500);
        }
      }
      if (json) printJson(ctx.io, result);
      else {
        const ok = result.http_status != null && result.http_status >= 200 && result.http_status < 300;
        ctx.io.out(`Test delivery ${result.delivery_id ?? result.id}: ${result.status ?? 'queued'}${result.http_status != null ? ` (HTTP ${result.http_status})` : ''}${result.latency_ms != null ? ` in ${result.latency_ms} ms` : ''}.`);
        if (result.error) ctx.io.out(`Error: ${result.error}`);
        if (result.response_snippet) ctx.io.out(`Response: ${result.response_snippet}`);
        if (!wait) ctx.io.out(`Queued. See the outcome with: atlas webhooks deliveries ${id}`);
        else if (result.http_status == null) ctx.io.out(`No result within ${secs}s. See it with: atlas webhooks deliveries ${id}`);
        else if (!ok) ctx.io.err('atlas: the endpoint did not answer with a 2xx.');
      }
      const ok = !wait || (result.http_status != null && result.http_status >= 200 && result.http_status < 300);
      return ok ? 0 : 1;
    }

    case 'deliveries': {
      const id = requireArg(args.positionals, 2, 'endpoint-id');
      const q = query({
        status: str(v, 'status'),
        event_type: str(v, 'event-type'),
        since: str(v, 'since') ? parseWhen(str(v, 'since')!, '--since') : undefined,
        until: str(v, 'until') ? parseWhen(str(v, 'until')!, '--until') : undefined,
        starting_after: str(v, 'starting-after'),
        limit: limit(v)?.toString(),
      });
      const page = await api().get<{ data: Delivery[]; has_more?: boolean; next_cursor?: string | null }>(`${endpointPath(id)}/deliveries${q}`);
      if (json) printJson(ctx.io, page);
      else {
        ctx.io.out(renderTable(DELIVERY_COLUMNS, page.data));
        const last = page.data[page.data.length - 1];
        if (page.has_more && (page.next_cursor ?? last?.id)) {
          ctx.io.out('');
          ctx.io.out(`More results: --starting-after ${page.next_cursor ?? last!.id}`);
        }
      }
      return 0;
    }

    case 'redeliver': {
      const id = requireArg(args.positionals, 2, 'endpoint-id');
      const http = api();
      const delivery = str(v, 'delivery');
      let res: unknown;
      if (delivery) {
        res = await http.post(`${endpointPath(id)}/deliveries/${encodeURIComponent(delivery)}/redeliver`, {});
      } else {
        const since = str(v, 'since');
        const until = str(v, 'until');
        const status = str(v, 'status') ?? 'failed';
        if (!since && !until && str(v, 'status') === undefined) {
          throw new CliError('webhooks redeliver needs --delivery <id> for one delivery, or --status / --since / --until for a batch.');
        }
        res = await http.post(`${endpointPath(id)}/redeliver`, {
          ...(since ? { since: parseWhen(since, '--since') } : {}),
          ...(until ? { until: parseWhen(until, '--until') } : {}),
          status,
        });
      }
      if (json) printJson(ctx.io, res);
      else {
        const r = res as { queued?: number; id?: string };
        const n = r.queued;
        ctx.io.out(n !== undefined ? `Queued ${n} redeliver${n === 1 ? 'y' : 'ies'} for ${id}.` : `Queued a redelivery${r.id ? ` (${r.id})` : ''} for ${id}.`);
      }
      return 0;
    }

    case 'replay': {
      const id = requireArg(args.positionals, 2, 'endpoint-id');
      const since = str(v, 'since') ?? 'failing_since';
      const res = await api().post(`${endpointPath(id)}/replay${query({ since: parseWhen(since, '--since') })}`, {});
      if (json) printJson(ctx.io, res);
      else {
        const n = (res as { queued?: number }).queued;
        ctx.io.out(n !== undefined ? `Queued ${n} held event(s) for replay on ${id}.` : `Queued a replay for ${id}.`);
      }
      return 0;
    }

    case 'rotate': {
      const id = requireArg(args.positionals, 2, 'endpoint-id');
      const overlapRaw = str(v, 'overlap');
      if (v.now === true && overlapRaw !== undefined) throw new CliError('Pass --now or --overlap, not both.');
      let overlap: number | undefined;
      if (v.now === true) overlap = 0;
      else if (overlapRaw !== undefined) {
        const n = Number(overlapRaw);
        if (!Number.isInteger(n) || n < 0) throw new CliError(`--overlap must be a whole number of seconds, got '${overlapRaw}'.`);
        overlap = n;
      }
      const res = await api().post<{ secret: string; overlap_seconds?: number; previous_secret_expires_at?: number | null; warning?: string }>(
        `${endpointPath(id)}/rotate_secret`,
        overlap === undefined ? {} : { overlap_seconds: overlap },
      );
      const file = deliver(id, res.secret, 'The new signing secret', `Rotated signing secret for webhook endpoint ${id}.`, true);
      if (json) printJson(ctx.io, v['print-secret'] === true ? res : { ...res, secret: undefined, secret_file: file || null });
      else {
        const exp = res.previous_secret_expires_at;
        if (res.overlap_seconds === 0 || exp === null) ctx.io.out('The previous secret stopped signing immediately.');
        else if (typeof exp === 'number') ctx.io.out(`The previous secret keeps signing until ${new Date(exp).toISOString()}; deploy the new one before then.`);
        if (res.warning) ctx.io.out(res.warning);
      }
      return 0;
    }

    case 'reveal': {
      const id = requireArg(args.positionals, 2, 'endpoint-id');
      const res = await api().post<{ secret: string }>(`${endpointPath(id)}/reveal_secret`, {});
      const file = deliver(id, res.secret, 'The revealed signing secret', `Signing secret for webhook endpoint ${id}.`, true);
      if (json) printJson(ctx.io, v['print-secret'] === true ? res : { object: 'webhook_secret', secret_file: file || null });
      return 0;
    }

    default:
      throw new CliError(
        sub
          ? `Unknown subcommand 'webhooks ${sub}'. Try: list, create, upsert, update, test, deliveries, redeliver, replay, rotate, reveal.`
          : 'webhooks needs a subcommand: list, create, upsert, update, test, deliveries, redeliver, replay, rotate, reveal.',
      );
  }
}
