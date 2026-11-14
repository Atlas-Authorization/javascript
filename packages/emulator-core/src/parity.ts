/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The parity contract suite. It runs ONE request list against two bases (the emulator and a real Atlas
 * instance) and compares status and response SHAPE (key sets and value types, never values). Anything the
 * emulator answers differently from the real API is a bug in the emulator. Run it on CI against a
 * development instance; it creates and then deletes its own data.
 *
 * A request may capture values from its response (`capture: { userId: 'id' }`) and use them in later paths
 * and bodies as `{{userId}}`; `{{rand}}` is a fresh token per run, so repeated runs do not collide.
 */
export interface ParityRequest {
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
  /** Send no Authorization header. */
  anonymous?: boolean;
  /** Extra request headers; `{{var}}` is substituted (for example `authorization: 'Bearer {{scimToken}}'`). */
  headers?: Record<string, string>;
  /** Send this as `application/x-www-form-urlencoded` instead of JSON (the OAuth endpoints). */
  form?: Record<string, string>;
  /** The feature group the request needs on the reference instance (`oauth`, `scim`, `agents`, `passkeys`, `device`, `round2`); runParity can select groups. */
  group?: string;
  /** variable name -> dotted path into the JSON response; `location#code` reads a query parameter of the Location header */
  capture?: Record<string, string>;
  /** Response keys whose presence is allowed to differ (dotted paths), e.g. optional fields. */
  tolerate?: string[];
}

export interface ParityTarget {
  baseUrl: string;
  secretKey: string;
}

export interface ParityResult {
  id: string;
  ok: boolean;
  status: { emulator: number; reference: number };
  diffs: string[];
}

type Json = any;

export function shapeOf(v: Json): Json {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0])] : [];
  if (typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shapeOf(v[k])]));
  return Number.isInteger(v) ? 'integer' : typeof v;
}

export function diffShape(a: Json, b: Json, path = '', tolerate: string[] = []): string[] {
  const here = path || '(body)';
  if (tolerate.includes(path)) return [];
  if (a === 'null' || b === 'null') return []; // null is compatible with any type: optional fields differ in which one they hold
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return [`${here}: array vs ${typeof (Array.isArray(a) ? b : a)}`];
    return a.length && b.length ? diffShape(a[0], b[0], `${path}[]`, tolerate) : [];
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const out: string[] = [];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const p = path ? `${path}.${k}` : k;
      if (tolerate.includes(p)) continue;
      if (!(k in a)) out.push(`${p}: only on the reference`);
      else if (!(k in b)) out.push(`${p}: only on the emulator`);
      else out.push(...diffShape(a[k], b[k], p, tolerate));
    }
    return out;
  }
  if (a === 'integer' && b === 'number') return [];
  if (a === 'number' && b === 'integer') return [];
  return a === b ? [] : [`${here}: emulator ${a}, reference ${b}`];
}

const get = (obj: Json, dotted: string): Json => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

async function runOne(target: ParityTarget, req: ParityRequest, vars: Record<string, string>, f: typeof fetch) {
  const sub = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, n: string) => vars[n] ?? '');
  const extra = Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k, sub(v)]));
  const form = req.form ? new URLSearchParams(Object.fromEntries(Object.entries(req.form).map(([k, v]) => [k, sub(v)]))).toString() : undefined;
  const res = await f(`${target.baseUrl.replace(/\/+$/, '')}${sub(req.path)}`, {
    method: req.method,
    redirect: 'manual',
    headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', ...(req.anonymous || extra.authorization ? {} : { authorization: `Bearer ${target.secretKey}` }), ...extra },
    body: form ?? (req.body ? sub(JSON.stringify(req.body)) : undefined),
  });
  const text = await res.text();
  let json: Json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  for (const [name, p] of Object.entries(req.capture ?? {})) {
    const [head, param] = p.split('#');
    const v = param ? (() => { try { return new URL(res.headers.get(head!) ?? '', 'http://x').searchParams.get(param) ?? undefined; } catch { return undefined; } })() : get(json, p);
    if (v !== undefined) vars[name] = String(v);
  }
  return { status: res.status, json };
}

export async function runParity(opts: { requests: ParityRequest[]; emulator: ParityTarget; reference: ParityTarget; fetchImpl?: typeof fetch; /** Only run these feature groups (requests without a group always run). */ groups?: string[] }): Promise<ParityResult[]> {
  const f = opts.fetchImpl ?? fetch;
  const rand = Math.random().toString(36).slice(2, 10);
  const varsE: Record<string, string> = { rand };
  const varsR: Record<string, string> = { rand };
  const results: ParityResult[] = [];
  for (const req of opts.requests.filter((q) => !q.group || !opts.groups || opts.groups.includes(q.group))) {
    const [e, r] = [await runOne(opts.emulator, req, varsE, f), await runOne(opts.reference, req, varsR, f)];
    const diffs: string[] = [];
    if (e.status !== r.status) diffs.push(`status: emulator ${e.status}, reference ${r.status}`);
    else diffs.push(...diffShape(shapeOf(e.json), shapeOf(r.json), '', req.tolerate));
    results.push({ id: req.id, ok: diffs.length === 0, status: { emulator: e.status, reference: r.status }, diffs });
  }
  return results;
}

