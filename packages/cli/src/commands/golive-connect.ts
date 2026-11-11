import { statSync } from 'node:fs';
import { join } from 'node:path';
import { AtlasApiError } from '@atlasauth/backend';
import type { ConfigHttp } from '../config-http';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { renderTable } from '../output';
import { deserialize } from '../serialize';
import { parseDotenv, productDir } from '../secrets';
import { interpolate } from './config';

/** The partners `atlas golive --connect` knows how to connect. */
export const PARTNERS = ['cookiemunch', 'forumulate', 'chatly', 'referalli'] as const;
export type Partner = (typeof PARTNERS)[number];

/** `--connect a,b`: a subset of the partners, in the order given. */
export function parsePartners(raw: string): Partner[] {
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) throw new CliError(`--connect needs a list such as ${PARTNERS.join(',')}.`);
  for (const id of ids) if (!(PARTNERS as readonly string[]).includes(id)) throw new CliError(`--connect: unknown partner '${id}'. Use any of: ${PARTNERS.join(', ')}.`);
  return [...new Set(ids)] as Partner[];
}

/**
 * Partner keys from a dotenv file (`FORUMULATE_API_KEY=…`, `CHATLY_API_KEY=…` (sent as `chatly_api_key`, so Atlas stores the events secret in Chatly), `COOKIEMUNCH_API_KEY=…`,
 * `REFERALLI_API_KEY=…`; `<PARTNER>_AUDIENCE=…` names an audience for a first connect).
 * A file readable by group or others is refused. Without `--keys-file` the default is
 * `partner-keys.env` next to the CLI's other secret files, and it may be absent.
 */
export function readKeysFile(ctx: RunContext, explicit: string | undefined): Record<string, string> {
  const file = explicit ?? join(productDir(ctx.env, 'atlas'), 'partner-keys.env');
  let mode: number;
  try {
    mode = statSync(file).mode;
  } catch {
    if (explicit) throw new CliError(`--keys-file not found: ${file}.`);
    return {};
  }
  if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
    throw new CliError(`${file} is readable by others (mode ${(mode & 0o777).toString(8)}). Run 'chmod 600 ${file}' and try again.`);
  }
  return parseDotenv(ctx.readFile(file));
}

/** Settings read from `--config <file>`: the same sections `atlas apply` takes, per partner. */
export interface ConnectFields {
  /** Body fields of PUT /v1/instance/integrations/<id>, by id. */
  integrations?: Record<string, Record<string, unknown>>;
  /** Body fields for PATCH /v1/instance/referrals (referalli). */
  referrals?: Record<string, unknown>;
  /** Body fields for PUT /v1/instance/privacy_orchestrator (cookiemunch). */
  privacy?: Record<string, unknown>;
}

const asRecord = (x: unknown): Record<string, unknown> | undefined =>
  x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined;

/** The integrations, referrals and privacy_orchestrator sections of a config file (yaml or json), `${ENV}` resolved. */
export function readConnectFields(ctx: RunContext, file: string): ConnectFields {
  const text = ctx.readFile(file);
  const doc = asRecord(interpolate(deserialize(text, file.endsWith('.json') ? 'json' : 'yaml'), ctx.env));
  const out: ConnectFields = {};
  const list = doc?.integrations;
  const entries: Array<[string, unknown]> = Array.isArray(list)
    ? list.map((e) => [String(asRecord(e)?.id ?? ''), e])
    : Object.entries(asRecord(list) ?? {});
  for (const [id, e] of entries) {
    const { id: _id, ...rest } = asRecord(e) ?? {};
    if (id) (out.integrations ??= {})[id] = rest;
  }
  out.referrals = asRecord(doc?.referrals);
  out.privacy = asRecord(doc?.privacy_orchestrator);
  return out;
}

/** Keys-file fallbacks for a partner's own settings: `<P>_ORG_ID`, `<P>_SPACES` (comma list), `<P>_CHANNEL`. */
function keyFileFields(name: string, keys: Record<string, string>): Record<string, unknown> {
  const spaces = keys[`${name}_SPACES`]?.split(',').map((x) => x.trim()).filter(Boolean);
  return {
    ...(keys[`${name}_ORG_ID`] ? { org_id: keys[`${name}_ORG_ID`] } : {}),
    ...(spaces?.length ? { spaces } : {}),
    ...(keys[`${name}_CHANNEL`] ? { channel: keys[`${name}_CHANNEL`] } : {}),
  };
}

interface Health {
  last_minted_at?: number | null;
  events?: { state?: string; url?: string } | null;
}
interface Row {
  id: string;
  connected?: boolean;
  enabled?: boolean;
  audience?: string;
  health?: Health;
  spaces?: Array<{ redeem_url?: string }>;
}

