/* eslint-disable @typescript-eslint/no-explicit-any */
import { EmulatorError } from '../errors';

const ApiError = { validation: (message: string, param?: string) => new EmulatorError('VALIDATION_FAILED', message, param) };

/**
 * Declarative actions over a connection: a typed input, a request template and a response mapping. No code runs;
 * the request goes out through the connection relay (host allow-list, credential, refresh-once, audit).
 */
export interface ActionDef {
  provider: string;
  name: string;
  description: string;
  /** JSON Schema (object) of the input. Checked before anything is sent. */
  input: Record<string, unknown>;
  /**
   * JSON Schema of what the action returns (after `response.path`). Published so callers get types, and checked against
   * every successful answer: a mismatch is a provider change (the radar records it) and never fails the call.
   */
  output?: Record<string, unknown>;
  request: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    /** https base, e.g. https://api.github.com. Must be a host of the connection's allowed_hosts. */
    base_url: string;
    /** `/repos/{owner}/{repo}/issues`: `{arg}` is replaced by the percent-encoded input value. */
    path: string;
    /** Query parameters; a value that is exactly `{arg}` is dropped when the input omits it. */
    query?: Record<string, string>;
    /** JSON body template: a string that is exactly `{arg}` becomes the input value (omitted when absent). */
    body?: unknown;
    headers?: Record<string, string>;
  };
  response?: {
    /** Dot path to the part of the JSON answer to return. */
    path?: string;
    /** Providers that answer 200 with `{ok:false}` (Slack): the field to check and the one holding the error. */
    ok_field?: string;
    error_field?: string;
  };
  /** Provider scopes the connection must hold; checked before the call when the connection's granted scopes are known. */
  scopes?: string[];
  /** Cursor pagination hint passed to the relay's paginate when the caller asks for `all_pages`. */
  paginate?: Record<string, unknown>;
  /** True for actions that change data: surfaced as the MCP destructive hint. */
  mutating: boolean;
}

const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const PROVIDER = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const TEMPLATE_ARG = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const MAX_BODY_DEPTH = 8;

const obj = (v: unknown, where: string): Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw ApiError.validation(`${where} must be an object.`, 'definition');
  return v as Record<string, unknown>;
};