/** The request list for the first-round resources: the ones the emulator models by hand, plus the error shapes. See `parity-routes.ts` for the rest. */
export const defaultParityRequests: ParityRequest[] = [
  { id: 'no key', method: 'GET', path: '/v1/users', anonymous: true },
  { id: 'unknown route', method: 'GET', path: '/v1/definitely_not_a_route' },
  { id: 'user create invalid', method: 'POST', path: '/v1/users', body: { email_address: 'not-an-email' } },
  { id: 'user create', method: 'POST', path: '/v1/users', body: { email_address: 'parity-{{rand}}@example.com', first_name: 'Parity' }, capture: { userId: 'id' } },
  { id: 'user duplicate', method: 'POST', path: '/v1/users', body: { email_address: 'parity-{{rand}}@example.com' } },
  { id: 'user get', method: 'GET', path: '/v1/users/{{userId}}' },
  { id: 'user missing', method: 'GET', path: '/v1/users/user_doesnotexist' },
  { id: 'user list', method: 'GET', path: '/v1/users?limit=2' },
  { id: 'user patch', method: 'PATCH', path: '/v1/users/{{userId}}', body: { last_name: 'Check', public_metadata: { plan: 'pro' } } },
  { id: 'user metadata', method: 'PUT', path: '/v1/users/{{userId}}/metadata', body: { public_metadata: { a: 1 } } },
  { id: 'org create', method: 'POST', path: '/v1/organizations', body: { name: 'Parity {{rand}}' }, capture: { orgId: 'id' } },
  { id: 'org get', method: 'GET', path: '/v1/organizations/{{orgId}}' },
  { id: 'membership add', method: 'POST', path: '/v1/organizations/{{orgId}}/memberships', body: { user_id: '{{userId}}', role: 'org:member' } },
  { id: 'membership list', method: 'GET', path: '/v1/organizations/{{orgId}}/memberships' },
  { id: 'membership again', method: 'POST', path: '/v1/organizations/{{orgId}}/memberships', body: { user_id: '{{userId}}', role: 'org:member' } },
  { id: 'roles', method: 'GET', path: '/v1/roles' },
  { id: 'permissions', method: 'GET', path: '/v1/permissions' },
  { id: 'invitation', method: 'POST', path: '/v1/invitations', body: { email_address: 'invite-{{rand}}@example.com' }, capture: { invId: 'id' } },
  { id: 'invitation revoke', method: 'POST', path: '/v1/invitations/{{invId}}/revoke' },
  { id: 'api key create', method: 'POST', path: '/v1/api_keys', body: { subject_type: 'user', subject_id: '{{userId}}', name: 'parity', scopes: ['read'] }, capture: { keyId: 'id', keySecret: 'secret' }, tolerate: ['secret'] },
  { id: 'api key verify', method: 'POST', path: '/v1/api_keys/verify', body: { secret: '{{keySecret}}' } },
  { id: 'api key verify unknown', method: 'POST', path: '/v1/api_keys/verify', body: { secret: 'ak_unknown' } },
  { id: 'api key revoke', method: 'DELETE', path: '/v1/api_keys/{{keyId}}' },
  { id: 'machine create', method: 'POST', path: '/v1/machines', body: { name: 'parity machine' }, capture: { machineId: 'id' }, tolerate: ['secret'] },
  { id: 'machine get', method: 'GET', path: '/v1/machines/{{machineId}}' },
  { id: 'webhook create', method: 'POST', path: '/v1/webhook_endpoints', body: { url: 'https://example.com/hooks/{{rand}}', enabled_events: ['user.created'] }, capture: { hookId: 'id' }, tolerate: ['secret'] },
  { id: 'webhook get', method: 'GET', path: '/v1/webhook_endpoints/{{hookId}}' },
  { id: 'webhook delete', method: 'DELETE', path: '/v1/webhook_endpoints/{{hookId}}' },
  { id: 'events', method: 'GET', path: '/v1/events?limit=1' },
  { id: 'changes', method: 'GET', path: '/v1/changes?limit=1' },
  { id: 'changes bad after', method: 'GET', path: '/v1/changes?after=999999999999' },
  { id: 'machine delete', method: 'DELETE', path: '/v1/machines/{{machineId}}' },
  { id: 'org delete', method: 'DELETE', path: '/v1/organizations/{{orgId}}' },
  { id: 'user delete', method: 'DELETE', path: '/v1/users/{{userId}}' },
];
