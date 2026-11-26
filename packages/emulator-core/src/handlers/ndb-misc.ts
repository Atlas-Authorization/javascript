/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, Reply, RouteDef } from '../engine';
import { EmulatorError, notFound } from '../errors';
import type { Obj } from '../openapi';
import { Table } from '../store';
import { adv } from './oauth-adv';
import { consentGrants, consentHoldById, grantEvent, pairHolds, removeConsentHold } from './oauth-flows';
import { revokeGrant, st as oauthSt } from './oauth';
import { bad, canonical, hex, isObj, listOf, pageReply } from './emu4-shared';
import { engineState } from './support';
import { dsrRows } from './emu3-misc';
import { createUser, emailTaken, presentUser } from './users';

/**
 * The instance-level surfaces added with the native-app and integrator batches: native app registry, the before-first-session hook,
 * sign-up forwarding and integration health, the issuers list, message links, the webhook dead-letter queue, provider policies and
 * templates, connection rehoming, legacy session import, managed and consent grants, per-user risk signals, deletion rescheduling,
 * the security summary, delegation tokens and the by-external-id upsert.
 * shortcut: the emulator holds no vendor integrations, so sign-up forwarding to lucida / hermetica / seolyticize is recorded (and
 * reported by the health list) but nothing is sent; only a `webhook` destination becomes a real webhook endpoint.
 */
const DAY = 86_400_000;
const MAX_DEV_APP_MS = 90 * DAY;
const PLATFORMS = ['ios', 'android', 'development'];
const BAD_SCHEMES = ['http:', 'javascript:', 'data:', 'file:', 'ftp:', 'blob:', 'about:', 'vbscript:'];
const DESTINATIONS = ['lucida', 'hermetica', 'seolyticize', 'webhook', 'watchtower'];
/** What watchtower forwarding delivers, as on the server: security events, never sign-ups. */
const WATCHTOWER_EVENTS = ['user.locked', 'user.banned', 'user.contained', 'risky_user.updated', 'session.impersonation_started', 'mfa_factor.quarantined'];
const eventsOf = (dest: unknown): string[] => (dest === 'watchtower' ? WATCHTOWER_EVENTS : ['user.created']);

interface State {
  apps: Table;
  restriction: string[];
  hook: Obj;
  forwarding: Map<string, Obj>;
  policies: Map<string, Obj>;
  legacy: Map<string, Map<string, Obj>>;
  metadata: Map<string, Obj>;
}
const st = engineState((e: Engine): State => ({ apps: new Table('native_apps', e.clock.now, 'napp'), restriction: [], hook: freshHook(), forwarding: new Map(), policies: new Map(), legacy: new Map(), metadata: new Map() }));
function freshHook(): Obj {
  return { enabled: false, url: null, signing_secret: null, timeout_ms: 3000, last_call: null, failed_calls: 0, updated_at: null };
}

const strList = (v: unknown, param: string, min: number, max: number): string[] => {
  if (!Array.isArray(v) || v.length < min || v.length > max || v.some((x) => typeof x !== 'string' || x === '')) throw bad(`${param} is a list of ${min} to ${max} strings.`, param);
  return v as string[];
};

// ── native apps ──

