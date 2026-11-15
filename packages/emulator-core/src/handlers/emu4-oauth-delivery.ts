/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteDef } from '../engine';
import { EmulatorError } from '../errors';
import type { Obj } from '../openapi';
import { paginate, randomToken } from '../store';
import { recordAudit } from './emu4-oauth-audit';
import { subjectFor } from './emu4-oauth-auth';
import { cibaRecords } from './oauth-flows';
import { engineState } from './support';

/**
 * Queued, retried delivery of back-channel logout tokens and CIBA ping/push notifications, on the engine clock.
 *
 * The first attempt is made at once (the request that caused the delivery waits for it); a failure is retried on the
 * real schedule (5 s, 5 min, 30 min, 2 h, 5 h, 10 h: six attempts in all) when the clock reaches it. Time moves with
 * `POST /__emulator/time/advance` (which runs everything that came due) or `POST /__emulator/oauth/deliveries/run`;
 * every attempt is kept so a test can read what the receiver saw. An OIDC relying party that answers and refuses
 * (4xx other than 408 and 429) is not retried (back-channel logout section 2.5), nor is a test send.
 */
export const RETRY_SCHEDULE_MS = [5_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 5 * 3_600_000, 10 * 3_600_000];
export const MAX_ATTEMPTS = RETRY_SCHEDULE_MS.length;
const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
const SNIPPET_CHARS = 512;

interface Attempt {
  attempt: number;
  at: number;
  http_status: number | null;
  error: string | null;
  success: boolean;
  location: string | null;
}
interface Delivery {
  id: string;
  kind: 'backchannel_logout' | 'ciba_ping' | 'ciba_push';
  client_id: string;
  endpoint: string;
  /** Logout: the user and session the token names. */
  user_id: string | null;
  sid: string | null;
  /** CIBA: the request, the bearer token and the JSON body. */
  request_id: string | null;
  bearer: string | null;
  payload: Obj | null;
  is_test: boolean;
  status: 'pending' | 'success' | 'failed';
  attempt_number: number;
  http_status: number | null;
  latency_ms: number | null;
  error: string | null;
  location: string | null;
  response_snippet: string | null;
  next_retry_at: number | null;
  attempted_at: number | null;
  delivered_at: number | null;
  created_at: number;
  attempts: Attempt[];
}
const queue = engineState((): Delivery[] => []);
const ids = engineState(() => ({ n: 0 }));

const isSuccess = (s: number): boolean => s >= 200 && s < 300;
const recoverable = (s: number): boolean => s >= 500 || s === 408 || s === 429;

async function body(e: Engine, d: Delivery): Promise<{ headers: Record<string, string>; text: string }> {
  if (d.kind === 'backchannel_logout') {
    const client = e.db.oauthClients.get(d.client_id);
    // The token is minted again for every attempt (a fresh jti), like the real dispatcher.
    const sub = d.is_test || !d.user_id ? (d.user_id ?? `sub_test_${randomToken(9)}`) : await subjectFor(e, client, d.user_id);
    const token = await e.tokens.signClaims({ aud: d.client_id, jti: e.db.newId('ologout'), events: { [LOGOUT_EVENT]: {} }, sub, sid: d.sid ?? undefined, ...(d.is_test ? { atlas_test: true } : {}) }, 120);
    return { headers: { 'content-type': 'application/x-www-form-urlencoded' }, text: `logout_token=${encodeURIComponent(token)}` };
  }
  return { headers: { 'content-type': 'application/json', authorization: `Bearer ${d.bearer}` }, text: JSON.stringify(d.payload) };
}

