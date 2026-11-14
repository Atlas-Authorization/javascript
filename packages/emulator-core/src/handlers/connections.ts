/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteDef } from '../engine';
import { bytesToB64url, sha256 } from '../crypto-util';
import { EmulatorError, notFound } from '../errors';
import type { Obj } from '../openapi';
import { Table, paginate, randomToken } from '../store';
import { engineState, intIn, oneOf } from './support';
import { pageOf } from './util';

/**
 * Connection history and recovery on the engine's own state: the per-connection activity log (what happened, never what was
 * sent: method, host, status and timing only), persisted provider events with read-back and replay, hosted reconnect
 * (settings, a one-time link, the public pages) and the exchange of a non-expiring Shopify token for an expiring one.
 * Connections themselves are the generic CRUD layer's rows. The relay goes through the engine's `fetch` option, so it never
 * reaches a real provider unless a test says so.
 */
const RETENTION_MS = 30 * 86_400_000;
const ACTIVITY_KINDS = ['relay', 'token_read', 'refresh', 'health', 'provider_event', 'reconnect', 'token_exchange'] as const;
const OUTCOMES = ['ok', 'error', 'blocked'] as const;
const UNINSTALL = /(^|[/._-])(uninstall(ed)?|deauthori[sz]ed?|installation[._-]deleted|app[._/-]uninstalled)($|[/._-])/i;
const MAX_PAYLOAD = 256 * 1024;
const bad = (message: string, param: string) => new EmulatorError('VALIDATION_FAILED', message, param);

interface Conn {
  activity: Table;
  events: Table;
  links: Map<string, { connectionId: string; expiresAt: number; started: boolean }>;
  settings: { enabled: boolean; link_ttl_hours: number; return_url: string | null; providers: string[] };
}
const st = engineState((e: Engine): Conn => ({ activity: new Table('connection_activity', e.clock.now, 'cact'), events: new Table('connection_provider_events', e.clock.now, 'cpev'), links: new Map(), settings: { enabled: false, link_ttl_hours: 168, return_url: null, providers: [] } }));

const connOf = (e: Engine, id: string | undefined): Obj => {
  const c = e.generic.get('connections')?.get(id);
  if (!c) throw notFound('Connection');
  return c;
};
const record = (e: Engine, connectionId: string, kind: (typeof ACTIVITY_KINDS)[number], outcome: (typeof OUTCOMES)[number], extra: Obj = {}): void => {
  st(e).activity.insert({ connection_id: connectionId, kind, outcome, created_at: e.clock.now(), ...extra });
};
const activityView = (r: Obj): Obj => ({ object: 'connection_activity', id: r.id, connection_id: r.connection_id, kind: r.kind, outcome: r.outcome, method: r.method ?? null, host: r.host ?? null, status: r.status ?? null, duration_ms: r.duration_ms ?? null, attempts: r.attempts ?? null, detail: r.detail ?? null, created_at: r.created_at });
const eventView = (r: Obj, payload: boolean): Obj => ({ object: 'connection_provider_event', id: r.id, connection_id: r.connection_id, provider: r.provider, topic: r.topic, kind: r.kind, replayed: r.replay_count > 0, replay_count: r.replay_count, received_at: r.received_at, ...(payload ? { payload: r.payload } : {}) });
const sinceFilter = (e: Engine, v: string | null): number => {
  if (v === null) return e.clock.now() - RETENTION_MS;
  const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  if (Number.isNaN(n)) throw bad('since must be epoch milliseconds or an ISO 8601 time.', 'since');
  return Math.max(n, e.clock.now() - RETENTION_MS);
};
const hostAllowed = (host: string, allowed: string[]): boolean => allowed.some((a) => (a.startsWith('*.') ? host.endsWith(a.slice(1)) && host.length > a.length - 1 : host === a));
const hashLink = async (t: string): Promise<string> => bytesToB64url(await sha256(t));