export function parseActionDef(provider: string, name: string, raw: unknown): ActionDef {
  if (!PROVIDER.test(provider)) throw ApiError.validation('provider must be a short lowercase key.', 'provider');
  if (!NAME.test(name)) throw ApiError.validation('name must be lowercase letters, digits and underscores.', 'name');
  const o = obj(raw, 'The definition');
  if (typeof o.description !== 'string' || !o.description.trim() || o.description.length > 500) throw ApiError.validation('description is required (up to 500 characters).', 'definition');
  const input = o.input === undefined ? { type: 'object', properties: {} } : obj(o.input, 'input');
  if (input.type !== 'object') throw ApiError.validation('input must be a JSON Schema of type object.', 'definition');
  if (JSON.stringify(input).length > 20_000) throw ApiError.validation('input schema is too large.', 'definition');
  let output: Record<string, unknown> | undefined;
  if (o.output !== undefined) {
    output = obj(o.output, 'output');
    if (JSON.stringify(output).length > 20_000) throw ApiError.validation('output schema is too large.', 'definition');
    if (output.type !== undefined && !(typeof output.type === 'string' || (Array.isArray(output.type) && output.type.every((t) => typeof t === 'string')))) throw ApiError.validation('output.type must be a JSON Schema type.', 'definition');
  }
  const r = obj(o.request, 'request');
  const method = String(r.method ?? '').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw ApiError.validation('request.method must be GET, POST, PUT, PATCH or DELETE.', 'definition');
  let base: URL;
  try {
    base = new URL(String(r.base_url));
  } catch {
    throw ApiError.validation('request.base_url must be an https URL.', 'definition');
  }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw ApiError.validation('request.base_url must be a plain https URL.', 'definition');
  if (typeof r.path !== 'string' || !r.path.startsWith('/') || r.path.includes('..') || r.path.length > 500 || /[?#\s]/.test(r.path)) throw ApiError.validation('request.path must start with / and hold no query, fragment or "..".', 'definition');
  const props = (input.properties ?? {}) as Record<string, unknown>;
  const used = new Set<string>();
  for (const m of r.path.matchAll(TEMPLATE_ARG)) used.add(m[1]!);
  const query = r.query === undefined ? undefined : (obj(r.query, 'request.query') as Record<string, string>);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (typeof v !== 'string' || !/^[A-Za-z0-9_.\-[\]]{1,64}$/.test(k)) throw ApiError.validation('request.query maps names to string templates.', 'definition');
    for (const m of v.matchAll(TEMPLATE_ARG)) used.add(m[1]!);
  }
  const walk = (v: unknown, depth: number) => {
    if (depth > MAX_BODY_DEPTH) throw ApiError.validation('request.body is nested too deeply.', 'definition');
    if (typeof v === 'string') for (const m of v.matchAll(TEMPLATE_ARG)) used.add(m[1]!);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (typeof v === 'object' && v !== null) Object.values(v).forEach((x) => walk(x, depth + 1));
  };
  walk(r.body, 0);
  const headers = r.headers === undefined ? undefined : (obj(r.headers, 'request.headers') as Record<string, string>);
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (typeof v !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(k) || /^(authorization|cookie|host|proxy-authorization|content-length|x-api-key)$/i.test(k) || /[\r\n]/.test(v)) throw ApiError.validation('request.headers has a header Atlas sets itself or an invalid value.', 'definition');
  }
  for (const a of used) if (!(a in props)) throw ApiError.validation(`The request uses {${a}}, which is not a property of input.`, 'definition');
  for (const m of r.path.matchAll(TEMPLATE_ARG)) {
    const req = (input.required ?? []) as string[];
    if (!req.includes(m[1]!)) throw ApiError.validation(`Path argument ${m[1]} must be in input.required.`, 'definition');
  }
  let response: ActionDef['response'];
  if (o.response !== undefined) {
    const x = obj(o.response, 'response');
    for (const k of ['path', 'ok_field', 'error_field']) if (x[k] !== undefined && (typeof x[k] !== 'string' || !/^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+){0,5}$/.test(x[k] as string))) throw ApiError.validation(`response.${k} must be a dot path.`, 'definition');
    response = x as ActionDef['response'];
  }
  const scopes = o.scopes === undefined ? undefined : o.scopes;
  if (scopes !== undefined && (!Array.isArray(scopes) || scopes.length > 30 || scopes.some((s) => typeof s !== 'string' || s.length > 300))) throw ApiError.validation('scopes must be a list of provider scopes.', 'definition');
  return {
    provider, name, description: o.description.trim(), input, ...(output ? { output } : {}),
    request: { method: method as ActionDef['request']['method'], base_url: base.origin + (base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '')), path: r.path, query, body: r.body, headers },
    response, scopes: scopes as string[] | undefined,
    paginate: o.paginate === undefined ? undefined : obj(o.paginate, 'paginate'),
    mutating: typeof o.mutating === 'boolean' ? o.mutating : method !== 'GET',
  };
}