/** One HTTP attempt; records it and schedules the next on the real schedule. */
async function attempt(e: Engine, d: Delivery): Promise<void> {
  const started = e.clock.now();
  const { headers, text } = await body(e, d);
  let status: number | null = null;
  let snippet: string | null = null;
  let location: string | null = null;
  let error: string | null = null;
  try {
    const res = await (e.options.fetch ?? fetch)(d.endpoint, { method: 'POST', headers, body: text, redirect: 'manual' });
    status = res.status;
    snippet = ((await res.text().catch(() => '')) || '').slice(0, SNIPPET_CHARS) || null;
    if (status >= 300 && status < 400) location = res.headers.get('location');
    if (!isSuccess(status)) error = d.kind === 'backchannel_logout' ? (location !== null || (status >= 300 && status < 400) ? 'backchannel_redirect_not_followed' : 'backchannel_http_error') : `http_${status}`;
  } catch (err) {
    error = d.kind === 'backchannel_logout' ? ((err as Error)?.name === 'TimeoutError' || (err as Error)?.name === 'AbortError' ? 'backchannel_timeout' : 'backchannel_network_error') : (err instanceof Error ? err.message : String(err));
  }
  const now = e.clock.now();
  const n = d.attempt_number + 1;
  const ok = status !== null && isSuccess(status);
  d.attempt_number = n;
  d.attempted_at = now;
  d.http_status = status;
  d.latency_ms = Math.max(0, now - started);
  d.error = error;
  d.location = location;
  d.response_snippet = snippet;
  d.attempts.push({ attempt: n, at: now, http_status: status, error, success: ok, location });
  if (ok) {
    d.status = 'success';
    d.delivered_at = now;
    d.next_retry_at = null;
    return;
  }
  d.status = 'failed';
  // An OIDC relying party that answered and refused is final (section 2.5); a test is never retried.
  const refused = d.kind === 'backchannel_logout' && status !== null && !recoverable(status);
  d.next_retry_at = refused || d.is_test || n >= MAX_ATTEMPTS ? null : now + RETRY_SCHEDULE_MS[n - 1]!;
}

function enqueue(e: Engine, row: Partial<Delivery> & Pick<Delivery, 'kind' | 'client_id' | 'endpoint'>): Delivery {
  const d: Delivery = { id: `bld_${String(++ids(e).n).padStart(6, '0')}_${randomToken(6)}`, user_id: null, sid: null, request_id: null, bearer: null, payload: null, is_test: false, status: 'pending', attempt_number: 0, http_status: null, latency_ms: null, error: null, location: null, response_snippet: null, next_retry_at: null, attempted_at: null, delivered_at: null, created_at: e.clock.now(), attempts: [], ...row };
  queue(e).push(d);
  return d;
}

/** Queue a back-channel logout for a client's session and make the first attempt. */
export async function enqueueBackchannelLogout(e: Engine, client: Obj, input: { userId: string; sid: string }): Promise<Delivery> {
  const d = enqueue(e, { kind: 'backchannel_logout', client_id: client.id, endpoint: client.backchannel_logout_uri, user_id: input.userId, sid: input.sid });
  await attempt(e, d);
  return d;
}

/** Queue a CIBA ping (only the `auth_req_id`) or push (the token response or the refusal) and make the first attempt. */
export async function enqueueCiba(e: Engine, input: { kind: 'ciba_ping' | 'ciba_push'; clientId: string; requestId: string; endpoint: string; token: string; payload: Obj }): Promise<Delivery> {
  const d = enqueue(e, { kind: input.kind, client_id: input.clientId, endpoint: input.endpoint, request_id: input.requestId, bearer: input.token, payload: input.payload });
  await attempt(e, d);
  return d;
}

/**
 * Everything the clock made due: push requests that expired undecided are announced (`expired_token`), then every
 * delivery whose retry time has come is attempted, oldest first. Returns how many attempts ran.
 */
export async function runDueDeliveries(e: Engine): Promise<number> {
  const now = e.clock.now();
  for (const rec of cibaRecords(e).values()) {
    if (rec.mode !== 'push' || rec.status !== 'pending' || rec.expiresAt > now || rec.expiredNotified) continue;
    const client = e.db.oauthClients.get(rec.clientId);
    rec.expiredNotified = true;
    if (!client || client.deleted || !client.backchannel_client_notification_endpoint || !rec.notificationToken) continue;
    await enqueueCiba(e, { kind: 'ciba_push', clientId: client.id, requestId: rec.id, endpoint: client.backchannel_client_notification_endpoint, token: rec.notificationToken, payload: { auth_req_id: rec.id, error: 'expired_token', error_description: 'The authentication request expired.' } });
  }
  let ran = 0;
  for (const d of queue(e)) {
    if (d.status !== 'failed' || d.next_retry_at === null || d.next_retry_at > e.clock.now()) continue;
    // The target may be gone since the delivery was queued: nothing to deliver to, so it leaves the queue.
    const client = e.db.oauthClients.get(d.client_id);
    if (!client || client.deleted || (d.kind === 'backchannel_logout' && !client.backchannel_logout_uri)) {
      d.next_retry_at = null;
      d.error = d.kind === 'backchannel_logout' ? 'client_missing' : 'client_missing';
      continue;
    }
    if (d.kind === 'backchannel_logout') d.endpoint = client.backchannel_logout_uri;
    await attempt(e, d);
    ran++;
  }
  return ran;
}

