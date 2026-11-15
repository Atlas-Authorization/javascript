/* eslint-disable @typescript-eslint/no-explicit-any -- OpenAPI documents are open-ended JSON. */
export type Obj = Record<string, any>;

export interface Operation {
  method: string;
  /** OpenAPI path template, e.g. `/v1/users/{id}`. */
  path: string;
  operationId?: string;
  /** The `x-required-scope` of the operation. */
  scope?: string;
  /** False when the operation lists no secret-key security (public or publishable-key routes). */
  needsSecretKey: boolean;
  requestSchema?: Obj;
  requestRequired: boolean;
  /** Lowest 2xx response code, and its JSON schema. */
  successStatus: number;
  successSchema?: Obj;
  parameters: Obj[];
  pattern: RegExp;
  paramNames: string[];
  statics: number;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function compile(path: string): { pattern: RegExp; paramNames: string[]; statics: number } {
  const paramNames: string[] = [];
  let statics = 0;
  const src = path
    .split('/')
    .map((seg) => {
      const m = /^\{(.+)\}$/.exec(seg);
      if (m?.[1]) {
        paramNames.push(m[1]);
        return '([^/]+)';
      }
      if (seg) statics++;
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { pattern: new RegExp(`^${src}/?$`), paramNames, statics };
}

/**
 * The checked-in spec is the live one, and the live one trails the code: it lists two instance signing algorithms where the
 * API accepts five, and no delay / send_message / branch journey steps, and no external connection owner. Widen those enums so the emulator accepts what the
 * API does; once the spec carries them the entries are no-ops.
 */
const ENUM_LAGS: Array<{ path: RegExp; method: string; at: string[]; add: string[] }> = [
  { path: /^\/v1\/instance\/signing_keys\/rotate$/, method: 'post', at: ['properties', 'alg'], add: ['ES384', 'PS256', 'EdDSA'] },
  { path: /^\/v1\/connections$/, method: 'post', at: ['properties', 'owner', 'properties', 'type'], add: ['external'] },
  { path: /^\/v1\/flows(\/\{[^/]+\})?$/, method: 'post', at: ['properties', 'definition', 'properties', 'steps', 'items', 'properties', 'type'], add: ['branch', 'delay', 'send_message'] },
  { path: /^\/v1\/flows(\/\{[^/]+\})?$/, method: 'patch', at: ['properties', 'definition', 'properties', 'steps', 'items', 'properties', 'type'], add: ['branch', 'delay', 'send_message'] },
];
function widenLaggingEnums(path: string, method: string, body: Obj | undefined): void {
  for (const lag of ENUM_LAGS) {
    if (lag.method !== method || !lag.path.test(path)) continue;
    let node: any = body;
    for (const k of lag.at) node = node?.[k];
    if (Array.isArray(node?.enum)) for (const v of lag.add) if (!node.enum.includes(v)) node.enum.push(v);
  }
}

/** Plan fields the API accepts that the published plan body does not list yet. */
const PLAN_LAG_PROPS = ['grace_days', 'stripe_meter_id', 'usage_unit', 'provider', 'provider_price_id', 'annual_price_id', 'annual_amount', 'kind', 'seat_feature_id', 'promotion', 'description', 'badge', 'sort_order'];
function addLaggingProps(path: string, method: string, body: Obj | undefined): void {
  if (!/^\/v1\/billing\/plans(\/\{[^/]+\})?$/.test(path) || (method !== 'post' && method !== 'patch') || !body?.properties) return;
  for (const k of PLAN_LAG_PROPS) if (!(k in body.properties)) body.properties[k] = {};
}

export class OpenApiIndex {
  readonly ops: Operation[] = [];
  private readonly byMethod = new Map<string, Operation[]>();

  constructor(readonly doc: Obj) {
    // A tuple's expires_at is documented as a string and read as an ISO timestamp or epoch milliseconds.
    const expires = doc.components?.schemas?.FgaTupleKey?.properties?.expires_at;
    if (expires?.type === 'string') expires.type = ['string', 'integer'];
    for (const [path, item] of Object.entries<Obj>(doc.paths ?? {})) {
      for (const method of METHODS) {
        const op = item[method] as Obj | undefined;
        if (!op) continue;
        const body = op.requestBody?.content?.['application/json']?.schema;
        widenLaggingEnums(path, method, body);
        addLaggingProps(path, method, body);
        const codes = Object.keys(op.responses ?? {}).filter((c) => /^2\d\d$/.test(c)).sort();
        const code = codes[0];
        const resp = code ? op.responses[code]?.content?.['application/json']?.schema : undefined;
        const c = compile(path);
        const entry: Operation = {
          method: method.toUpperCase(),
          path,
          operationId: op.operationId,
          scope: op['x-required-scope'],
          needsSecretKey: Array.isArray(op.security) && op.security.some((s: Obj) => 'secretKey' in s),
          requestSchema: body,
          requestRequired: op.requestBody?.required === true,
          successStatus: code ? Number(code) : 200,
          successSchema: resp,
          parameters: op.parameters ?? [],
          ...c,
        };
        this.ops.push(entry);
        const list = this.byMethod.get(entry.method) ?? [];
        list.push(entry);
        this.byMethod.set(entry.method, list);
      }
    }
    // Most literal segments first, so `/v1/users/search` beats `/v1/users/{id}`.
    for (const list of this.byMethod.values()) list.sort((a, b) => b.statics - a.statics);
  }

  match(method: string, pathname: string): { op: Operation; params: Record<string, string> } | null {
    for (const op of this.byMethod.get(method) ?? []) {
      const m = op.pattern.exec(pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      op.paramNames.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1] ?? '')));
      return { op, params };
    }
    return null;
  }