function announce(e: Engine, ev: Obj, replayed: boolean): void {
  e.webhooks.emit('connection.provider_event', { object: 'connection_provider_event', id: ev.id, connection_id: ev.connection_id, provider: ev.provider, topic: ev.topic, kind: ev.kind, ...(replayed ? { replayed: true, event_id: ev.id } : {}), received_at: ev.received_at });
}

export function connectionsHandlers(): RouteDef[] {
  const eventOf = (e: Engine, connectionId: string, id: string | undefined): Obj => {
    const ev = st(e).events.get(id);
    if (!ev || ev.connection_id !== connectionId) throw notFound('Provider event');
    return ev;
  };
  const eventList = (e: Engine, q: URLSearchParams, connectionId: string | null, c: any): Obj => {
    const since = sinceFilter(e, q.get('since'));
    const rows = st(e).events.all().filter((r) => r.received_at >= since && (!connectionId || r.connection_id === connectionId) && (!q.get('connection_id') || r.connection_id === q.get('connection_id')) && (!q.get('provider') || r.provider === q.get('provider')) && (!q.get('topic') || r.topic === q.get('topic')));
    const page = paginate(rows, pageOf(c));
    return { object: 'list', data: page.data.map((r) => eventView(r, false)), has_more: page.has_more, next_cursor: page.next_cursor };
  };

  return [
    // ── activity ──
    {
      method: 'GET',
      pattern: '/v1/connections/:id/activity',
      scope: 'organizations:read',
      handler: (c) => {
        const e = c.engine;
        const conn = connOf(e, c.params.id);
        const kind = c.query.get('kind');
        const outcome = c.query.get('outcome');
        if (kind && !(ACTIVITY_KINDS as readonly string[]).includes(kind)) throw bad(`kind must be one of: ${ACTIVITY_KINDS.join(', ')}.`, 'kind');
        if (outcome && !(OUTCOMES as readonly string[]).includes(outcome)) throw bad(`outcome must be one of: ${OUTCOMES.join(', ')}.`, 'outcome');
        const since = sinceFilter(e, c.query.get('since'));
        const rows = st(e).activity.all().filter((r) => r.connection_id === conn.id && r.created_at >= since && (!kind || r.kind === kind) && (!outcome || r.outcome === outcome));
        const page = paginate(rows, pageOf(c));
        return { body: { object: 'list', data: page.data.map(activityView), has_more: page.has_more, next_cursor: page.next_cursor } };
      },
    },
    {
      // The relay: allowed method and host only; the log keeps method, host, status, duration and attempts, never the path, headers or body.
      method: 'POST',
      pattern: '/v1/connections/:id/relay',
      scope: 'connections:relay',
      handler: async (c) => {
        const e = c.engine;
        const conn = connOf(e, c.params.id);
        const method = oneOf(c.body, 'method', ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], 'GET');
        let url: URL;
        try {
          url = new URL(String(c.body.url));
        } catch {
          throw bad('url must be an absolute https URL.', 'url');
        }
        if (url.protocol !== 'https:' || url.username || url.password) throw bad('url must be an https URL without credentials.', 'url');
        const methods: string[] = conn.allowed_methods ?? ['GET'];
        const refuse = (detail: string, param: string): never => {
          record(e, conn.id, 'relay', 'blocked', { method, host: url.host, detail });
          throw new EmulatorError('FORBIDDEN', detail, param);
        };
        if (conn.status === 'revoked') refuse('This connection is revoked.', 'url');
        if (!methods.includes(method)) refuse(`${method} is not in this connection's allowed_methods.`, 'method');
        if (!hostAllowed(url.hostname, conn.allowed_hosts ?? [])) refuse('That host is not in this connection\'s allowed_hosts.', 'url');
        if (!e.options.fetch) {
          record(e, conn.id, 'relay', 'error', { method, host: url.host, status: null, duration_ms: 0, attempts: 1, detail: 'no fetch configured' });
          throw new EmulatorError('CONNECTION_UPSTREAM_ERROR', 'The emulator has no outbound fetch: pass the `fetch` option to answer relayed calls.');
        }
        const started = e.clock.now();
        let res: Response;
        try {
          res = await e.options.fetch(url.toString(), { method, headers: c.body.headers ?? {}, body: ['GET', 'HEAD'].includes(method) ? undefined : typeof c.body.body === 'string' ? c.body.body : c.body.body === undefined ? undefined : JSON.stringify(c.body.body) });
        } catch (err) {
          record(e, conn.id, 'relay', 'error', { method, host: url.host, status: null, duration_ms: e.clock.now() - started, attempts: 1, detail: 'network error' });
          throw new EmulatorError('CONNECTION_UPSTREAM_ERROR', `The provider could not be reached: ${(err as Error).message}`);
        }
        record(e, conn.id, 'relay', res.status < 400 ? 'ok' : 'error', { method, host: url.host, status: res.status, duration_ms: e.clock.now() - started, attempts: 1 });
        return { body: { object: 'connection_relay_response', connection_id: conn.id, status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() } };
      },
    },
    // ── persisted provider events ──
    {
      // The provider's announcement lands here (in production, signature-verified per provider): stored, announced, and an uninstall revokes the connection.
      method: 'POST',
      pattern: '/v1/connection_provider_events/:instanceId/:provider',
      public: true,
      handler: (c) => {
        const e = c.engine;
        if (c.params.instanceId !== e.instanceId) throw notFound('Instance');
        const conn = connOf(e, c.body.connection_id);
        if (conn.provider !== c.params.provider) throw notFound('Connection for that provider');
        if (typeof c.body.topic !== 'string' || !c.body.topic || c.body.topic.length > 200) throw bad('topic is required (up to 200 characters).', 'topic');
        const payload = c.body.payload ?? {};
        if (JSON.stringify(payload).length > MAX_PAYLOAD) throw bad('payload can be at most 256 KB.', 'payload');
        const kind = UNINSTALL.test(c.body.topic) ? 'uninstall' : 'event';
        const ev = st(e).events.insert({ connection_id: conn.id, provider: conn.provider, topic: c.body.topic, kind, payload, replay_count: 0, received_at: e.clock.now() });
        record(e, conn.id, 'provider_event', 'ok', { detail: c.body.topic });
        announce(e, ev, false);
        if (kind === 'uninstall' && conn.status !== 'revoked') {
          conn.status = 'revoked';
          record(e, conn.id, 'health', 'ok', { detail: 'revoked by the provider' });
          e.webhooks.emit('connection.revoked', { object: 'connection', id: conn.id, provider: conn.provider, reason: 'provider_uninstall' });
        }
        return { status: 201, body: eventView(ev, false) };
      },
    },
    { method: 'GET', pattern: '/v1/connections/:id/provider_events', scope: 'organizations:read', handler: (c) => ({ body: eventList(c.engine, c.query, connOf(c.engine, c.params.id).id, c) }) },
    { method: 'GET', pattern: '/v1/connection_provider_event_log', scope: 'organizations:read', handler: (c) => ({ body: eventList(c.engine, c.query, null, c) }) },
    {
      method: 'GET',
      pattern: '/v1/connections/:id/provider_events/:eventId',
      scope: 'organizations:read',
      handler: (c) => ({ body: eventView(eventOf(c.engine, connOf(c.engine, c.params.id).id, c.params.eventId), true) }),
    },
    {
      // Re-announces only: a replayed uninstall never revokes a connection again.
      method: 'POST',
      pattern: '/v1/connections/:id/provider_events/:eventId/replay',
      scope: 'organizations:write',
      handler: (c) => {
        const e = c.engine;
        const ev = eventOf(e, connOf(e, c.params.id).id, c.params.eventId);
        ev.replay_count++;
        announce(e, ev, true);
        return { body: eventView(ev, false) };
      },
    },
    // ── hosted reconnect ──
    { method: 'GET', pattern: '/v1/connection_reconnect_settings', scope: 'organizations:read', handler: (c) => ({ body: { object: 'connection_reconnect_settings', ...st(c.engine).settings } }) },
    {
      method: 'PUT',
      pattern: '/v1/connection_reconnect_settings',
      scope: 'organizations:write',
      handler: (c) => {
        const s = st(c.engine).settings;
        const b = c.body;
        const unknown = Object.keys(b).find((k) => !['enabled', 'link_ttl_hours', 'return_url', 'providers'].includes(k));
        if (unknown) throw bad(`Unknown field: ${unknown}.`, unknown);
        const next = { ...s };
        if (b.enabled !== undefined) {
          if (typeof b.enabled !== 'boolean') throw bad('enabled must be true or false.', 'enabled');
          next.enabled = b.enabled;
        }
        if (b.link_ttl_hours !== undefined) next.link_ttl_hours = intIn(b.link_ttl_hours, 'link_ttl_hours', 1, 720);
        if (b.return_url !== undefined) {
          if (b.return_url !== null) {
            let u: URL | null = null;
            try {
              u = new URL(b.return_url);
            } catch {
              /* reported below */
            }
            if (!u || u.protocol !== 'https:' || u.username || u.password) throw bad('return_url must be an https URL.', 'return_url');
          }
          next.return_url = b.return_url;
        }
        if (b.providers !== undefined) {
          if (!Array.isArray(b.providers) || b.providers.length > 50 || b.providers.some((p: unknown) => typeof p !== 'string' || !p)) throw bad('providers is a list of up to 50 provider keys.', 'providers');
          next.providers = [...new Set<string>(b.providers)];
        }
        Object.assign(s, next);
        return { body: { object: 'connection_reconnect_settings', ...s } };
      },
    },
    {
      // A one-time link for the owner to authorize again. Only a hash is stored; the URL is shown once. `send_email` mails the owner (your own mail provider).
      method: 'POST',
      pattern: '/v1/connections/:id/reconnect_link',
      scope: 'organizations:write',
      handler: async (c) => {
        const e = c.engine;
        const conn = connOf(e, c.params.id);
        const s = st(e).settings;
        if (c.body.send_email !== undefined && typeof c.body.send_email !== 'boolean') throw bad('send_email must be a boolean.', 'send_email');
        const ttl = c.body.ttl_hours === undefined ? s.link_ttl_hours : intIn(c.body.ttl_hours, 'ttl_hours', 1, 720);
        if (!s.enabled) throw new EmulatorError('CONFLICT', 'Hosted reconnect is off. Turn it on with PUT /v1/connection_reconnect_settings.');
        if (conn.kind !== 'oauth') throw bad('Only an oauth connection is authorized again with the provider.', 'kind');
        if (conn.status === 'revoked') throw new EmulatorError('CONFLICT', 'This connection was revoked; connect it again with POST /v1/connections/{id}/connect.');
        if (s.providers.length && !s.providers.includes(conn.provider)) throw bad(`Hosted reconnect is not enabled for ${conn.provider}.`, 'provider');
        let recipients: string[] = [];
        if (c.body.send_email === true) {
          const user = conn.owner?.type === 'user' ? e.db.users.get(conn.owner.id) : undefined;
          const primary = (user?.emails as Obj[] | undefined)?.find((m) => m.id === user?.primary_email_address_id && m.verified);
          if (!primary) throw bad('This connection has no email recipient (a user owner needs a verified address).', 'send_email');
          recipients = [primary.email_address];
        }
        const token = randomToken(32);
        const expiresAt = e.clock.now() + ttl * 3_600_000;
        st(e).links.set(await hashLink(token), { connectionId: conn.id, expiresAt, started: false });
        const url = `${e.issuer}/v1/connection_reconnect/${token}`;
        for (const to of recipients) e.messages.send({ channel: 'email', to, subject: `Reconnect your ${conn.provider} connection`, link: url, meta: { template: 'connection_reconnect' } });
        record(e, conn.id, 'reconnect', 'ok', { detail: 'link issued' });
        return { status: 201, body: { object: 'connection_reconnect_link', connection_id: conn.id, url, expires_at: expiresAt, emailed: recipients.length } };
      },
    },
    {
      // Public. Looking at the page spends nothing (a mail scanner may open it). Every bad link answers the same.
      method: 'GET',
      pattern: '/v1/connection_reconnect/:token',
      public: true,
      handler: async (c) => {
        const e = c.engine;
        const link = st(e).links.get(await hashLink(c.params.token ?? ''));
        if (!link || link.expiresAt <= e.clock.now() || link.started) throw bad('This link is not valid.', 'token');
        const conn = connOf(e, link.connectionId);
        return { headers: { 'cache-control': 'no-store' }, body: { object: 'connection_reconnect_page', connection: { id: conn.id, provider: conn.provider, name: conn.name ?? null }, expires_at: link.expiresAt } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/connection_reconnect/:token/start',
      public: true,
      handler: async (c) => {
        const e = c.engine;
        const link = st(e).links.get(await hashLink(c.params.token ?? ''));
        if (!link || link.expiresAt <= e.clock.now() || link.started) throw bad('This link is not valid.', 'token');
        link.started = true;
        const conn = connOf(e, link.connectionId);
        record(e, conn.id, 'reconnect', 'ok', { detail: 'started' });
        const back = st(e).settings.return_url ?? `${e.issuer}/v1/connection_reconnect_done`;
        return { status: 302, headers: { location: `${e.issuer}/__emulator/provider/${encodeURIComponent(conn.provider)}/authorize?connection_id=${conn.id}&return=${encodeURIComponent(back)}`, 'cache-control': 'no-store' } };
      },
    },
    { method: 'GET', pattern: '/v1/connection_reconnect_done', public: true, handler: () => ({ headers: { 'cache-control': 'no-store' }, body: { object: 'connection_reconnect_done', ok: true } }) },
    // ── Shopify: non-expiring offline token to an expiring one ──
    {
      method: 'POST',
      pattern: '/v1/connections/:id/token/exchange',
      scope: 'connections:token',
      handler: async (c) => {
        const e = c.engine;
        const conn = connOf(e, c.params.id);
        if (conn.provider !== 'shopify') throw bad('Only a Shopify connection has a token to exchange.', 'provider');
        if (conn.status === 'revoked') throw new EmulatorError('CONFLICT', 'This connection is revoked.');
        if (conn.expiring === true) throw new EmulatorError('CONFLICT', 'This connection already holds an expiring token.');
        const shop = String(conn.host_params?.shop ?? conn.config?.shop ?? (conn.allowed_hosts ?? [])[0] ?? '');
        const host = shop.includes('.') ? shop : `${shop}.myshopify.com`;
        // The app secret goes only to the shop's own host.
        if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(host)) throw bad('The exchange only runs against a *.myshopify.com shop.', 'host');
        if (!e.options.fetch) throw new EmulatorError('OAUTH_EXCHANGE_FAILED', 'The emulator has no outbound fetch: pass the `fetch` option to play the Shopify token endpoint.');
        let res: Response;
        try {
          res = await e.options.fetch(`https://${host}/admin/oauth/access_token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', expiring: 1 }) });
        } catch {
          throw new EmulatorError('OAUTH_EXCHANGE_FAILED', 'The shop could not be reached; the token is unchanged.');
        }
        const json: any = res.ok ? await res.json().catch(() => null) : null;
        if (!json || typeof json.access_token !== 'string') {
          record(e, conn.id, 'token_exchange', 'error', { host, status: res.status });
          throw new EmulatorError('OAUTH_EXCHANGE_FAILED', 'Shopify refused the exchange; the token is unchanged.', undefined, { meta: { provider_status: res.status } });
        }
        conn.expiring = true;
        conn.has_refresh_token = typeof json.refresh_token === 'string';
        conn.updated_at = e.clock.now();
        record(e, conn.id, 'token_exchange', 'ok', { host, status: res.status });
        return { body: { object: 'connection_token_exchange', connection_id: conn.id, exchanged: true, expiring: true, has_refresh_token: conn.has_refresh_token, expires_in: Number(json.expires_in) || null } };
      },
    },
  ];
}
