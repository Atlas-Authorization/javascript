/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine } from './engine';
import { EmulatorError } from './errors';
import type { Obj } from './openapi';

/**
 * What a webhook endpoint can carry beyond its URL and event list: delivery `filters` (organization ids and metadata
 * predicates over the event data), static `headers` (names only on reads), `oauth` client-credentials for a receiver that
 * wants a bearer token, and a `max_rps` delivery cap. Validation follows the production rules; matching is the same pure
 * function, so an event an endpoint filters out is never sent to it.
 */
const PATH_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+){0,5}$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const RESERVED = /^(content-type|content-length|host|user-agent|connection|transfer-encoding|atlas-|webhook-)/i;
const isScalar = (v: unknown): boolean => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const bad = (message: string, param: string) => new EmulatorError('VALIDATION_FAILED', message, param);

function parseFilters(raw: unknown): Obj | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('filters must be an object, or null to clear it.', 'filters');
  const f = raw as Obj;
  const extra = Object.keys(f).find((k) => k !== 'organization_ids' && k !== 'metadata');
  if (extra) throw bad(`Unsupported filter: ${extra}. Allowed: organization_ids, metadata.`, 'filters');
  const out: Obj = {};
  if (f.organization_ids !== undefined) {
    const ids = f.organization_ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some((x) => typeof x !== 'string' || !x)) throw bad('organization_ids must list 1 to 100 organization ids.', 'filters.organization_ids');
    out.organization_ids = [...new Set(ids as string[])];
  }
  if (f.metadata !== undefined) {
    const preds = f.metadata;
    if (!Array.isArray(preds) || !preds.length || preds.length > 10) throw bad('metadata must list 1 to 10 predicates.', 'filters.metadata');
    out.metadata = preds.map((p: Obj, i: number) => {
      const at = `filters.metadata[${i}]`;
      const o = p && typeof p === 'object' && !Array.isArray(p) ? p : {};
      if (typeof o.path !== 'string' || !PATH_RE.test(o.path)) throw bad('path must be a dot path of letters, digits and underscores, at most 6 segments deep.', `${at}.path`);
      if (/private/i.test(o.path)) throw bad('Private metadata never leaves Atlas, so a filter cannot read it.', `${at}.path`);
      const ops = ['equals', 'in', 'exists'].filter((k) => o[k] !== undefined);
      if (ops.length !== 1) throw bad('Set exactly one of equals, in or exists.', at);
      if (o.equals !== undefined && !isScalar(o.equals)) throw bad('equals must be a string, number, boolean or null.', `${at}.equals`);
      if (o.in !== undefined && (!Array.isArray(o.in) || !o.in.length || o.in.length > 50 || !o.in.every(isScalar))) throw bad('in must list 1 to 50 strings, numbers, booleans or nulls.', `${at}.in`);
      if (o.exists !== undefined && typeof o.exists !== 'boolean') throw bad('exists must be a boolean.', `${at}.exists`);
      return { path: o.path, [ops[0]!]: o[ops[0]!] };
    });
  }
  if (!out.organization_ids && !out.metadata) throw bad('A filter needs organization_ids or metadata (send null to clear it).', 'filters');
  return out;
}

function parseHeaders(raw: unknown, oauthSet: boolean): Record<string, string> | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('headers must be an object of header names to values, or null.', 'headers');
  const entries = Object.entries(raw as Obj);
  if (!entries.length || entries.length > 10) throw bad('headers must hold 1 to 10 entries (send null to clear them).', 'headers');
  const out: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!HEADER_NAME.test(name)) throw bad(`Header name "${name}" is not valid.`, 'headers');
    if (RESERVED.test(name)) throw bad(`The ${name} header is set by Atlas and cannot be overridden.`, 'headers');
    if (oauthSet && name.toLowerCase() === 'authorization') throw bad('Authorization is set from oauth; remove one of them.', 'headers');
    if (typeof value !== 'string' || value.length > 2000 || /[\r\n]/.test(value)) throw bad(`The value of header ${name} must be a single-line string of at most 2000 characters.`, 'headers');
    if (out[name.toLowerCase()] !== undefined) throw bad(`Header ${name} is listed twice.`, 'headers');
    out[name.toLowerCase()] = value;
  }
  return out;
}

function parseOauth(raw: unknown): Obj | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('oauth must be an object, or null to clear it.', 'oauth');
  const o = raw as Obj;
  const extra = Object.keys(o).find((k) => !['token_url', 'client_id', 'client_secret', 'scope', 'audience'].includes(k));
  if (extra) throw bad(`Unsupported oauth field: ${extra}.`, `oauth.${extra}`);
  for (const k of ['token_url', 'client_id', 'client_secret']) if (typeof o[k] !== 'string' || !o[k].trim() || o[k].length > 2048) throw bad(`oauth.${k} must be a non-empty string.`, `oauth.${k}`);
  let u: URL;
  try {
    u = new URL(o.token_url);
  } catch {
    throw bad('oauth.token_url must be an https URL.', 'oauth.token_url');
  }
  if (u.protocol !== 'https:' || u.username || u.password) throw bad('oauth.token_url must be an https URL without credentials.', 'oauth.token_url');
  return { token_url: o.token_url, client_id: o.client_id, client_secret: o.client_secret, ...(o.scope ? { scope: String(o.scope) } : {}), ...(o.audience ? { audience: String(o.audience) } : {}) };
}

