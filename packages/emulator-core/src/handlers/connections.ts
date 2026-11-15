/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteDef } from '../engine';
import { bytesToB64url, sha256 } from '../crypto-util';
import { EmulatorError, notFound } from '../errors';
import type { Obj } from '../openapi';
import { Table, paginate, randomToken } from '../store';
import { engineState, intIn, oneOf } from './support';
import { pageOf } from './util';
import { assertConnectionAccess, matchProviderStub } from './emu4-actions-access';

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


// ── bulk import ──
const IMPORT_MAX_ROWS = 500;
const OWNER_TYPES = ['organization', 'user', 'external'];
const CREDENTIAL_KINDS = ['api_key', 'client_credentials', 'bearer', 'basic', 'custom_header', 'hmac_secret', 'jwt_bearer', 'oauth1', 'github_app_installation', 'admin_consent'];
class RowError extends Error {
  constructor(readonly code: string, message: string, readonly field?: string) {
    super(message);
  }
}
const rowStr = (v: unknown, field: string, max = 4096): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new RowError('invalid', `${field} must be a non-empty string of at most ${max} characters.`, field);
  return v.trim();
};
const rowTime = (v: unknown, field: string): number | null => {
  if (v === undefined || v === null) return null;
  const t = typeof v === 'number' ? v : Date.parse(String(v));
  if (!Number.isFinite(t)) throw new RowError('invalid', `${field} must be epoch milliseconds or an ISO 8601 time.`, field);
  return t;
};

