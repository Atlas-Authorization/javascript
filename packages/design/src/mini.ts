/**
 * A dependency-free schema builder for the design schema. It implements only
 * the constructs `./schema.ts` uses, and exposes the same `_zod.def`
 * introspection shape (type / shape / innerType / element / entries / checks)
 * that the dashboard's field mapper and the OpenAPI emitter read, so removing
 * the runtime zod dependency changes no consumer. Every parse returns a fresh
 * value built only from known keys.
 */

export interface Issue {
  code: 'invalid_type' | 'invalid_value' | 'too_small' | 'too_big' | 'not_multiple_of' | 'invalid_format' | 'unrecognized_keys';
  path: PropertyKey[];
  message: string;
  keys?: string[];
}
export interface SchemaError {
  issues: Issue[];
}
export type SafeParse<T> = { success: true; data: T } | { success: false; error: SchemaError };

export interface Check {
  _zod: { def: Record<string, unknown> & { check: string } };
}
export interface Def {
  type: string;
  checks?: Check[];
  innerType?: Schema<unknown>;
  element?: Schema<unknown>;
  shape?: Record<string, Schema<unknown>>;
  entries?: Record<string, string>;
  values?: unknown[];
}
export interface Schema<T> {
  readonly _zod: { def: Def };
  /** Object schemas only: the field schemas. */
  readonly shape: Record<string, Schema<unknown>>;
  /** Internal: push issues (relative to `path`) and return the parsed value. */
  _parse(v: unknown, path: PropertyKey[], issues: Issue[]): unknown;
  safeParse(v: unknown): SafeParse<T>;
  optional(): Schema<T | undefined>;
  nullable(): Schema<T | null>;
  readonly _t?: T;
}

const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const check = (def: Record<string, unknown> & { check: string }): Check => ({ _zod: { def } });

function make<T>(
  def: Def,
  parse: (v: unknown, path: PropertyKey[], issues: Issue[]) => unknown,
): Schema<T> {
  const s: Schema<T> = {
    _zod: { def },
    shape: def.shape ?? {},
    _parse: parse,
    safeParse(v) {
      const issues: Issue[] = [];
      const data = parse(v, [], issues);
      return issues.length ? { success: false, error: { issues } } : { success: true, data: data as T };
    },
    optional: () => wrap('optional', s, (v, p, i) => (v === undefined ? undefined : s._parse(v, p, i))),
    nullable: () => wrap('nullable', s, (v, p, i) => (v === null ? null : s._parse(v, p, i))),
  };
  return s;
}
const wrap = <T, U>(type: string, inner: Schema<T>, parse: (v: unknown, p: PropertyKey[], i: Issue[]) => unknown) =>
  make<U>({ type, innerType: inner as Schema<unknown> }, parse);

const bad = (issues: Issue[], path: PropertyKey[], code: Issue['code'], message: string) =>
  void issues.push({ code, path, message });

export function string(pattern?: RegExp, message?: string): Schema<string> {
  const checks = pattern ? [check({ check: 'string_format', format: 'regex', pattern })] : [];
  return make({ type: 'string', checks }, (v, p, i) => {
    if (typeof v !== 'string') bad(i, p, 'invalid_type', `Invalid input: expected string, received ${typeOf(v)}`);
    else if (pattern && !pattern.test(v)) bad(i, p, 'invalid_format', message ?? `Invalid string: must match ${pattern}`);
    return v;
  });
}

export interface NumberOpts {
  int?: boolean;
  min?: number;
  max?: number;
  multipleOf?: number;
}
export function number({ int, min, max, multipleOf }: NumberOpts = {}): Schema<number> {
  const checks: Check[] = [];
  if (int) checks.push(check({ check: 'number_format', format: 'safeint' }));
  if (min !== undefined) checks.push(check({ check: 'greater_than', value: min, inclusive: true }));
  if (max !== undefined) checks.push(check({ check: 'less_than', value: max, inclusive: true }));
  if (multipleOf !== undefined) checks.push(check({ check: 'multiple_of', value: multipleOf }));
  return make({ type: 'number', checks }, (v, p, i) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) bad(i, p, 'invalid_type', `Invalid input: expected number, received ${typeof v === 'number' ? String(v) : typeOf(v)}`);
    else if (int && !Number.isSafeInteger(v)) bad(i, p, 'invalid_type', 'Invalid input: expected int, received number');
    else if (min !== undefined && v < min) bad(i, p, 'too_small', `Too small: expected number to be >=${min}`);
    else if (max !== undefined && v > max) bad(i, p, 'too_big', `Too big: expected number to be <=${max}`);
    else if (multipleOf !== undefined && v % multipleOf !== 0) bad(i, p, 'not_multiple_of', `Invalid number: must be a multiple of ${multipleOf}`);
    return v;
  });
}

export function enumOf<const T extends readonly string[]>(values: T): Schema<T[number]> {
  return make({ type: 'enum', entries: Object.fromEntries(values.map((x) => [x, x])) }, (v, p, i) => {
    if (typeof v !== 'string' || !values.includes(v)) bad(i, p, 'invalid_value', `Invalid option: expected one of ${values.map((x) => JSON.stringify(x)).join('|')}`);
    return v;
  });
}

export function literal<const T extends string | number>(value: T): Schema<T> {
  return make({ type: 'literal', values: [value] }, (v, p, i) => {
    if (v !== value) bad(i, p, 'invalid_value', `Invalid input: expected ${JSON.stringify(value)}`);
    return v;
  });
}

export function array<T>(element: Schema<T>, min: number, max: number): Schema<T[]> {
  const checks = [check({ check: 'min_length', minimum: min }), check({ check: 'max_length', maximum: max })];
  return make({ type: 'array', element: element as Schema<unknown>, checks }, (v, p, i) => {
    if (!Array.isArray(v)) {
      bad(i, p, 'invalid_type', `Invalid input: expected array, received ${typeOf(v)}`);
      return v;
    }
    if (v.length < min) bad(i, p, 'too_small', `Too small: expected array to have >=${min} items`);
    else if (v.length > max) bad(i, p, 'too_big', `Too big: expected array to have <=${max} items`);
    return v.map((x, n) => element._parse(x, [...p, n], i));
  });
}

type Shape = Record<string, Schema<unknown>>;
/** A STRICT object: an unknown key is an `unrecognized_keys` issue. `T` is stated by the caller. */
export function object<T>(shape: Shape): Schema<T> {
  return make({ type: 'object', shape }, (v, p, i) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      bad(i, p, 'invalid_type', `Invalid input: expected object, received ${typeOf(v)}`);
      return v;
    }
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, field] of Object.entries(shape)) {
      if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = field._parse(src[k], [...p, k], i);
      else if (field._zod.def.type !== 'optional') field._parse(undefined, [...p, k], i);
    }
    const keys = Object.keys(src).filter((k) => !Object.prototype.hasOwnProperty.call(shape, k));
    if (keys.length) i.push({ code: 'unrecognized_keys', path: p, keys, message: `Unrecognized key(s): ${keys.join(', ')}` });
    return out;
  });
}