  /** The methods a path answers to, for the ROUTE_NOT_FOUND hint. */
  methodsFor(pathname: string): string[] {
    return [...new Set(this.ops.filter((o) => o.pattern.test(pathname)).map((o) => o.method))];
  }

  resolve(schema: Obj | undefined, depth = 0): Obj | undefined {
    let s = schema;
    for (let i = 0; s && typeof s.$ref === 'string' && i < 20 && depth < 50; i++) {
      const name = s.$ref.replace(/^#\/components\/schemas\//, '');
      s = this.doc.components?.schemas?.[name];
    }
    return s;
  }

  schemaByName(name: string): Obj | undefined {
    return this.doc.components?.schemas?.[name];
  }
}

// ── validation ─────────────────────────────────────────────────────────

export interface Violation {
  param: string;
  message: string;
}

export interface ValidationResult {
  violations: Violation[];
  /** Body fields the schema does not declare (dotted paths). */
  unknown: string[];
}

const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);

function typeOk(types: string[], v: unknown): boolean {
  const t = typeOf(v);
  return types.includes(t) || (t === 'integer' && types.includes('number'));
}

/** Validates the JSON-Schema subset Atlas documents: type, required, properties, enum, const, items, composition, bounds. */
export function validate(index: OpenApiIndex, schema: Obj | undefined, value: unknown, path = ''): ValidationResult {
  const out: ValidationResult = { violations: [], unknown: [] };
  walk(index, schema, value, path, out);
  return out;
}

function walk(index: OpenApiIndex, raw: Obj | undefined, value: unknown, path: string, out: ValidationResult): void {
  const schema = index.resolve(raw);
  if (!schema) return;
  const fail = (message: string): void => void out.violations.push({ param: path || 'body', message });
  if (schema.allOf) for (const part of schema.allOf as Obj[]) walk(index, part, value, path, out);
  for (const key of ['anyOf', 'oneOf'] as const) {
    const options = schema[key] as Obj[] | undefined;
    if (!options?.length) continue;
    const attempts = options.map((o) => validate(index, o, value, path));
    const good = attempts.find((a) => a.violations.length === 0);
    if (!good) fail(`${path || 'body'} does not match any allowed shape.`);
    else out.unknown.push(...good.unknown);
    return;
  }
  const types = schema.type === undefined ? undefined : ([] as string[]).concat(schema.type);
  // A null-only property is a retired field: the real route answers 422 itself, so the handler gets the value.
  if (types && !(types.length === 1 && types[0] === 'null') && !typeOk(types, value)) {
    fail(`${path || 'body'} must be ${types.join(' or ')}.`);
    return;
  }
  if ('const' in schema && value !== schema.const) fail(`${path || 'body'} must be ${JSON.stringify(schema.const)}.`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) fail(`${path || 'body'} must be one of ${schema.enum.join(', ')}.`);
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) fail(`${path} is too short.`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) fail(`${path} is too long.`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) fail(`${path} must be at least ${schema.minimum}.`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) fail(`${path} must be at most ${schema.maximum}.`);
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, i) => walk(index, schema.items, item, `${path}[${i}]`, out));
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const rec = value as Obj;
    const props: Obj = schema.properties ?? {};
    for (const r of (schema.required as string[] | undefined) ?? []) {
      if (rec[r] === undefined) out.violations.push({ param: path ? `${path}.${r}` : r, message: `${path ? `${path}.` : ''}${r} is required.` });
    }
    for (const [k, v] of Object.entries(rec)) {
      const child = path ? `${path}.${k}` : k;
      if (props[k]) walk(index, props[k], v, child, out);
      else if (schema.properties && schema.additionalProperties !== true && !(typeof schema.additionalProperties === 'object')) out.unknown.push(child);
      else if (typeof schema.additionalProperties === 'object') walk(index, schema.additionalProperties, v, child, out);
    }
  }
}

// ── synthesis ──────────────────────────────────────────────────────────

/** A minimal valid value for a schema: required fields only, null where nullable, first enum member. */
export function synthesize(index: OpenApiIndex, raw: Obj | undefined, depth = 0): any {
  const schema = index.resolve(raw);
  if (!schema || depth > 5) return null;
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum.find((e: unknown) => e !== null) ?? null;
  const pick = (schema.oneOf ?? schema.anyOf)?.[0];
  if (pick) return synthesize(index, pick, depth + 1);
  if (schema.allOf) return Object.assign({}, ...(schema.allOf as Obj[]).map((p) => synthesize(index, p, depth + 1)));
  const types = schema.type === undefined ? ['object'] : ([] as string[]).concat(schema.type);
  const t = types.find((x) => x !== 'null') ?? 'null';
  switch (t) {
    case 'string':
      return '';
    case 'integer':
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object': {
      const o: Obj = {};
      const props: Obj = schema.properties ?? {};
      for (const r of (schema.required as string[] | undefined) ?? []) {
        const ps = index.resolve(props[r]);
        const nullable = ps && ([] as string[]).concat(ps.type ?? []).includes('null');
        o[r] = nullable ? null : synthesize(index, props[r], depth + 1);
      }
      return o;
    }
    default:
      return null;
  }
}