const present = (d: Delivery): Obj => ({
  object: 'backchannel_logout_delivery',
  id: d.id,
  oauth_client_id: d.client_id,
  sid: d.sid,
  trace_id: null,
  test: d.is_test,
  status: d.status,
  attempt_number: d.attempt_number,
  max_attempts: d.is_test ? 1 : MAX_ATTEMPTS,
  http_status: d.http_status,
  latency_ms: d.latency_ms,
  error: d.error,
  location: d.location,
  response_snippet: d.response_snippet,
  next_retry_at: d.next_retry_at,
  attempted_at: d.attempted_at,
  delivered_at: d.delivered_at,
  created_at: d.created_at,
});

const rawView = (d: Delivery): Obj => ({ ...present(d), object: 'oauth_delivery', kind: d.kind, endpoint: d.endpoint, request_id: d.request_id, user_id: d.user_id, attempts: d.attempts });

export function emu4DeliveryHandlers(): RouteDef[] {
  const clientOf = (e: Engine, id: string | undefined): Obj => {
    const c = e.db.oauthClients.get(id);
    if (!c || c.deleted) throw new EmulatorError('NOT_FOUND', 'Unknown OAuth client.');
    return c;
  };
  return [
    {
      method: 'GET',
      pattern: '/v1/oauth_clients/:id/backchannel_deliveries',
      scope: 'oauth_clients:read',
      handler: async (c) => {
        const e = c.engine;
        const client = clientOf(e, c.params.id);
        await runDueDeliveries(e);
        const limit = Math.min(Math.max(Math.floor(Number(c.query.get('limit') ?? 20)) || 20, 1), 100);
        const rows = queue(e).filter((d) => d.kind === 'backchannel_logout' && d.client_id === client.id).reverse();
        const page = paginate(rows, { limit, startingAfter: c.query.get('starting_after') ?? undefined });
        return { body: { object: 'list', data: page.data.map(present), has_more: page.has_more, next_cursor: page.has_more ? (page.data[page.data.length - 1]?.id ?? null) : null } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/oauth_clients/:id/backchannel_logout/test',
      scope: 'oauth_clients:write',
      handler: async (c) => {
        const e = c.engine;
        const client = clientOf(e, c.params.id);
        if (!client.backchannel_logout_uri) throw new EmulatorError('CONFLICT', 'This client has no backchannel_logout_uri. Set one first, then send a test.');
        const sid = `sid_test_${randomToken(9)}`;
        const d = enqueue(e, { kind: 'backchannel_logout', client_id: client.id, endpoint: client.backchannel_logout_uri, user_id: `sub_test_${randomToken(9)}`, sid, is_test: true });
        await attempt(e, d);
        recordAudit(e, 'oauth_client.backchannel_logout_test_sent', 'api_key', 'oauth_client', client.id, { client_id: client.id, delivery_id: d.id, ok: d.status === 'success' });
        return { body: { object: 'backchannel_logout_test', delivery_id: d.id, ok: d.status === 'success', sid, status: d.http_status, latency_ms: d.latency_ms, error: d.error, location: d.location, blocked_reason: null, body_excerpt: d.response_snippet } };
      },
    },
    {
      // Every queued delivery with its attempts: `kind` (backchannel_logout, ciba_ping, ciba_push) and `client_id` narrow it.
      method: 'GET',
      pattern: '/__emulator/oauth/deliveries',
      public: true,
      handler: async (c) => {
        await runDueDeliveries(c.engine);
        const kind = c.query.get('kind');
        const client = c.query.get('client_id');
        return { body: { object: 'list', data: queue(c.engine).filter((d) => (!kind || d.kind === kind) && (!client || d.client_id === client)).map(rawView) } };
      },
    },
    { method: 'POST', pattern: '/__emulator/oauth/deliveries/run', public: true, handler: async (c) => ({ body: { object: 'delivery_sweep', attempted: await runDueDeliveries(c.engine) } }) },
  ];
}