const normFingerprint = (f: string): string => {
  const hexs = f.replace(/:/g, '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hexs)) throw bad('sha256_cert_fingerprints entries are 64 hex characters (colons optional).', 'sha256_cert_fingerprints');
  return hexs.match(/../g)!.join(':');
};

function callbackUrls(v: unknown, development: boolean): string[] {
  const urls = strList(v, 'callback_urls', 1, 10);
  for (const u of urls) {
    let p: URL;
    try {
      p = new URL(u);
    } catch {
      throw bad(`${u} is not a URL.`, 'callback_urls');
    }
    if (p.hash) throw bad('A callback URL carries no fragment.', 'callback_urls');
    if (BAD_SCHEMES.includes(p.protocol)) throw bad(`${p.protocol} callbacks are refused: use https or an app-specific scheme.`, 'callback_urls');
    if ((p.protocol === 'exp:' || p.protocol.startsWith('exp+')) && !development) throw new EmulatorError('DEV_SCHEME_ON_PRODUCTION', 'exp:// callbacks are accepted for development apps only.', 'callback_urls');
  }
  return urls;
}

function devFields(e: Engine, b: Obj, current?: Obj): Obj {
  const out: Obj = {};
  const now = e.clock.now();
  if (b.allowed_users !== undefined || !current) out.allowed_users = strList(b.allowed_users, 'allowed_users', 1, 100);
  if (b.expires_at !== undefined || !current) {
    const at = b.expires_at;
    if (typeof at !== 'number' || !Number.isInteger(at) || at <= now) throw bad('expires_at is epoch milliseconds in the future.', 'expires_at');
    if (at > now + MAX_DEV_APP_MS) throw bad('expires_at is at most 90 days ahead.', 'expires_at');
    out.expires_at = at;
  }
  return out;
}

const presentApp = (e: Engine, a: Obj): Obj => ({
  object: 'native_app',
  id: a.id,
  platform: a.platform,
  ...(a.platform === 'development' ? { allowed_users: a.allowed_users, expires_at: a.expires_at, expired: a.expires_at <= e.clock.now() } : {}),
  ...(a.bundle_id ? { bundle_id: a.bundle_id, team_id: a.team_id } : {}),
  ...(a.package_name ? { package_name: a.package_name, sha256_cert_fingerprints: a.sha256_cert_fingerprints } : {}),
  callback_urls: a.callback_urls,
  created_at: a.created_at,
});

const appOf = (e: Engine, id: string | undefined): Obj => {
  const a = st(e).apps.get(id);
  if (!a) throw notFound('Native app');
  return a;
};

const restrictionView = (e: Engine): Obj => ({ object: 'native_app_key_restriction', app_ids: [...st(e).restriction] });

function nativeAppRoutes(): RouteDef[] {
  const identity = (b: Obj): string => (b.platform === 'ios' ? `ios:${b.bundle_id}:${b.team_id}` : b.platform === 'android' ? `android:${b.package_name}` : '');
  return [
    { method: 'GET', pattern: '/v1/native_apps', handler: (c) => ({ body: pageReply(c, st(c.engine).apps.all().map((a) => presentApp(c.engine, a))) }) },
    { method: 'GET', pattern: '/v1/native_apps/publishable_key', handler: (c) => ({ body: restrictionView(c.engine) }) },
    {
      method: 'PUT',
      pattern: '/v1/native_apps/publishable_key',
      handler: (c) => {
        const e = c.engine;
        const ids = strList(c.body.app_ids, 'app_ids', 0, 100);
        for (const id of ids) if (!st(e).apps.get(id)) throw new EmulatorError('NATIVE_APP_NOT_REGISTERED', `${id} is not a registered native app.`, 'app_ids');
        st(e).restriction = [...new Set(ids)];
        return { body: restrictionView(e) };
      },
    },
    { method: 'GET', pattern: '/v1/native_apps/:id', handler: (c) => ({ body: presentApp(c.engine, appOf(c.engine, c.params.id)) }) },
    {
      method: 'POST',
      pattern: '/v1/native_apps',
      handler: (c) => {
        const e = c.engine;
        const b = c.body;
        if (typeof b.platform !== 'string' || !PLATFORMS.includes(b.platform)) throw bad(`platform is one of ${PLATFORMS.join(', ')}.`, 'platform');
        const row: Obj = { platform: b.platform, created_at: e.clock.now() };
        if (b.platform === 'ios') {
          if (typeof b.bundle_id !== 'string' || typeof b.team_id !== 'string') throw bad('An ios app needs bundle_id and team_id.', 'bundle_id');
          Object.assign(row, { bundle_id: b.bundle_id, team_id: b.team_id });
        } else if (b.platform === 'android') {
          if (typeof b.package_name !== 'string') throw bad('An android app needs package_name and sha256_cert_fingerprints.', 'package_name');
          Object.assign(row, { package_name: b.package_name, sha256_cert_fingerprints: strList(b.sha256_cert_fingerprints, 'sha256_cert_fingerprints', 1, 10).map(normFingerprint) });
        } else Object.assign(row, devFields(e, b));
        row.callback_urls = callbackUrls(b.callback_urls, b.platform === 'development');
        const key = identity(b);
        if (key && st(e).apps.find((a) => identity(a) === key)) throw new EmulatorError('CONFLICT', 'That app is already registered.');
        const app = st(e).apps.insert(row as any);
        return { status: 201, body: presentApp(e, app) };
      },
    },
    {
      method: 'PATCH',
      pattern: '/v1/native_apps/:id',
      handler: (c) => {
        const e = c.engine;
        const app = appOf(e, c.params.id);
        const b = c.body;
        if (b.platform !== undefined && b.platform !== app.platform) throw bad('The platform of an app cannot be changed.', 'platform');
        const patch: Obj = {};
        if (b.callback_urls !== undefined) patch.callback_urls = callbackUrls(b.callback_urls, app.platform === 'development');
        if (app.platform === 'development') Object.assign(patch, devFields(e, b, app));
        else if (b.allowed_users !== undefined || b.expires_at !== undefined) throw bad('allowed_users and expires_at belong to development apps.', 'allowed_users');
        Object.assign(app, patch);
        return { body: presentApp(e, app) };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/native_apps/:id',
      handler: (c) => {
        const e = c.engine;
        const app = appOf(e, c.params.id);
        st(e).apps.delete(app.id);
        st(e).restriction = st(e).restriction.filter((x) => x !== app.id);
        return { body: { object: 'native_app', id: app.id, deleted: true } };
      },
    },
  ];
}

// ── before_first_session hook ──

const hookView = (h: Obj): Obj => ({ object: 'before_first_session_hook', enabled: h.enabled, url: h.url, signing_secret_set: h.signing_secret !== null, timeout_ms: h.timeout_ms, last_call: h.last_call, failed_calls: h.failed_calls, updated_at: h.updated_at });
const hookUrl = (v: unknown): string => {
  let u: URL;
  try {
    u = new URL(String(v));
  } catch {
    throw bad('url is not a URL.', 'url');
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && u.hostname === 'localhost')) throw bad('url must be https (http only for localhost).', 'url');
  return u.toString();
};

function hookRoutes(): RouteDef[] {
  return [
    { method: 'GET', pattern: '/v1/instance/hooks/before_first_session', handler: (c) => ({ body: hookView(st(c.engine).hook) }) },
    {
      method: 'PATCH',
      pattern: '/v1/instance/hooks/before_first_session',
      handler: (c) => {
        const e = c.engine;
        const h = st(e).hook;
        const b = c.body;
        const next = { ...h };
        if (b.url !== undefined) next.url = b.url === null ? null : hookUrl(b.url);
        if (b.signing_secret !== undefined) {
          if (b.signing_secret !== null && (typeof b.signing_secret !== 'string' || b.signing_secret.length < 16 || b.signing_secret.length > 512)) throw bad('signing_secret is 16 to 512 characters.', 'signing_secret');
          next.signing_secret = b.signing_secret;
        }
        if (b.timeout_ms !== undefined) {
          if (!Number.isInteger(b.timeout_ms) || b.timeout_ms < 500 || b.timeout_ms > 5000) throw bad('timeout_ms is 500 to 5000.', 'timeout_ms');
          next.timeout_ms = b.timeout_ms;
        }
        if (b.enabled !== undefined) {
          if (typeof b.enabled !== 'boolean') throw bad('enabled is true or false.', 'enabled');
          next.enabled = b.enabled;
        }
        if (next.enabled && (!next.url || next.signing_secret === null)) throw bad('Turning the hook on needs a url and a signing_secret.', 'enabled');
        Object.assign(h, next, { updated_at: e.clock.now() });
        return { body: hookView(h) };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/instance/hooks/before_first_session',
      handler: (c) => {
        const h = st(c.engine).hook;
        Object.assign(h, freshHook(), { timeout_ms: h.timeout_ms, updated_at: c.engine.clock.now() });
        return { body: hookView(h) };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/instance/hooks/before_first_session/test',
      handler: async (c) => {
        const e = c.engine;
        const h = st(e).hook;
        if (!h.url || h.signing_secret === null) return { body: { ok: false, status: 'failed', http_status: null, latency_ms: null, error: { code: 'not_configured', message: 'Set a url and signing_secret first.' } } };
        // The sample call goes through the engine's fetch, so a test can answer it; an unreachable endpoint reports `error`.
        const started = e.clock.now();
        let httpStatus: number | null = null;
        let answer: Obj | undefined;
        let error: Obj | undefined;
        try {
          const res = await (e.options.fetch ?? fetch)(h.url, { method: 'POST', headers: { 'content-type': 'application/json', 'atlas-id': e.db.newId('msg'), 'atlas-timestamp': String(Math.floor(started / 1000)) }, body: JSON.stringify({ type: 'before_first_session', data: { user_id: 'user_sample', email: 'sample@example.com', email_verified: true, provider: 'password', provider_user_id: null, name: null, external_id: null } }), signal: AbortSignal.timeout(h.timeout_ms) });
          httpStatus = res.status;
          const text = await res.text();
          try {
            const j = text ? JSON.parse(text) : {};
            if (res.ok && isObj(j) && (j.external_id === undefined || j.external_id === null || typeof j.external_id === 'string')) answer = { external_id: (j.external_id as string | null | undefined) ?? null };
            else error = { code: 'invalid_response', message: res.ok ? 'The answer is not {"external_id": string | null}.' : `The hook answered ${res.status}.` };
          } catch {
            error = { code: 'invalid_response', message: 'The answer is not JSON.' };
          }
        } catch (err) {
          error = { code: (err as Error).name === 'TimeoutError' ? 'timeout' : 'error', message: (err as Error).message };
        }
        const ok = !error;
        h.last_call = { at: e.clock.now(), status: ok ? 'ok' : (error!.code as string), error: ok ? null : (error!.message as string) };
        return { body: { ok, status: ok ? 'success' : 'failed', http_status: httpStatus, latency_ms: Math.max(0, e.clock.now() - started), ...(answer ? { answer } : {}), ...(error ? { error } : {}) } };
      },
    },
  ];
}

// ── sign-up forwarding, integration health, issuers, cookie consent ──

const forwardingView = (f: Obj): Obj => ({ object: 'integration_forwarding', forwarding: f.forwarding, event: eventsOf(f.forwarding)[0], events: eventsOf(f.forwarding), id: f.id, active: f.active, ...(f.site_key ? { site_key: f.site_key } : {}), ...(f.site_url ? { site_url: f.site_url } : {}), ...(f.host ? { host: f.host } : {}), ...(f.conversion_event ? { conversion_event: f.conversion_event } : {}), ...(f.include_pii !== undefined ? { include_pii: f.include_pii } : {}), ...(f.url ? { url: f.url } : {}), ...(f.endpoint ? { endpoint: f.endpoint } : {}) });

function destinationOf(c: { params: Record<string, string | undefined> }): string {
  const d = c.params.destination;
  if (!d || !DESTINATIONS.includes(d)) throw bad(`destination is one of ${DESTINATIONS.join(', ')}.`, 'destination');
  return d;
}

const endpointState = (ep: Obj): string => (ep.active === false ? 'disabled' : (ep.consecutive_failures ?? 0) > 0 ? 'failing' : ep.last_success_at ? 'healthy' : 'no_deliveries');

function integrationRoutes(): RouteDef[] {
  const FIELDS = ['server_key', 'site_key', 'site_url', 'host', 'conversion_event', 'include_pii', 'url', 'endpoint', 'active'];
  return [
    {
      method: 'PUT',
      pattern: '/v1/instance/integrations/forwarding/:destination',
      handler: (c) => {
        const e = c.engine;
        const dest = destinationOf(c);
        const b = c.body;
        const unknown = Object.keys(b).find((k) => !FIELDS.includes(k));
        if (unknown) throw bad(`Unrecognised field ${unknown}. Expected any of ${FIELDS.join(', ')}.`, unknown);
        const prior = st(e).forwarding.get(dest);
        if (dest === 'webhook') {
          const url = b.url ?? prior?.url;
          if (typeof url !== 'string' || !url.startsWith('https://')) throw bad('webhook forwarding needs an https url.', 'url');
        } else if (!prior && typeof b.server_key !== 'string') throw bad(`${dest} forwarding needs server_key.`, 'server_key');
        if (b.endpoint !== undefined && dest !== 'watchtower') throw bad('endpoint is for watchtower forwarding.', 'endpoint');
        if (dest === 'watchtower') {
          const endpoint = b.endpoint ?? prior?.endpoint;
          if (typeof endpoint !== 'string' || !endpoint.startsWith('https://')) throw bad('watchtower forwarding needs endpoint, your https ingest host.', 'endpoint');
        }
        if (dest === 'seolyticize' && typeof (b.site_key ?? prior?.site_key) !== 'string') throw bad('seolyticize forwarding needs site_key.', 'site_key');
        if (b.conversion_event !== undefined && (dest !== 'seolyticize' || !['user.created', 'user.attributed'].includes(b.conversion_event))) throw bad('conversion_event is user.created or user.attributed, for seolyticize.', 'conversion_event');
        for (const k of ['include_pii', 'active']) if (b[k] !== undefined && typeof b[k] !== 'boolean') throw bad(`${k} is true or false.`, k);
        const row: Obj = { ...(prior ?? { forwarding: dest, active: true }), ...Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'server_key')) };
        if (b.server_key !== undefined) row.has_key = true; // the key is write-only: never stored in a readable field
        let secret: string | undefined;
        if (dest === 'webhook') {
          // A real webhook endpoint, so deliveries, retries and health behave as for any endpoint.
          if (prior) {
            const ep = e.db.endpoints.get(prior.id);
            if (ep) Object.assign(ep, { url: row.url, active: row.active !== false });
          } else {
            secret = e.webhooks.newSecret();
            row.id = e.db.endpoints.insert({ url: row.url, description: 'Sign-up forwarding', enabled_events: ['user.created'], active: row.active !== false, event_naming: 'canonical', secret, consecutive_failures: 0, managed_by: 'forwarding', created_at: e.clock.now() } as any).id;
          }
        } else row.id ??= e.db.newId('whep');
        st(e).forwarding.set(dest, row);
        return { status: prior ? 200 : 201, body: { ...forwardingView(row), created: !prior, ...(secret ? { secret } : {}) } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/instance/integrations/forwarding/:destination',
      handler: (c) => {
        const f = st(c.engine).forwarding.get(destinationOf(c));
        if (!f) throw notFound('Sign-up forwarding');
        return { body: forwardingView(f) };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/instance/integrations/forwarding/:destination',
      handler: (c) => {
        const e = c.engine;
        const dest = destinationOf(c);
        const f = st(e).forwarding.get(dest);
        if (!f) throw notFound('Sign-up forwarding');
        if (dest === 'webhook') e.db.endpoints.delete(f.id);
        st(e).forwarding.delete(dest);
        return { status: 204 };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/instance/integrations/health',
      handler: (c) => {
        const e = c.engine;
        const rows: Obj[] = e.db.endpoints.all().map((ep) => ({
          kind: 'webhook_endpoint', id: ep.id, name: ep.description ?? null, url: ep.url, managed_by: ep.managed_by ?? null, destination: 'https', state: endpointState(ep),
          last_success_at: ep.last_success_at ?? null, last_failure: ep.last_failure ?? null, consecutive_failures: ep.consecutive_failures ?? 0,
        }));
        for (const f of st(e).forwarding.values()) {
          if (f.forwarding === 'webhook') continue;
          rows.push({ kind: 'webhook_endpoint', id: f.id, name: `Sign-ups to ${f.forwarding}`, url: null, managed_by: 'forwarding', destination: f.forwarding, state: f.active ? 'no_deliveries' : 'disabled', last_success_at: null, last_failure: null, consecutive_failures: 0 });
        }
        return { body: { object: 'list', data: rows, has_more: false, unhealthy_count: rows.filter((r) => r.state === 'failing' || r.state === 'disabled').length, generated_at: e.clock.now() } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/instance/issuers',
      handler: (c) => ({ body: { active: c.engine.issuer, planned: null, previous: [], jwks_uri: `${c.engine.issuer}/.well-known/jwks.json` } }),
    },
    {
      method: 'PATCH',
      pattern: '/v1/instance/cookie_consent',
      handler: (c) => {
        const e = c.engine;
        const key = '/v1/instance/cookie_consent';
        const stored = e.singletons.get(key);
        const b = c.body;
        if (!stored && typeof b.script_url !== 'string') throw bad('With no stored setting, script_url is required.', 'script_url');
        const next: Obj = { ...(stored ?? { enabled: true }) };
        for (const [k, v] of Object.entries(b)) {
          if (v === null) delete next[k];
          else next[k] = v;
        }
        // The two ways to name a site replace each other.
        if (b.site_id !== undefined && b.site === undefined) delete next.site;
        if (b.site !== undefined && b.site_id === undefined) delete next.site_id;
        for (const u of [next.script_url, ...(Array.isArray(next.extra_origins) ? next.extra_origins : [])]) if (u !== undefined && !String(u).startsWith('https://')) throw bad('script_url and extra_origins entries are https URLs.', 'script_url');
        e.singletons.set(key, next);
        return { body: { object: 'cookie_consent', enabled: true, source: 'manual', source_integration: null, extra_origins: [], host_aliases: [], ...next, warnings: [] } };
      },
    },
  ];
}

// ── message links, dead-letter queue, analytics ──

function messagingRoutes(): RouteDef[] {
  const windowOf = (e: Engine, q: URLSearchParams): Obj => {
    const t = (v: string | null): number | null => (v === null ? null : /^\d+$/.test(v) ? Number(v) : Date.parse(v));
    const to = t(q.get('to')) ?? e.clock.now();
    const days = Math.min(180, Math.max(1, Number(q.get('days') ?? 30) || 30));
    const from = t(q.get('from')) ?? to - days * DAY;
    if (Number.isNaN(from) || Number.isNaN(to)) throw bad('from and to are epoch milliseconds or ISO 8601 times.', 'from');
    const granularity = q.get('granularity') ?? 'day';
    if (!['day', 'week', 'month'].includes(granularity)) throw bad('granularity is day, week or month.', 'granularity');
    return { from, to, granularity, organization_id: q.get('organization_id') };
  };
  // shortcut: the country comes from the calling code of the number (a handful of codes); everything else is "ZZ".
  const COUNTRY: Array<[string, string]> = [['+44', 'GB'], ['+49', 'DE'], ['+33', 'FR'], ['+61', 'AU'], ['+91', 'IN'], ['+1', 'US']];
  const countryOf = (to: string): string => COUNTRY.find(([p]) => to.startsWith(p))?.[1] ?? 'ZZ';
  return [
    {
      method: 'POST',
      pattern: '/v1/message_links',
      handler: async (c) => {
        const e = c.engine;
        const { email, type, category } = c.body;
        if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('email is an address.', 'email');
        if (type !== 'unsubscribe' && type !== 'preferences') throw bad('type is unsubscribe or preferences.', 'type');
        if (type === 'unsubscribe' && (typeof category !== 'string' || category === '')) throw bad('An unsubscribe link needs a category.', 'category');
        if (type === 'preferences' && category !== undefined) throw bad('A preferences link takes no category.', 'category');
        const token = await e.tokens.signClaims({ sub: email.toLowerCase(), link: type, ...(category ? { category } : {}) }, 30 * 86_400);
        return { status: 201, body: { object: 'message_link', type, url: `${e.issuer}/m/${type}?t=${token}` } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/webhook_dlq',
      handler: (c) => {
        const e = c.engine;
        const max = (e.options.webhookRetryDelaysMs ?? [1000, 5000, 30000]).length + 1;
        const types = c.query.get('event_type')?.split(',').map((s) => s.trim()).filter(Boolean);
        const events = new Map(e.webhooks.events.map((ev) => [ev.id, ev]));
        const rows = e.webhooks.deliveries
          .filter((d) => !d.success && d.attempt >= max && (!types || types.includes(d.event_type)))
          .reverse()
          .map((d) => ({ id: d.id, object: 'webhook_delivery', endpoint_id: d.endpoint_id, event_id: d.event_id, event_type: d.event_type, attempts: d.attempt, response_status: d.response_status ?? null, error: d.error ?? null, payload: (events.get(d.event_id) as any)?.payload?.data ?? null, failed_at: d.at }));
        const page = pageReply(c, rows);
        return { body: { ...page, max_attempts: max, retention: { days: 30 } } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/analytics/captcha',
      handler: (c) => {
        // shortcut: the emulator never issues a captcha challenge, so there are no rows; the envelope and totals are the real ones.
        const w = windowOf(c.engine, c.query);
        return { body: { object: 'analytics_captcha', window: w, issued: 0, passed: 0, failed: 0, blocked: 0, solve_rate: 0, data: [] } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/analytics/sms',
      handler: (c) => {
        const e = c.engine;
        const w = windowOf(e, c.query);
        const rate = c.query.get('rate_per_message');
        if (rate !== null && (!Number.isFinite(Number(rate)) || Number(rate) < 0 || Number(rate) > 1000)) throw bad('rate_per_message is a number from 0 to 1000.', 'rate_per_message');
        const by = new Map<string, { messages: number; delivered: number; failed: number }>();
        for (const m of e.messages.messages.filter((x) => x.channel === 'sms' && Date.parse(x.at) >= w.from && Date.parse(x.at) < w.to)) {
          const row = by.get(countryOf(m.to)) ?? { messages: 0, delivered: 0, failed: 0 };
          row.messages++;
          if ((m.meta as any)?.undelivered) row.failed++;
          else row.delivered++;
          by.set(countryOf(m.to), row);
        }
        const data = [...by.entries()].map(([country, r]) => ({ country, ...r, ...(rate !== null ? { estimated_cost: r.messages * Number(rate) } : {}) }));
        return { body: { object: 'analytics_sms', window: w, total: data.reduce((n, r) => n + r.messages, 0), ...(c.query.get('currency') ? { currency: c.query.get('currency') } : {}), data } };
      },
    },
  ];
}

// ── connections: provider policies, templates, rehome ──

const TEMPLATES: Obj[] = [
  { provider: 'discogs', name: 'Discogs', kind: 'oauth1', flow: 'connect', secrets: [], config: { signature_method: 'HMAC-SHA1' }, allowed_hosts: ['api.discogs.com'], host_params: [], signature: 'oauth1', note: 'The owner authorizes in a browser.' },
  { provider: 'trademe', name: 'Trade Me', kind: 'oauth1', flow: 'connect', secrets: [], config: { signature_method: 'PLAINTEXT' }, allowed_hosts: ['api.trademe.co.nz'], host_params: [], signature: 'oauth1', note: 'The owner authorizes in a browser.' },
  { provider: 'bricklink', name: 'BrickLink', kind: 'oauth1', flow: 'credentials', secrets: ['consumer_key', 'consumer_secret', 'token', 'token_secret'], config: { signature_method: 'HMAC-SHA1' }, allowed_hosts: ['api.bricklink.com'], host_params: [], signature: 'oauth1', note: 'Enter the four keys from the BrickLink API console.' },
  { provider: 'cardmarket', name: 'Cardmarket', kind: 'oauth1', flow: 'credentials', secrets: ['app_token', 'app_secret', 'access_token', 'access_secret'], config: { signature_method: 'HMAC-SHA1', realm: 'https://api.cardmarket.com' }, allowed_hosts: ['api.cardmarket.com'], host_params: [], signature: 'oauth1', note: 'Enter the app and access tokens.' },
  { provider: 'woocommerce', name: 'WooCommerce', kind: 'basic', flow: 'credentials', secrets: ['username', 'password'], config: {}, allowed_hosts: [], host_params: ['store_host'], signature: 'none', note: 'Enter the REST consumer key and secret; the store host is a host parameter.' },
  { provider: 'bonanza', name: 'Bonanza', kind: 'api_key', flow: 'credentials', secrets: ['api_key'], config: { placement: 'header', name: 'X-BONANZLE-API-DEV-NAME' }, allowed_hosts: ['api.bonanza.com'], host_params: [], signature: 'none', note: 'Enter the developer key.' },
  { provider: 'poizon', name: 'Poizon', kind: 'api_key', flow: 'credentials', secrets: ['api_key'], config: { placement: 'header', name: 'x-api-key' }, allowed_hosts: ['open.poizon.com'], host_params: [], signature: 'none', note: 'Enter the open platform key.' },
  { provider: 'browser_session', name: 'Browser session cookie jar', kind: 'cookie_jar', flow: 'credentials', secrets: ['cookies'], config: {}, allowed_hosts: [], host_params: ['host'], signature: 'none', note: 'Paste the cookie jar of a signed-in browser session.' },
];

const SELF_SERVE_EVENTS = new Set(['shopify', 'bigcommerce', 'wix', 'square', 'ebay']);
const policyView = (e: Engine, provider: string, p: Obj | undefined): Obj => ({ object: 'connection_provider_policy', provider, unique_external_id: p?.unique_external_id === true, has_webhook_secret: !!p?.webhook_secret, ...(provider === 'ebay' ? { has_dev_id: !!p?.dev_id } : {}), events_url: SELF_SERVE_EVENTS.has(provider) ? `${e.issuer}/v1/connection_provider_events/${e.instanceId}/${provider}` : null, updated_at: p?.updated_at ?? null });

function connectionRoutes(): RouteDef[] {
  return [
    {
      method: 'GET',
      pattern: '/v1/connection_providers/policies',
      handler: (c) => ({ body: listOf([...st(c.engine).policies.entries()].map(([prov, p]) => policyView(c.engine, prov, p))) }),
    },
    {
      method: 'GET',
      pattern: '/v1/connection_providers/:provider/policy',
      handler: (c) => ({ body: policyView(c.engine, c.params.provider!, st(c.engine).policies.get(c.params.provider!)) }),
    },
    {
      method: 'PUT',
      pattern: '/v1/connection_providers/:provider/policy',
      handler: (c) => {
        const e = c.engine;
        const b = c.body;
        if (b.unique_external_id !== undefined && typeof b.unique_external_id !== 'boolean') throw bad('unique_external_id is true or false.', 'unique_external_id');
        for (const k of ['webhook_secret', 'dev_id']) if (b[k] !== undefined && b[k] !== null && typeof b[k] !== 'string') throw bad(`${k} is a string or null.`, k);
        const p = { ...(st(e).policies.get(c.params.provider!) ?? {}) };
        for (const k of ['unique_external_id', 'webhook_secret', 'dev_id']) if (b[k] !== undefined) p[k] = b[k];
        p.updated_at = e.clock.now();
        st(e).policies.set(c.params.provider!, p);
        return { body: policyView(e, c.params.provider!, p) };
      },
    },
    { method: 'GET', pattern: '/v1/connection_templates', handler: () => ({ body: listOf(TEMPLATES.map((t) => ({ object: 'connection_template', ...t }))) }) },
    {
      method: 'POST',
      pattern: '/v1/connections/rehome',
      handler: (c) => {
        const e = c.engine;
        const b = c.body;
        const unknown = Object.keys(b).find((k) => !['from_client', 'to_client', 'connection_ids', 'dry_run', 'verify'].includes(k));
        if (unknown) throw bad(`Unrecognised field ${unknown}.`, unknown);
        if (typeof b.from_client !== 'string' || typeof b.to_client !== 'string') throw bad('from_client and to_client are OAuth client ids.', 'from_client');
        if (b.from_client === b.to_client) throw bad('from_client and to_client are the same client.', 'to_client');
        const only = b.connection_ids === undefined ? null : strList(b.connection_ids, 'connection_ids', 1, 1000);
        const clients = e.generic.get('connections/oauth_clients');
        // shortcut: the emulator keeps no provider clients, so a client id is checked only when the client table exists, and two clients are "the same provider app" when their client_id match.
        const from = clients?.get(b.from_client);
        const to = clients?.get(b.to_client);
        if (clients && (!from || !to)) throw notFound('OAuth client');
        if (from && to && (from.provider !== to.provider || (from.environment ?? 'production') !== (to.environment ?? 'production'))) throw bad('Both clients must be the same provider and environment.', 'to_client');
        if (to && to.enabled === false) throw bad('to_client is disabled.', 'to_client');
        const sameApp = !!from && !!to && from.client_id === to.client_id;
        const verify = b.verify !== false;
        if (!verify && !sameApp) throw bad('verify: false is accepted only when both clients are the same provider app.', 'verify');
        const dry = b.dry_run === true;
        const table = e.generic.get('connections');
        const rows = (table?.all() ?? []).filter((x) => x.oauth_client_id === b.from_client && (!only || only.includes(x.id))).slice(0, 1000);
        const data: Obj[] = [];
        for (const id of only ?? []) if (!rows.some((r) => r.id === id)) data.push({ connection_id: id, status: 'skipped', reason: 'not_connected_to_from_client' });
        for (const r of rows) {
          if (r.status === 'revoked' || r.status === 'needs_reauth') data.push({ connection_id: r.id, status: 'skipped', reason: r.status === 'revoked' ? 'revoked' : 'needs_reauth' });
          else if (dry) data.push({ connection_id: r.id, status: sameApp ? 'would_move' : 'would_verify' });
          else {
            r.oauth_client_id = b.to_client;
            data.push({ connection_id: r.id, status: 'moved' });
          }
        }
        const n = (s: string) => data.filter((d) => d.status === s).length;
        return { body: { object: 'connection_rehome', from_client: b.from_client, to_client: b.to_client, dry_run: dry, same_app: sameApp, moved: n('moved'), would_move: n('would_move') + n('would_verify'), failed: n('failed'), skipped: n('skipped'), data } };
      },
    },
  ];
}

// ── legacy session import ──

function migrationRoutes(): RouteDef[] {
  const ROW_FIELDS = ['token', 'token_hash', 'user_id', 'external_id', 'expires_at', 'mfa_verified'];
  return [
    {
      method: 'POST',
      pattern: '/v1/migrations/:source/sessions',
      handler: async (c) => {
        const e = c.engine;
        const source = c.params.source!;
        if (!/^[a-z][a-z0-9_-]{0,39}$/.test(source)) throw bad('source is a lowercase slug.', 'source');
        const rows = c.body.sessions;
        if (!Array.isArray(rows) || rows.length < 1 || rows.length > 1000) throw bad('sessions is a list of 1 to 1000 rows.', 'sessions');
        if (c.body.dry_run !== undefined && typeof c.body.dry_run !== 'boolean') throw bad('dry_run is true or false.', 'dry_run');
        const dry = c.body.dry_run === true;
        const store = st(e).legacy.get(source) ?? new Map<string, Obj>();
        const errors: Obj[] = [];
        let imported = 0;
        for (const [index, r] of rows.entries()) {
          const fail = (code: string, message: string) => errors.push({ index, code, message });
          if (!isObj(r)) { fail('invalid_row', 'A row is an object.'); continue; }
          const extra = Object.keys(r).find((k) => !ROW_FIELDS.includes(k));
          if (extra) { fail('unknown_field', `Unrecognised field ${extra}.`); continue; }
          if ((r.token === undefined) === (r.token_hash === undefined)) { fail('invalid_row', 'Send exactly one of token or token_hash.'); continue; }
          if ((r.user_id === undefined) === (r.external_id === undefined)) { fail('invalid_row', 'Send exactly one of user_id or external_id.'); continue; }
          const at = typeof r.expires_at === 'number' ? r.expires_at : Date.parse(String(r.expires_at));
          if (Number.isNaN(at)) { fail('invalid_row', 'expires_at is an ISO 8601 time or Unix milliseconds.'); continue; }
          if (at <= e.clock.now()) { fail('session_expired', 'The legacy session has already ended.'); continue; }
          const user = e.db.users.find((u) => !u.deleted && (r.user_id !== undefined ? u.id === r.user_id : u.external_id === r.external_id));
          if (!user) { fail('user_not_found', 'No such user.'); continue; }
          const hash = typeof r.token_hash === 'string' ? r.token_hash.toLowerCase() : await hex(String(r.token));
          if (!/^[0-9a-f]{64}$/.test(hash)) { fail('invalid_row', 'token_hash is SHA-256 hex.'); continue; }
          if (store.get(hash)?.exchanged) { fail('already_exchanged', 'This session was already exchanged.'); continue; }
          imported++;
          if (!dry) store.set(hash, { user_id: user.id, expires_at: at, mfa_verified: r.mfa_verified === true, exchanged: false });
        }
        if (!dry) st(e).legacy.set(source, store);
        return { body: { object: 'migration_session_import', source, dry_run: dry, received: rows.length, imported, failed: errors.length, errors, bridge_mode: null } };
      },
    },
  ];
}

// ── grants (consent and OpenID Grant Management) ──

const NO_META: Obj = {};
function grantRoutes(): RouteDef[] {
  const all = (e: Engine): Obj[] => {
    const meta = (id: string): Obj => st(e).metadata.get(id) ?? NO_META;
    const managed = [...adv(e).managed.values()].map((m) => {
      const client = e.db.oauthClients.get(m.clientId);
      return { object: 'grant', id: m.id, type: 'managed', client_id: m.clientId, client_name: client?.name ?? null, user_id: m.userId, organization_id: null, status: m.status, scopes: m.scopes, resource: null, authorization_details: m.details, revision: m.revision, metadata: meta(m.id), created_at: m.createdAt, updated_at: m.updatedAt, last_used_at: null, revoked_at: m.status === 'revoked' ? m.updatedAt : null, revoked_by: m.status === 'revoked' ? 'admin' : null };
    });
    const consent = consentGrants(e).map((g) => {
      const id = g.id;
      const client = e.db.oauthClients.get(g.clientId);
      return { object: 'grant', id, type: 'consent', client_id: g.clientId, client_name: client?.name ?? null, user_id: g.userId, organization_id: g.organizationId, remembered: g.remembered, status: 'active', scopes: [...g.scopes], resource: null, authorization_details: null, metadata: meta(id), created_at: g.at, updated_at: g.at, last_used_at: null, revoked_at: null, revoked_by: null };
    });
    return [...managed, ...consent].sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1));
  };
  const one = (e: Engine, id: string | undefined): Obj => {
    const g = all(e).find((x) => x.id === id);
    if (!g) throw notFound('Grant');
    return g;
  };
  return [
    {
      method: 'GET',
      pattern: '/v1/grants',
      handler: (c) => {
        const q = c.query;
        const type = q.get('type') ?? 'all';
        const status = q.get('status') ?? 'active';
        if (!['consent', 'managed', 'all'].includes(type)) throw bad('type is consent, managed or all.', 'type');
        if (!['active', 'revoked', 'all'].includes(status)) throw bad('status is active, revoked or all.', 'status');
        const rows = all(c.engine).filter((g) => (type === 'all' || g.type === type) && (status === 'all' || g.status === status) && (!q.get('user_id') || g.user_id === q.get('user_id')) && (!q.get('client_id') || g.client_id === q.get('client_id')));
        return { body: pageReply(c, rows) };
      },
    },
    { method: 'GET', pattern: '/v1/grants/:id', handler: (c) => ({ body: one(c.engine, c.params.id) }) },
    {
      // Revoke one consent. Another organization's consent for the same app stands (only this organization's tokens end);
      // the last consent of the pair ends every token that is left.
      method: 'DELETE',
      pattern: '/v1/grants/:id',
      handler: (c) => {
        const e = c.engine;
        const g = one(e, c.params.id);
        const hold = consentHoldById(e, c.params.id);
        if (g.type !== 'consent' || !hold) throw bad('Only a consent grant is revoked here; revoke a managed grant through the grant-management API.', 'id');
        const onlyOrg = hold.organizationId && pairHolds(e, hold.userId, hold.clientId).some((h) => h.id !== hold.id) ? hold.organizationId : undefined;
        let revoked = 0;
        for (const t of oauthSt(e).grants.values()) {
          if (t.clientId !== hold.clientId || t.userId !== hold.userId || t.revoked || (onlyOrg !== undefined && (t.organizationId ?? null) !== onlyOrg)) continue;
          revokeGrant(e, t);
          revoked++;
          e.webhooks.emit('grant.revoked', { ...grantEvent(e, { id: t.id, userId: hold.userId, clientId: hold.clientId, organizationId: t.organizationId ?? null, scopes: new Set(t.scope), at: hold.at }), session_ids: [] });
        }
        removeConsentHold(e, hold);
        return { body: { object: 'grant', id: g.id, type: 'consent', deleted: true, tokens_revoked: revoked } };
      },
    },
    {
      method: 'PATCH',
      pattern: '/v1/grants/:id',
      handler: (c) => {
        const e = c.engine;
        const g = one(e, c.params.id);
        const patch = c.body.metadata;
        if (!isObj(patch)) throw bad('metadata is an object.', 'metadata');
        const next = { ...g.metadata } as Obj;
        for (const [k, v] of Object.entries(patch)) {
          if (v === null) delete next[k];
          else next[k] = v;
        }
        if (canonical(next).length > 4096) throw bad('metadata is at most 4 KB of JSON.', 'metadata');
        st(e).metadata.set(g.id, next);
        return { body: { ...g, metadata: next } };
      },
    },
  ];
}

// ── users: risk signals, deleted, deletion, security summary, delegation tokens, upsert ──

const SEVERITY_POINTS: Record<string, number> = { low: 10, medium: 25, high: 50, critical: 100 };
export const signalTable = (e: Engine): Table => {
  let t = e.generic.get('risk_signals');
  if (!t) e.generic.set('risk_signals', (t = new Table('risk_signals', e.clock.now, 'risk')));
  return t;
};
export const signalView = (e: Engine, r: Obj): Obj => ({ ...r, status: r.revoked_at ? 'revoked' : r.expires_at <= e.clock.now() ? 'expired' : 'active' });
const liveUser = (e: Engine, id: string | undefined): Obj => {
  const u = e.db.users.get(id);
  if (!u || u.deleted) throw notFound('User');
  return u;
};

const delegationSettings = (e: Engine): Obj => e.singletons.get('/__emulator/delegation_tokens') ?? {};

function userRoutes(): RouteDef[] {
  return [
    {
      method: 'POST',
      pattern: '/v1/users/:id/risk_signals',
      handler: (c) => {
        const e = c.engine;
        const u = liveUser(e, c.params.id);
        const b = c.body;
        if (typeof b.signal_type !== 'string' || !/^[a-z0-9_.:-]{1,64}$/.test(b.signal_type)) throw bad('signal_type is lowercase letters, digits and _ . : - (up to 64).', 'signal_type');
        if (typeof b.severity !== 'string' || !(b.severity in SEVERITY_POINTS)) throw bad('severity is low, medium, high or critical.', 'severity');
        const ttl = b.ttl_seconds === undefined ? 3600 : b.ttl_seconds;
        if (!Number.isInteger(ttl) || ttl < 60 || ttl > 2_592_000) throw bad('ttl_seconds is 60 to 2592000.', 'ttl_seconds');
        if (b.metadata !== undefined && (!isObj(b.metadata) || canonical(b.metadata).length > 2048)) throw bad('metadata is an object of at most 2 KB.', 'metadata');
        if (b.source !== undefined && (typeof b.source !== 'string' || b.source.length > 64)) throw bad('source is at most 64 characters.', 'source');
        const now = e.clock.now();
        const row = signalTable(e).insert({ object: 'risk_signal', subject: { type: 'user', value: u.id }, signal_type: b.signal_type, severity: b.severity, source: b.source ?? 'api', metadata: b.metadata ?? {}, expires_at: now + ttl * 1000, revoked_at: null, status: 'active', created_at: now } as any);
        e.webhooks.emit('risk_signal.created', { object: 'risk_signal', id: row.id, subject: row.subject, signal_type: row.signal_type, severity: row.severity, expires_at: row.expires_at });
        return { status: 201, body: signalView(e, row) };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/users/:id/risk_signals',
      handler: (c) => {
        const e = c.engine;
        const u = liveUser(e, c.params.id);
        const status = c.query.get('status') ?? 'all';
        if (status !== 'active' && status !== 'all') throw bad('status is active or all.', 'status');
        const limit = Math.min(200, Math.max(1, Number(c.query.get('limit') ?? 50) || 50));
        const before = c.query.get('before');
        const rows = signalTable(e).all().filter((r) => r.subject?.type === 'user' && r.subject.value === u.id && (!before || r.created_at < Number(before))).map((r) => signalView(e, r)).filter((r) => status === 'all' || r.status === 'active');
        const data = rows.slice(0, limit);
        const more = rows.length > data.length;
        return { body: { object: 'list', data, has_more: more, next_cursor: more ? String(data[data.length - 1]!.created_at) : null } };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/users/:id/risk_signals',
      handler: (c) => {
        const e = c.engine;
        const u = liveUser(e, c.params.id);
        const live = signalTable(e).all().filter((r) => r.subject?.type === 'user' && r.subject.value === u.id && signalView(e, r).status === 'active');
        for (const r of live) r.revoked_at = e.clock.now();
        return { body: { object: 'risk_signals_cleared', user_id: u.id, cleared: live.length } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/users/deleted',
      handler: (c) => {
        const e = c.engine;
        const raw = c.query.get('since');
        if (!raw) throw bad('since is required: Unix milliseconds or an ISO 8601 time.', 'since');
        const since = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
        if (Number.isNaN(since)) throw bad('since is Unix milliseconds or an ISO 8601 time.', 'since');
        const limit = Math.min(500, Math.max(1, Number(c.query.get('limit') ?? 100) || 100));
        const after = c.query.get('starting_after');
        const rows = e.db.users.all().filter((u) => u.deleted && (u.deleted_at ?? u.updated_at) >= since).sort((a, b) => (a.deleted_at ?? a.updated_at) - (b.deleted_at ?? b.updated_at) || (a.id < b.id ? -1 : 1));
        const start = after ? rows.findIndex((u) => u.id === after) + 1 : 0;
        const data = rows.slice(start, start + limit).map((u) => ({ object: 'deleted_user', id: u.id, external_id: u.external_id ?? null, deleted_at: u.deleted_at ?? u.updated_at }));
        const more = start + limit < rows.length;
        return { body: { object: 'list', data, has_more: more, next_cursor: more ? data[data.length - 1]!.id : null } };
      },
    },
    {
      method: 'PATCH',
      pattern: '/v1/users/:id/deletion',
      handler: (c) => {
        const e = c.engine;
        const u = liveUser(e, c.params.id);
        const { effective_at: at, grace_seconds: grace } = c.body;
        if ((at === undefined) === (grace === undefined)) throw bad('Send exactly one of effective_at or grace_seconds.', 'effective_at');
        const now = e.clock.now();
        const when = at !== undefined ? Date.parse(String(at)) : now + Number(grace) * 1000;
        if (Number.isNaN(when) || (grace !== undefined && (typeof grace !== 'number' || grace < 0))) throw bad('effective_at is an ISO 8601 time; grace_seconds a non-negative number.', 'effective_at');
        if (when < now) throw bad('The new date is not in the past.', 'effective_at');
        const req = dsrRows(e).find((r) => r.user_id === u.id && r.type === 'erasure' && r.status === 'scheduled');
        if (!req) throw new EmulatorError('CONFLICT', 'This user has no scheduled deletion to move.');
        req.scheduled_for = when;
        req.updated_at = now;
        e.webhooks.emit('user.deletion_rescheduled', { object: 'user', id: u.id, primary_email_address_id: u.primary_email_address_id ?? null, deletion_effective_at: when, data_subject_request_id: req.id });
        return { body: { ...presentUser(e, u), deletion_effective_at: when } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/users/:id/security_summary',
      handler: (c) => {
        const e = c.engine;
        const u = liveUser(e, c.params.id);
        const keys = e.db.passkeys.filter((p) => p.user_id === u.id);
        const sessions = e.db.sessions.filter((s) => s.user_id === u.id && s.status === 'active');
        const latest = [...sessions].sort((a, b) => b.last_active_at - a.last_active_at)[0];
        const verifiedEmail = (u.emails as Obj[]).some((m) => m.verified);
        const methods = [...(u.has_password ? ['password'] : []), ...(keys.length ? ['passkey'] : []), ...(verifiedEmail ? ['email_code', 'email_link'] : [])];
        return { body: {
          object: 'security_summary', user_id: u.id, password_enabled: u.has_password === true, password_changed_at: u.has_password ? (u.password_changed_at ?? u.created_at) : null, mfa_enabled: false, has_passkey: keys.length > 0, sign_in_methods: methods,
          linked_providers: ((u.external_accounts as Obj[] | undefined) ?? []).map((a) => ({ id: a.id, provider: a.provider, provider_user_id: a.provider_user_id, email_address: a.email_address ?? null, email_verified: a.email_verified === true })),
          mfa_factors: [], backup_codes_remaining: null,
          passkeys: keys.map((p) => ({ id: p.id, name: p.name ?? null, created_at: p.created_at, last_used_at: p.last_used_at ?? null })),
          trusted_devices: [],
          active_sessions: { count: sessions.length, latest: latest ? { id: latest.id, last_active_at: latest.last_active_at, ip_address: latest.ip_address ?? null } : null },
        } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/users/:id/delegation_tokens',
      handler: async (c) => {
        const e = c.engine;
        const u = liveUser(e, c.params.id);
        const b = c.body;
        const cfg = delegationSettings(e);
        if (cfg.enabled !== true) throw new EmulatorError('FORBIDDEN', 'Delegation tokens are not enabled for this instance (PUT /__emulator/delegation_tokens).');
        if (typeof b.audience !== 'string') throw bad('audience is the service the token is for.', 'audience');
        const allowed = (cfg.audiences as Obj[] | undefined)?.find((a) => a.audience === b.audience);
        if (!allowed) throw bad(`${b.audience} is not a configured audience.`, 'audience');
        const scopes = strList(b.scopes, 'scopes', 1, 50);
        const bad1 = scopes.find((s) => !(allowed.scopes as string[]).includes(s));
        if (bad1) throw bad(`${bad1} is not allowed for this audience.`, 'scopes');
        if (!isObj(b.actor) || typeof b.actor.sub !== 'string' || b.actor.sub === '') throw bad('actor.sub is who is acting.', 'actor');
        const max = Math.min(300, cfg.maxTtlSeconds ?? 300);
        const ttl = b.ttl_seconds ?? Math.min(max, cfg.defaultTtlSeconds ?? 120);
        if (!Number.isInteger(ttl) || ttl < 1 || ttl > max) throw bad(`ttl_seconds is 1 to ${max}.`, 'ttl_seconds');
        if (b.reason !== undefined && (typeof b.reason !== 'string' || b.reason.length > 500)) throw bad('reason is at most 500 characters.', 'reason');
        if (b.org_id !== undefined && !e.db.memberships.find((m) => m.user_id === u.id && m.organization_id === b.org_id)) throw bad('The user is not a member of that organization.', 'org_id');
        const jti = e.db.newId('jti');
        const actor = { sub: b.actor.sub, ...(b.actor.type ? { type: b.actor.type } : {}) };
        const nowS = Math.floor(e.clock.now() / 1000);
        const token = await e.tokens.signClaims({ sub: u.id, aud: b.audience, scope: scopes.join(' '), act: actor, jti, ...(b.org_id ? { org_id: b.org_id } : {}) }, ttl);
        return { status: 201, body: { object: 'delegation_token', token, token_type: 'Bearer', user_id: u.id, audience: b.audience, scopes, actor, jti, expires_at: new Date((nowS + ttl) * 1000).toISOString(), expires_in: ttl } };
      },
    },
    // Emulator control: switch delegation tokens on and name the audiences, like the instance setting does.
    {
      method: 'PUT',
      pattern: '/__emulator/delegation_tokens',
      public: true,
      handler: (c) => {
        c.engine.singletons.set('/__emulator/delegation_tokens', { enabled: c.body.enabled !== false, audiences: c.body.audiences ?? [], defaultTtlSeconds: c.body.defaultTtlSeconds, maxTtlSeconds: c.body.maxTtlSeconds });
        return { body: { ok: true } };
      },
    },
    {
      method: 'PUT',
      pattern: '/v1/users/by_external_id/:external_id',
      handler: (c): Reply => {
        const e = c.engine;
        const ext = c.params.external_id!;
        const b = c.body;
        const update = (u: Obj): Obj => {
          for (const k of ['first_name', 'last_name', 'image_url']) if (k in b) u[k] = b[k];
          for (const k of ['public_metadata', 'unsafe_metadata', 'private_metadata']) if (isObj(b[k])) u[k] = { ...(u[k] ?? {}), ...b[k] };
          u.updated_at = e.clock.now();
          u.version = (u.version ?? 0) + 1;
          e.changed({ type: 'user.updated', data: presentUser(e, u), resource: 'user', id: u.id, op: 'update' });
          return u;
        };
        const held = e.db.users.find((u) => !u.deleted && u.external_id === ext);
        if (held) return { status: 200, body: presentUser(e, update(held)) };
        if (typeof b.email_address !== 'string') throw bad('email_address is required when the call creates the user.', 'email_address');
        if (b.link_by_verified_email === true) {
          const adopt = e.db.users.find((u) => !u.deleted && !u.external_id && (u.emails as Obj[]).some((m) => m.verified && m.email_address.toLowerCase() === (b.email_address as string).toLowerCase()));
          if (adopt) {
            adopt.external_id = ext;
            return { status: 200, body: presentUser(e, update(adopt)) };
          }
        } else if (emailTaken(e, b.email_address)) throw new EmulatorError('IDENTIFIER_EXISTS', `${b.email_address} is already in use. Send link_by_verified_email to adopt that user.`, 'email_address');
        return { status: 201, body: presentUser(e, createUser(e, { ...b, external_id: ext })) };
      },
    },
  ];
}

export function ndbMiscHandlers(): RouteDef[] {
  return [...nativeAppRoutes(), ...hookRoutes(), ...integrationRoutes(), ...messagingRoutes(), ...connectionRoutes(), ...migrationRoutes(), ...grantRoutes(), ...userRoutes()];
}