/** One import row, checked the way the real import checks it. */
function parseRow(row: Obj): Obj {
  const provider = rowStr(row.provider, 'provider', 64);
  if (!provider || !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(provider)) throw new RowError('invalid', 'provider must be a provider key.', 'provider');
  const o = (row.owner ?? {}) as Obj;
  if (!OWNER_TYPES.includes(o.type) || typeof o.id !== 'string' || !o.id) throw new RowError('invalid', 'owner must be {type: "organization" | "user" | "external", id}.', 'owner');
  const externalId = rowStr(row.external_id, 'external_id', 255);
  if (!externalId) throw new RowError('external_id_required', 'external_id (the provider-side account id) is required: it is how a re-import finds the same connection.', 'external_id');
  const kind = row.kind ?? 'oauth';
  if (typeof kind !== 'string' || (kind !== 'oauth' && !CREDENTIAL_KINDS.includes(kind))) throw new RowError('invalid', `kind must be one of oauth, ${CREDENTIAL_KINDS.join(', ')}.`, 'kind');
  const refreshToken = rowStr(row.refresh_token, 'refresh_token');
  const accessToken = rowStr(row.access_token, 'access_token', 16384);
  if (kind !== 'oauth') {
    if (refreshToken || accessToken || row.token_family !== undefined) throw new RowError('invalid', `A ${kind} row takes credentials, not refresh_token, access_token or token_family.`, 'credentials');
    if (!row.credentials || typeof row.credentials !== 'object' || Array.isArray(row.credentials)) throw new RowError('invalid', `credentials (the ${kind} secret fields) is required.`, 'credentials');
  } else if (!refreshToken && !accessToken) throw new RowError('invalid', 'refresh_token (or at least an access_token) is required.', 'refresh_token');
  else if (row.credentials !== undefined) throw new RowError('invalid', 'credentials apply to a non-oauth kind; set kind.', 'credentials');
  const expiresAt = rowTime(row.expires_at, 'expires_at');
  const refreshExpiresAt = rowTime(row.refresh_token_expires_at, 'refresh_token_expires_at');
  let configScopes: string[] | undefined;
  if (kind === 'oauth' && row.config !== undefined && row.config !== null) {
    if (typeof row.config !== 'object' || Array.isArray(row.config)) throw new RowError('invalid', 'config must be an object with scopes.', 'config');
    const cs = (row.config as Obj).scopes;
    if (cs !== undefined) {
      if (!Array.isArray(cs) || cs.length > 50 || cs.some((x) => typeof x !== 'string' || !x || /\s/.test(x) || x.length > 200)) throw new RowError('invalid', 'config.scopes must be a list of scope strings.', 'config.scopes');
      configScopes = cs;
    }
  }
  let scopes: string[] | undefined;
  if (row.scopes !== undefined) {
    const raw = typeof row.scopes === 'string' ? row.scopes.split(/[\s,]+/).filter(Boolean) : row.scopes;
    if (!Array.isArray(raw) || raw.length > 200 || raw.some((x) => typeof x !== 'string' || !x || /\s/.test(x) || x.length > 300)) throw new RowError('invalid', 'scopes must be a list of scope strings.', 'scopes');
    scopes = raw;
  }
  const metadata: Record<string, string> = {};
  if (row.metadata !== undefined && row.metadata !== null) {
    if (typeof row.metadata !== 'object' || Array.isArray(row.metadata)) throw new RowError('invalid', 'metadata must be an object of strings.', 'metadata');
    for (const [k, v] of Object.entries(row.metadata as Obj)) {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(k) || (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') || String(v).length > 1024) throw new RowError('invalid', `metadata.${k} must be a short scalar.`, `metadata.${k}`);
      metadata[k] = String(v);
    }
  }
  const environment = row.environment ?? 'production';
  if (environment !== 'production' && environment !== 'sandbox') throw new RowError('invalid', 'environment must be production or sandbox.', 'environment');
  if (row.host_params !== undefined && (typeof row.host_params !== 'object' || row.host_params === null || Array.isArray(row.host_params) || Object.values(row.host_params).some((v) => typeof v !== 'string'))) throw new RowError('invalid', 'host_params must be an object of strings.', 'host_params');
  return { kind, provider, owner: { type: o.type, id: o.id }, externalId, refreshToken, accessToken, expiresAt, refreshExpiresAt, configScopes, scopes, metadata, environment, hostParams: row.host_params ?? {}, name: rowStr(row.name, 'name', 200) ?? provider, nameGiven: row.name != null, allowedHosts: Array.isArray(row.allowed_hosts) ? row.allowed_hosts.filter((h: unknown) => typeof h === 'string') : [], tokenFamily: rowStr(row.token_family, 'token_family', 128) };
}

const failedRow = (index: number, err: unknown): Obj => {
  const e = err as RowError & { errors?: Array<{ message?: string; param?: string }> };
  const code = e instanceof RowError ? e.code : 'invalid';
  return { index, status: 'failed', connection_id: null, validated: false, refreshed: false, error: { code, message: e.message || 'Could not import this row.', ...(e instanceof RowError && e.field ? { field: e.field } : {}) } };
};

/** One relayed provider call: allowed method and host only, answered through the engine's `fetch`; also the path action runs take. */
export async function relayCall(e: Engine, conn: Obj, body: Obj): Promise<Obj> {
  const method = oneOf(body, 'method', ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], 'GET');
  let url: URL;
  try {
    url = new URL(String(body.url));
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
  const stubbed = matchProviderStub(e, url.toString(), method);
  if (!stubbed && !e.options.fetch) {
    record(e, conn.id, 'relay', 'error', { method, host: url.host, status: null, duration_ms: 0, attempts: 1, detail: 'no fetch configured' });
    throw new EmulatorError('CONNECTION_UPSTREAM_ERROR', 'The emulator has no outbound fetch: pass the `fetch` option to answer relayed calls.');
  }
  const started = e.clock.now();
  let res: Response;
  try {
    res = stubbed ?? (await e.options.fetch!(url.toString(), { method, headers: body.headers ?? {}, body: ['GET', 'HEAD'].includes(method) ? undefined : typeof body.body === 'string' ? body.body : body.body === undefined ? undefined : JSON.stringify(body.body) }));
  } catch (err) {
    record(e, conn.id, 'relay', 'error', { method, host: url.host, status: null, duration_ms: e.clock.now() - started, attempts: 1, detail: 'network error' });
    throw new EmulatorError('CONNECTION_UPSTREAM_ERROR', `The provider could not be reached: ${(err as Error).message}`);
  }
  record(e, conn.id, 'relay', res.status < 400 ? 'ok' : 'error', { method, host: url.host, status: res.status, duration_ms: e.clock.now() - started, attempts: 1 });
  return { object: 'connection_relay_response', connection_id: conn.id, status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
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
        const conn = connOf(c.engine, c.params.id);
        assertConnectionAccess(c.engine, conn.id, c.key, 'relay');
        return { body: await relayCall(c.engine, conn, c.body) };
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
    // ── bulk import: tokens a customer already holds, so no one reconnects ──
    {
      method: 'POST',
      pattern: '/v1/connections/import',
      scope: 'connections:import',
      handler: async (c) => {
        const e = c.engine;
        const b = c.body;
        if (!Array.isArray(b.connections) || b.connections.length === 0 || b.connections.length > IMPORT_MAX_ROWS) throw bad(`connections must be 1 to ${IMPORT_MAX_ROWS} rows.`, 'connections');
        for (const k of ['validate', 'dry_run', 'verify', 'exchange_expiring']) if (b[k] !== undefined && typeof b[k] !== 'boolean') throw bad(`${k} must be a boolean.`, k);
        for (const k of ['dry_run', 'verify']) {
          const qv = c.query.get(k);
          if (qv !== null && qv !== 'true' && qv !== 'false') throw bad(`${k} must be true or false.`, k);
        }
        const validate = b.validate !== false;
        const exchange = b.exchange_expiring === true;
        const dryRun = b.dry_run === true || c.query.get('dry_run') === 'true';
        const table = (): Table => {
          let t = e.generic.get('connections');
          if (!t) e.generic.set('connections', (t = new Table('connections', e.clock.now, 'connection')));
          return t;
        };
        const seen = new Map<string, number>();
        const leaders = new Map<string, number>();
        const out: Obj[] = [];
        for (const [index, raw] of (b.connections as unknown[]).entries()) {
          try {
            const p = parseRow(raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Obj) : {});
            const key = [p.owner.type, p.owner.id, p.provider, p.environment, p.externalId].join('|');
            if (seen.has(key)) throw new RowError('duplicate_in_batch', `The same account appears in row ${seen.get(key)}.`, 'external_id');
            seen.set(key, index);
            if (p.owner.type === 'organization' && !e.db.organizations.get(p.owner.id)) throw new RowError('owner_not_found', 'Unknown organization.', 'owner');
            if (p.owner.type === 'user' && !e.db.users.get(p.owner.id)) throw new RowError('owner_not_found', 'Unknown user.', 'owner');
            // Rows of one token family share the leader's grant; a follower needs a leader that imported.
            const famKey = p.tokenFamily ? [p.owner.type, p.owner.id, p.provider, p.environment, p.tokenFamily].join('|') : undefined;
            const leader = famKey ? leaders.get(famKey) : undefined;
            if (famKey && leader === undefined) leaders.set(famKey, index);
            if (leader !== undefined && out[leader]?.status === 'failed') throw new RowError('family_leader_failed', `The row sharing this token set (row ${leader}) did not import.`, 'token_family');
            const all = table().all();
            const prior = all.find((x) => x.owner?.type === p.owner.type && x.owner?.id === p.owner.id && x.provider === p.provider && (x.environment ?? 'production') === p.environment && x.external_id === p.externalId);
            const taken = all.find((x) => x.provider === p.provider && (x.environment ?? 'production') === p.environment && x.external_id === p.externalId && !(x.owner?.type === p.owner.type && x.owner?.id === p.owner.id));
            if (taken) throw new RowError('external_id_taken', `That provider account is already connected under another owner (connection ${taken.id}).`, 'external_id');
            // shortcut: the emulator holds no provider clients, so a refresh token is never spent at a provider: validated and refreshed stay false and a dry run reports ok_unverified.
            const base: Obj = { index, validated: false, refreshed: false, error: null };
            if (dryRun) {
              out.push({ ...base, status: prior ? 'would_update' : 'would_create', connection_id: prior?.id ?? null, check: 'ok_unverified' });
              continue;
            }
            let tokens = { access: p.accessToken as string | undefined, refresh: p.refreshToken as string | undefined, expiresAt: p.expiresAt as number | null, expiring: false };
            let exchanged: boolean | undefined;
            let exchangeError: string | undefined;
            // A non-expiring Shopify offline token (an access token and no refresh token) is swapped for an expiring pair. Opt in; a refusal keeps the original token.
            if (exchange && p.kind === 'oauth' && p.provider === 'shopify' && tokens.access && !tokens.refresh) {
              const shop = String(p.hostParams.shop ?? '');
              const host = shop.includes('.') ? shop : `${shop}.myshopify.com`;
              if (!shop || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(host) || !e.options.fetch) {
                exchanged = false;
                exchangeError = 'exchange_unavailable';
              } else {
                try {
                  const res = await e.options.fetch(`https://${host}/admin/oauth/access_token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', expiring: 1 }) });
                  const json: any = await res.json().catch(() => null);
                  if (res.ok && json && typeof json.access_token === 'string') {
                    tokens = { access: json.access_token, refresh: typeof json.refresh_token === 'string' ? json.refresh_token : undefined, expiresAt: e.clock.now() + (Number(json.expires_in) || 3600) * 1000, expiring: true };
                    exchanged = true;
                  } else {
                    exchanged = false;
                    exchangeError = typeof json?.error === 'string' ? json.error : 'exchange_unavailable';
                  }
                } catch {
                  exchanged = false;
                  exchangeError = 'exchange_unavailable';
                }
              }
            }
            const now = e.clock.now();
            let row = prior;
            if (!row) {
              const made = await e.handle(new Request(`${e.issuer}/v1/connections`, { method: 'POST', headers: { authorization: c.request.headers.get('authorization') ?? '', 'content-type': 'application/json' }, body: JSON.stringify({ owner: { type: p.owner.type, id: p.owner.id }, kind: p.kind, provider: p.provider, name: p.name, allowed_hosts: p.allowedHosts, config: p.configScopes ? { scopes: p.configScopes } : {}, environment: p.environment, host_params: p.hostParams }) }));
              const created: any = await made.json().catch(() => null);
              if (made.status !== 201 || !created?.id) throw new RowError('invalid', created?.errors?.[0]?.message ?? 'Could not import this row.', created?.errors?.[0]?.param);
              row = table().get(created.id)!;
            } else {
              if (p.nameGiven) row.name = p.name;
              if (p.configScopes) row.config = { ...(row.config ?? {}), scopes: p.configScopes };
              row.host_params = p.hostParams;
            }
            Object.assign(row, {
              external_id: p.externalId,
              metadata: { ...(prior?.metadata ?? {}), ...p.metadata },
              status: 'connected',
              connected_at: row.connected_at ?? now,
              updated_at: now,
              ...(p.kind === 'oauth' ? { scopes: p.scopes ?? row.scopes ?? [], expires_at: tokens.access ? tokens.expiresAt : 0, has_refresh_token: tokens.refresh !== undefined || (leader !== undefined && table().get(String(out[leader]?.connection_id))?.has_refresh_token === true), expiring: tokens.expiring, refresh_token_expires_at: p.refreshExpiresAt ?? null, ...(p.tokenFamily ? { token_family: p.tokenFamily } : {}) } : { has_secret: true }),
            });
            out.push({ ...base, status: prior ? 'updated' : 'created', connection_id: row.id, ...(exchanged !== undefined ? { exchanged, ...(exchangeError ? { exchange_error: exchangeError } : {}) } : {}) });
          } catch (err) {
            out.push(failedRow(index, err));
          }
        }
        if (dryRun) for (const r of out) r.check ??= r.error?.code === 'refresh_token_rejected' ? 'refresh_refused' : r.error?.code === 'provider_unavailable' ? 'provider_unavailable' : r.error ? 'invalid_row' : 'ok_unverified';
        const count = (x: string) => out.filter((r) => r.status === x).length;
        return { body: { object: 'connection_import', total: out.length, dry_run: dryRun, validated: validate, created: count('created'), updated: count('updated'), would_create: count('would_create'), would_update: count('would_update'), failed: count('failed'), data: out } };
      },
    },
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