/** Connect each partner with the same calls the integration routes take, then return the read-back table. */
export async function connectPartners(
  api: ConfigHttp,
  partners: Partner[],
  keys: Record<string, string>,
  q: (path: string) => string,
  say: (line: string) => void,
  fields: ConnectFields = {},
): Promise<{ table: string; failures: string[] }> {
  const failures: string[] = [];
  for (const id of partners) {
    const name = id.toUpperCase();
    const key = keys[`${name}_API_KEY`];
    try {
      const now = await api.get<Row>(`/v1/instance/integrations/${id}`);
      const own = { ...(fields.integrations?.[id] ?? {}), ...keyFileFields(name, keys) };
      const { forumulate_api_key: yamlFk, chatly_api_key: yamlCk, replace_existing: replace, audience: yamlAudience, ...settings } = own;
      const audience = keys[`${name}_AUDIENCE`] ?? (yamlAudience as string | undefined) ?? now.audience;
      const fkey = key ?? (typeof yamlFk === 'string' ? yamlFk : undefined);
      const ckey = key ?? (typeof yamlCk === 'string' ? yamlCk : undefined);
      if (id === 'forumulate' && !fkey) throw new CliError(`forumulate needs FORUMULATE_API_KEY in the keys file (an org admin's key, used for this call only and never stored).`);
      if (!audience && !settings.org_id && !settings.channel) throw new CliError(`${id} has no audience yet: add ${name}_AUDIENCE to the keys file, or run 'atlas integrations set ${id} --audience <${id}:…>'.`);
      await api.put(q(`/v1/instance/integrations/${id}`), {
        enabled: true,
        ...(audience ? { audience } : {}),
        ...settings,
        ...(id === 'forumulate' ? { forumulate_api_key: fkey, ...(typeof replace === 'boolean' ? { replace_existing: replace } : {}) } : {}),
        ...(id === 'chatly' && ckey ? { chatly_api_key: ckey } : {}),
      });
      if (id === 'cookiemunch' && (key || fields.privacy)) await api.put(q('/v1/instance/privacy_orchestrator'), { provider: 'cookiemunch', enabled: true, ...fields.privacy, ...(key ? { api_key: key } : {}) });
      if (id === 'referalli' && (key || fields.referrals)) await api.patch(q('/v1/instance/referrals'), { provider: 'referalli', enabled: true, ...fields.referrals, ...(key ? { api_key: key } : {}) });
      say(`connected ${id}`);
    } catch (err) {
      failures.push(`${id}: ${err instanceof AtlasApiError ? `HTTP ${err.status} ${err.message}` : (err as Error).message}`);
    }
  }
  const list = await api.get<{ data: Row[] }>('/v1/instance/integrations');
  const rows = (list.data ?? []).filter((r) => (partners as string[]).includes(r.id));
  const table = renderTable(
    [
      { header: 'INTEGRATION', get: (r: Row) => r.id },
      { header: 'ON', get: (r: Row) => (r.connected ? (r.enabled ? 'yes' : 'no') : 'not connected') },
      { header: 'EVENTS RECEIVER', get: (r: Row) => (r.health?.events ? (r.health.events.state === 'healthy' || r.health.events.state === 'unknown' ? 'ok' : `not ok (${r.health.events.state})`) : 'none') },
      { header: 'MINTED TOKEN', get: (r: Row) => (r.health?.last_minted_at ? `ok (${new Date(r.health.last_minted_at).toISOString()})` : 'not yet') },
      { header: 'REDEEM HOST', get: (r: Row) => hostOf(r.spaces?.[0]?.redeem_url) },
    ],
    rows,
  );
  return { table, failures };
}

const hostOf = (u: string | undefined): string => {
  if (!u) return '';
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

/**
 * The Cookie Munch side of the data-rights handshake, with the customer's own Cookie Munch key:
 * connect Atlas as an identity executor (Atlas mints the narrow key itself, nothing is copied) and
 * register Atlas as the sign-in provider that verifies hosted-form requests. Both steps look before
 * they write, so a second run changes nothing.
 */
export async function connectCookieMunchSide(o: {
  fetch: typeof fetch;
  apiBase?: string;
  key: string;
  cbid: string;
  issuer: string;
  origin: string;
  dry: boolean;
}): Promise<string[]> {
  const base = (o.apiBase ?? 'https://api.cookiemunch.net').replace(/\/+$/, '');
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await o.fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${o.key}`, 'content-type': 'application/json', accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) throw new CliError(`Cookie Munch ${method} ${path} answered ${res.status}${json.message ? `: ${json.message}` : ''}.`);
    return json;
  };
  const done: string[] = [];
  const execs = await call('GET', '/v1/dsar/executors');
  const rows: Array<Record<string, any>> = Array.isArray(execs) ? execs : (execs.data ?? execs.executors ?? []);
  if (rows.some((e) => e.system === 'identity' && (e.preset === undefined || e.preset === 'atlas'))) done.push('executor already connected');
  else if (o.dry) done.push('would connect Atlas as the identity executor (dry run)');
  else {
    await call('POST', '/v1/dsar/executors', { system: 'identity', preset: 'atlas', mintFrom: 'atlas', cbid: o.cbid });
    done.push('connected Atlas as the identity executor');
  }
  const path = `/v1/sites/${encodeURIComponent(o.cbid)}/rights-identity`;
  const want = { type: 'atlas', issuer: o.issuer, authorizedParties: [o.origin] };
  const have = await call('GET', path).catch(() => ({}) as Record<string, any>);
  if (have.issuer === o.issuer && JSON.stringify(have.authorizedParties) === JSON.stringify(want.authorizedParties)) done.push('rights identity already set');
  else if (o.dry) done.push('would set the rights identity (dry run)');
  else {
    await call('PUT', path, want);
    done.push('set the rights identity');
  }
  return done;
}