/** The endpoint fields a create or update body sets (only the ones sent; null clears). Throws a validation error. */
export function parseEndpointExtras(body: Obj, current?: Obj): Obj {
  const out: Obj = {};
  if ('filters' in body) out.filters = parseFilters(body.filters);
  if ('oauth' in body) out.oauth = parseOauth(body.oauth);
  if ('headers' in body) out.custom_headers = parseHeaders(body.headers, (('oauth' in body ? out.oauth : current?.oauth) ?? null) !== null);
  if ('max_rps' in body) {
    if (body.max_rps !== null && (!Number.isInteger(body.max_rps) || body.max_rps < 1 || body.max_rps > 1000)) throw bad('max_rps must be a whole number from 1 to 1000, or null to remove the cap.', 'max_rps');
    out.max_rps = body.max_rps;
  }
  return out;
}

/** The read side: header names only, no secret of any kind. */
export function presentEndpointExtras(ep: Obj): Obj {
  return {
    filters: ep.filters ?? null,
    header_names: ep.custom_headers ? Object.keys(ep.custom_headers) : [],
    oauth: ep.oauth ? { token_url: ep.oauth.token_url, client_id: ep.oauth.client_id, scope: ep.oauth.scope ?? null, secret_set: true } : null,
    max_rps: ep.max_rps ?? null,
  };
}

const read = (data: unknown, path: string): unknown => {
  let cur: any = data;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
};

/** The organization an event belongs to: `data.organization_id`, or the id of an organization object. */
export const eventOrgId = (data: Obj): string | null => (typeof data?.organization_id === 'string' ? data.organization_id : data?.object === 'organization' && typeof data.id === 'string' ? data.id : typeof data?.organization?.id === 'string' ? data.organization.id : null);

/** Does an event pass an endpoint's filters? No filters = yes. Fails closed on anything unreadable. */
export function filtersMatch(filters: Obj | null | undefined, data: Obj): boolean {
  if (!filters) return true;
  const org = eventOrgId(data);
  if (filters.organization_ids?.length && (!org || !filters.organization_ids.includes(org))) return false;
  for (const p of (filters.metadata as Obj[] | undefined) ?? []) {
    const v = read(data, p.path);
    if (p.exists !== undefined) {
      if ((v !== undefined && v !== null) !== p.exists) return false;
    } else if (p.in !== undefined) {
      if (!(p.in as unknown[]).some((x) => x === v)) return false;
    } else if (v !== p.equals) return false;
  }
  return true;
}

const tokens = new WeakMap<Engine, Map<string, { token: string; until: number }>>();

/** Extra request headers for one delivery: the static ones, plus a bearer token fetched with client credentials. */
export async function deliveryHeaders(e: Engine, ep: Obj): Promise<Record<string, string>> {
  const out: Record<string, string> = { ...(ep.custom_headers ?? {}) };
  if (ep.oauth) {
    let cache = tokens.get(e);
    if (!cache) tokens.set(e, (cache = new Map()));
    const hit = cache.get(ep.id);
    const now = e.clock.now();
    if (hit && hit.until > now) out.authorization = `Bearer ${hit.token}`;
    else {
      const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: ep.oauth.client_id, client_secret: ep.oauth.client_secret, ...(ep.oauth.scope ? { scope: ep.oauth.scope } : {}), ...(ep.oauth.audience ? { audience: ep.oauth.audience } : {}) });
      const res = await (e.options.fetch ?? fetch)(ep.oauth.token_url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
      if (res.status < 200 || res.status >= 300) throw new Error(`oauth token endpoint answered ${res.status}`);
      const json: any = await res.json();
      if (typeof json?.access_token !== 'string') throw new Error('oauth token endpoint returned no access_token');
      cache.set(ep.id, { token: json.access_token, until: now + Math.max(1, (Number(json.expires_in) || 300) - 30) * 1000 });
      out.authorization = `Bearer ${json.access_token}`;
    }
  }
  return out;
}

/** A receiver that answered 401 gets a fresh token next time. */
export const evictToken = (e: Engine, endpointId: string): void => void tokens.get(e)?.delete(endpointId);

const windows = new WeakMap<Engine, Map<string, { start: number; count: number }>>();
/** The `max_rps` budget: true when this delivery fits the current one-second window, false when it must wait for the next. */
export function takeRate(e: Engine, ep: Obj): boolean {
  if (!ep.max_rps) return true;
  let m = windows.get(e);
  if (!m) windows.set(e, (m = new Map()));
  const now = e.clock.now();
  const w = m.get(ep.id);
  if (!w || now - w.start >= 1000) {
    m.set(ep.id, { start: now, count: 1 });
    return true;
  }
  if (w.count >= ep.max_rps) return false;
  w.count++;
  return true;
}