// ---- input validation (the subset of JSON Schema inputs use) --------------------------
export function validateInput(schema: Record<string, unknown>, value: unknown, path = 'input'): string | null {
  let type = schema.type;
  // A nullable type (`['string', 'null']`): null passes, anything else is checked against the one real type.
  if (Array.isArray(type)) {
    if (value === null && type.includes('null')) return null;
    const real = type.filter((t) => t !== 'null');
    type = real.length === 1 ? real[0] : undefined;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) return `${path} must be one of ${JSON.stringify(schema.enum)}.`;
  switch (type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${path} must be an object.`;
      const v = value as Record<string, unknown>;
      const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      for (const r of (schema.required ?? []) as string[]) if (v[r] === undefined || v[r] === null) return `${path}.${r} is required.`;
      for (const [k, x] of Object.entries(v)) {
        if (x === undefined) continue;
        if (!props[k]) {
          if (schema.additionalProperties === false) return `${path}.${k} is not allowed.`;
          continue;
        }
        const e = validateInput(props[k]!, x, `${path}.${k}`);
        if (e) return e;
      }
      return null;
    }
    case 'array': {
      if (!Array.isArray(value)) return `${path} must be an array.`;
      if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return `${path} has too many items.`;
      const item = schema.items as Record<string, unknown> | undefined;
      if (item) for (let i = 0; i < value.length; i++) { const e = validateInput(item, value[i], `${path}[${i}]`); if (e) return e; }
      return null;
    }
    case 'string':
      if (typeof value !== 'string') return `${path} must be a string.`;
      if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) return `${path} is too long.`;
      if (typeof schema.minLength === 'number' && value.length < schema.minLength) return `${path} is too short.`;
      return null;
    case 'integer':
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || (type === 'integer' && !Number.isInteger(value))) return `${path} must be ${type === 'integer' ? 'an integer' : 'a number'}.`;
      if (typeof schema.minimum === 'number' && value < schema.minimum) return `${path} is below the minimum.`;
      if (typeof schema.maximum === 'number' && value > schema.maximum) return `${path} is above the maximum.`;
      return null;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${path} must be true or false.`;
    default:
      return null;
  }
}

// ---- request building -------------------------------------------------------------------
const WHOLE = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const interpolate = (s: string, input: Record<string, unknown>, encode: boolean): string =>
  s.replace(TEMPLATE_ARG, (_, a: string) => {
    const v = input[a];
    const str = v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return encode ? encodeURIComponent(str) : str;
  });

const fill = (t: unknown, input: Record<string, unknown>): unknown => {
  if (typeof t === 'string') {
    const m = WHOLE.exec(t);
    if (m) return input[m[1]!];
    return interpolate(t, input, false);
  }
  if (Array.isArray(t)) return t.map((x) => fill(x, input)).filter((x) => x !== undefined);
  if (typeof t === 'object' && t !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(t)) {
      const x = fill(v, input);
      if (x !== undefined) out[k] = x;
    }
    return out;
  }
  return t;
};

export function buildActionRequest(def: ActionDef, input: Record<string, unknown>): { method: string; url: string; headers: Record<string, string>; body?: unknown } {
  const path = def.request.path.replace(TEMPLATE_ARG, (_, a: string) => {
    const v = input[a];
    if (v === undefined || v === null || v === '') throw ApiError.validation(`${a} is required.`, 'input');
    // A dot segment would climb out of the templated path once the URL is normalised.
    if (String(v) === '.' || String(v) === '..') throw ApiError.validation(`${a} is not a valid value.`, 'input');
    return encodeURIComponent(String(v));
  });
  const qs = new URLSearchParams();
  for (const [k, t] of Object.entries(def.request.query ?? {})) {
    const m = WHOLE.exec(t);
    if (m) {
      const v = input[m[1]!];
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) qs.set(k, v.join(','));
      else qs.set(k, String(v));
    } else qs.set(k, interpolate(t, input, false));
  }
  const q = qs.toString();
  const body = def.request.body === undefined ? undefined : fill(def.request.body, input);
  return { method: def.request.method, url: `${def.request.base_url}${path}${q ? `?${q}` : ''}`, headers: { accept: 'application/json', ...(def.request.headers ?? {}) }, ...(body !== undefined ? { body } : {}) };
}

export const pick = (v: unknown, path: string | undefined): unknown => {
  if (!path) return v;
  let cur = v;
  for (const k of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
};
