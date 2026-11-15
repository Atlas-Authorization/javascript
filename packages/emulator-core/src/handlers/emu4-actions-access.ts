/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, KeyInfo } from '../engine';
import { EmulatorError } from '../errors';
import type { Obj } from '../openapi';
import { Table } from '../store';
import { engineState } from './support';

/**
 * Connection access rules: who may use a connection's credential. A connection with no rule stays open to every key that holds
 * the route's scope; once it has a rule it is restricted to the principals the rules name, each with the permissions listed.
 * Rules limit credential use (relay, actions), not management of the connection. In the emulator an `api_key` principal's id is
 * the secret key itself (the emulator has no separate key ids); `user` and `org_role` rules are stored and validated, and, as in
 * production, only `api_key` principals are evaluated.
 */
export const CONNECTION_PERMISSIONS = ['read_token', 'relay', 'run_actions', 'sign'] as const;
export const PRINCIPAL_TYPES = ['api_key', 'user', 'org_role'] as const;
export const MAX_ACCESS_RULES = 100;
const bad = (message: string, param: string) => new EmulatorError('VALIDATION_FAILED', message, param);

export const accessRules = engineState((e: Engine) => new Table('connection_access_rules', e.clock.now, 'cax'));

export const accessRuleView = (r: Obj): Obj => ({ object: 'connection_access_rule', id: r.id, connection_id: r.connection_id, principal_type: r.principal_type, principal_id: r.principal_id, permissions: r.permissions, created_at: r.created_at });

export const rulesOf = (e: Engine, connectionId: string): Obj[] => accessRules(e).filter((r) => r.connection_id === connectionId).reverse();

/** Validate a PUT body into rules (the whole set is replaced). */
export function parseAccessRules(body: Obj): Array<{ principal_type: string; principal_id: string; permissions: string[] }> {
  const raw = body.rules;
  if (!Array.isArray(raw) || raw.length > MAX_ACCESS_RULES) throw bad(`rules must be a list of at most ${MAX_ACCESS_RULES} rules.`, 'rules');
  const seen = new Set<string>();
  return raw.map((r, i) => {
    const o = (r ?? {}) as Obj;
    const extra = Object.keys(o).find((k) => !['principal_type', 'principal_id', 'permissions'].includes(k));
    if (extra) throw bad(`rules[${i}] has an unknown field ${extra}.`, `rules[${i}]`);
    if (typeof o.principal_type !== 'string' || !(PRINCIPAL_TYPES as readonly string[]).includes(o.principal_type)) throw bad(`rules[${i}].principal_type must be one of ${PRINCIPAL_TYPES.join(', ')}.`, `rules[${i}].principal_type`);
    if (typeof o.principal_id !== 'string' || !o.principal_id || o.principal_id.length > 200) throw bad(`rules[${i}].principal_id is required (up to 200 characters).`, `rules[${i}].principal_id`);
    if (!Array.isArray(o.permissions) || o.permissions.length === 0 || o.permissions.some((p: unknown) => typeof p !== 'string' || !(CONNECTION_PERMISSIONS as readonly string[]).includes(p))) {
      throw bad(`rules[${i}].permissions must be a non-empty list of ${CONNECTION_PERMISSIONS.join(', ')}.`, `rules[${i}].permissions`);
    }
    const id = `${o.principal_type}:${o.principal_id}`;
    if (seen.has(id)) throw bad(`rules[${i}] repeats ${id}.`, `rules[${i}]`);
    seen.add(id);
    return { principal_type: o.principal_type, principal_id: o.principal_id, permissions: [...new Set(o.permissions as string[])] };
  });
}

export function replaceAccessRules(e: Engine, connectionId: string, rules: ReturnType<typeof parseAccessRules>): Obj[] {
  const t = accessRules(e);
  for (const r of rulesOf(e, connectionId)) t.delete(r.id);
  return rules.map((r) => t.insert({ connection_id: connectionId, ...r, created_at: e.clock.now() }));
}

/** 403 unless the connection is open or a rule grants the calling key the permission. */
export function assertConnectionAccess(e: Engine, connectionId: string, key: KeyInfo | null, permission: (typeof CONNECTION_PERMISSIONS)[number]): void {
  const rules = rulesOf(e, connectionId);
  if (rules.length === 0) return;
  const id = key?.key ?? '';
  if (!rules.some((r) => r.principal_type === 'api_key' && r.principal_id === id && (r.permissions as string[]).includes(permission))) {
    throw new EmulatorError('FORBIDDEN', `This connection is restricted and no access rule lets this caller ${permission.replace('_', ' ')}.`, undefined, { meta: { reason: 'connection_access_denied', connection_id: connectionId, permission } });
  }
}

// ── upstream provider stubs ──
interface Stub {
  id: string;
  method: string | null;
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  remaining: number | null;
  hits: number;
}
export const providerStubs = engineState(() => ({ list: [] as Stub[], seq: 0 }));

/**
 * The canned provider answer for a call, when a stub matches (`url` is the exact origin and path, or a prefix ending in `*`;
 * `method` optional). A stub with `times` is used up after that many calls. Returns null when none matches.
 */
export function matchProviderStub(e: Engine, url: string, method: string): Response | null {
  const u = new URL(url);
  const flat = `${u.origin}${u.pathname}`;
  const s = providerStubs(e).list.find((x) => (x.method === null || x.method === method) && (x.url.endsWith('*') ? flat.startsWith(x.url.slice(0, -1)) : flat === x.url) && (x.remaining === null || x.remaining > 0));
  if (!s) return null;
  s.hits++;
  if (s.remaining !== null) s.remaining--;
  return new Response(s.body, { status: s.status, headers: s.headers });
}

export function addProviderStub(e: Engine, b: Obj): Stub {
  if (typeof b.url !== 'string' || !/^https:\/\//.test(b.url)) throw bad('url must be an https URL (or a prefix ending in *).', 'url');
  const status = b.status === undefined ? 200 : b.status;
  if (!Number.isInteger(status) || status < 100 || status > 599) throw bad('status must be an HTTP status from 100 to 599.', 'status');
  if (b.times !== undefined && (!Number.isInteger(b.times) || b.times < 1 || b.times > 1000)) throw bad('times must be an integer from 1 to 1000.', 'times');
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries((b.headers ?? {}) as Obj)) {
    if (typeof v !== 'string') throw bad('headers must map names to strings.', 'headers');
    headers[k.toLowerCase()] = v;
  }
  const isObj = b.body !== undefined && typeof b.body !== 'string';
  if (isObj && !headers['content-type']) headers['content-type'] = 'application/json';
  const st = providerStubs(e);
  const stub: Stub = { id: `stub_${++st.seq}`, method: typeof b.method === 'string' ? b.method.toUpperCase() : null, url: b.url, status, headers, body: b.body === undefined ? '' : isObj ? JSON.stringify(b.body) : (b.body as string), remaining: b.times === undefined ? null : (b.times as number), hits: 0 };
  st.list.push(stub);
  return stub;
}
