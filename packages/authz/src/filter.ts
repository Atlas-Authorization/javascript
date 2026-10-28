/**
 * Residual-policy filters: what `POST /v1/abac/partial_evaluate` returns, and the
 * helpers that turn one into a database query. Zero dependencies.
 *
 * A {@link Filter} is a small JSON condition tree over fields of the entity being
 * listed (`resource.department`, `principal.level`). Every leaf is a TOTAL boolean:
 * a comparison on a missing field is false. There is no `not` node (negation is
 * already pushed to the leaves), so a filter compiles cleanly to SQL, where NULL
 * collapses to false under AND/OR, and to Prisma / Drizzle objects.
 *
 * Reserved fields: `<var>.$id` is the entity id and `<var>.$ancestors` the
 * `Type::id` uids of everything it is `in`. Entity-valued attributes compare as
 * `Type::id` strings. Attribute types are assumed consistent per field.
 */

export type FilterScalar = string | number | boolean;
export type FilterCmp = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
export type FilterTerm =
  | { field: string }
  | { value: FilterScalar }
  | { arith: 'add' | 'sub' | 'mul'; left: FilterTerm; right: FilterTerm }
  | { neg: FilterTerm };

export type Filter =
  | { op: 'true' }
  | { op: 'false' }
  | { op: 'and'; args: Filter[] }
  | { op: 'or'; args: Filter[] }
  | { op: FilterCmp; field: string; value: FilterScalar }
  | { op: FilterCmp; field: string; ref: string }
  | { op: 'cmp'; cmp: FilterCmp; left: FilterTerm; right: FilterTerm }
  | { op: 'in' | 'not_in'; field: string; values: FilterScalar[] }
  | { op: 'contains' | 'not_contains'; field: string; value: FilterScalar }
  | { op: 'like' | 'not_like'; field: string; pattern: string }
  | { op: 'exists' | 'missing'; field: string }
  | { op: 'relation' | 'not_relation'; relation: string; type: string; field: string; subject?: string; object?: string; store?: string };

/** Thrown when a filter cannot be compiled (an unmapped field, an unresolved relation, a pattern the target cannot express). */
export class FilterCompileError extends Error {}

const CMP_SQL: Record<FilterCmp, string> = { eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' };

/* ------------------------------ evaluation -------------------------------- */

/** Rows by unknown variable: `{ resource: { department: 'eng', $id: 'd1', $ancestors: ['Folder::f1'] } }`. */
export type FilterRows = Partial<Record<'principal' | 'resource', Record<string, unknown>>>;

const norm = (v: unknown): unknown => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (typeof o.type === 'string' && typeof o.id === 'string' && Object.keys(o).length === 2) return `${o.type}::${o.id}`;
  }
  return v;
};

function lookup(rows: FilterRows, field: string): unknown {
  const parts = field.split('.');
  let cur: unknown = rows[parts[0] as 'principal' | 'resource'];
  for (const p of parts.slice(1)) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur === null ? undefined : norm(cur);
}

function termValue(t: FilterTerm, rows: FilterRows): FilterScalar | undefined {
  if ('value' in t) return t.value;
  if ('field' in t) {
    const v = lookup(rows, t.field);
    return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : undefined;
  }
  if ('neg' in t) {
    const v = termValue(t.neg, rows);
    return typeof v === 'number' ? -v : undefined;
  }
  const l = termValue(t.left, rows);
  const r = termValue(t.right, rows);
  if (typeof l !== 'number' || typeof r !== 'number') return undefined;
  return t.arith === 'add' ? l + r : t.arith === 'sub' ? l - r : l * r;
}

function compare(cmp: FilterCmp, a: FilterScalar, b: FilterScalar): boolean {
  if (cmp === 'eq') return a === b;
  if (cmp === 'ne') return a !== b;
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  return cmp === 'lt' ? a < b : cmp === 'lte' ? a <= b : cmp === 'gt' ? a > b : a >= b;
}

/** `*` is the only wildcard (the policy language's `like`). */
export function likeToRegExp(pattern: string): RegExp {
  return new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 's');
}

/** Evaluate a filter on in-memory rows (e.g. a cached list). Relation leaves must be resolved by the server. */
export function evalFilter(f: Filter, rows: FilterRows): boolean {
  switch (f.op) {
    case 'true':
      return true;
    case 'false':
      return false;
    case 'and':
      return f.args.every((a) => evalFilter(a, rows));
    case 'or':
      return f.args.some((a) => evalFilter(a, rows));
    case 'eq':
    case 'ne':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const l = termValue({ field: f.field }, rows);
      const r = 'ref' in f ? termValue({ field: f.ref }, rows) : f.value;
      return l !== undefined && r !== undefined && compare(f.op, l, r);
    }
    case 'cmp': {
      const l = termValue(f.left, rows);
      const r = termValue(f.right, rows);
      return l !== undefined && r !== undefined && compare(f.cmp, l, r);
    }
    case 'in':
    case 'not_in': {
      const v = lookup(rows, f.field);
      if (v === undefined || Array.isArray(v)) return false;
      return f.values.includes(v as FilterScalar) === (f.op === 'in');
    }
    case 'contains':
    case 'not_contains': {
      const v = lookup(rows, f.field);
      if (!Array.isArray(v)) return false;
      return v.map(norm).includes(f.value) === (f.op === 'contains');
    }
    case 'like':
    case 'not_like': {
      const v = lookup(rows, f.field);
      return typeof v === 'string' && likeToRegExp(f.pattern).test(v) === (f.op === 'like');
    }
    case 'exists':
      return lookup(rows, f.field) !== undefined;
    case 'missing':
      return lookup(rows, f.field) === undefined;
    case 'relation':
    case 'not_relation':
      throw new FilterCompileError('Unresolved relation condition: ask the server to resolve it (resolve_relations).');
  }
}

/* ---------------------------------- SQL ----------------------------------- */

export type SqlDialect = 'postgres' | 'mysql' | 'sqlite';

/**
 * Where a field lives. A bare string is a column (`"department"` or `"t.department"`).
 * `kind: 'array'` is a native array column (Postgres); `kind: 'json'` a JSON column holding
 * an array. `json: 'a.b'` reads the field out of a JSON(B) column at that path instead.
 */
export type SqlColumn = string | { column: string; kind?: 'scalar' | 'array' | 'json'; json?: string };

export interface SqlOptions {
  /** field -> column. A field with no entry is an error, never interpolated. */
  columns: Record<string, SqlColumn>;
  dialect?: SqlDialect;
  /** Postgres only: the number the first `$n` placeholder gets (to append to a query that already has params). */
  paramOffset?: number;
}

export interface SqlFragment {
  /** A parenthesised boolean expression, ready for `WHERE`. */
  text: string;
  /** Positional parameters, in placeholder order. */
  params: unknown[];
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const JSON_SEG = /^[A-Za-z0-9_]+$/;

class SqlBuilder {
  readonly params: unknown[] = [];
  constructor(
    private readonly o: SqlOptions,
    private readonly d: SqlDialect,
  ) {}

  private quote(id: string): string {
    const parts = id.split('.');
    if (parts.length > 2 || !parts.every((p) => IDENT.test(p))) throw new FilterCompileError(`"${id}" is not a safe column name (letters, digits and underscore, optionally table.column).`);
    const q = this.d === 'mysql' ? '`' : '"';
    return parts.map((p) => `${q}${p}${q}`).join('.');
  }

  private param(v: unknown): string {
    this.params.push(v);
    return this.d === 'postgres' ? `$${(this.o.paramOffset ?? 0) + this.params.length}` : '?';
  }

  private spec(field: string): { col: string; kind: 'scalar' | 'array' | 'json'; path?: string[] } {
    const c = this.o.columns[field];
    if (c === undefined) throw new FilterCompileError(`No column is mapped for field "${field}".`);
    const s = typeof c === 'string' ? { column: c } : c;
    const col = this.quote(s.column);
    if (s.json !== undefined) {
      const path = s.json.split('.');
      if (!path.every((p) => JSON_SEG.test(p))) throw new FilterCompileError(`"${s.json}" is not a safe JSON path.`);
      return { col, kind: s.kind === 'array' || s.kind === 'json' ? 'json' : 'scalar', path };
    }
    return { col, kind: s.kind ?? 'scalar' };
  }

  /** The SQL for a scalar field, cast to the type it is compared as. */
  private scalar(field: string, as: 'string' | 'number' | 'boolean'): string {
    const { col, path } = this.spec(field);
    if (!path) return col;
    if (this.d === 'sqlite') return `json_extract(${col}, '$.${path.join('.')}')`;
    if (this.d === 'mysql') {
      const raw = `JSON_UNQUOTE(JSON_EXTRACT(${col}, '$.${path.join('.')}'))`;
      return as === 'number' ? `CAST(${raw} AS DECIMAL(38,10))` : raw;
    }
    const raw = `(${col} #>> '{${path.join(',')}}')`;
    return as === 'number' ? `${raw}::numeric` : as === 'boolean' ? `${raw}::boolean` : raw;
  }

  private kindOf = (v: FilterScalar) => (typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string') as 'string' | 'number' | 'boolean';

  /** The SQL for a JSON/array field used as a set. */
  private setExpr(field: string): { sql: string; native: boolean } {
    const { col, kind, path } = this.spec(field);
    if (path) {
      if (this.d === 'postgres') return { sql: `(${col} #> '{${path.join(',')}}')`, native: false };
      if (this.d === 'mysql') return { sql: `JSON_EXTRACT(${col}, '$.${path.join('.')}')`, native: false };
      return { sql: `json_extract(${col}, '$.${path.join('.')}')`, native: false };
    }
    const k = kind === 'scalar' ? (this.d === 'postgres' ? 'array' : 'json') : kind;
    return { sql: col, native: k === 'array' };
  }

  private term(t: FilterTerm, as: 'string' | 'number' | 'boolean' = 'number'): string {
    if ('field' in t) return this.scalar(t.field, as);
    if ('value' in t) return this.param(t.value);
    if ('neg' in t) return `(-${this.term(t.neg)})`;
    return `(${this.term(t.left)} ${t.arith === 'add' ? '+' : t.arith === 'sub' ? '-' : '*'} ${this.term(t.right)})`;
  }

  private likePattern(pattern: string): string {
    // Escape the SQL wildcards, then make `*` the wildcard.
    return pattern.split('*').map((p) => p.replace(/[\\%_]/g, '\\$&')).join('%');
  }

  build(f: Filter): string {
    switch (f.op) {
      case 'true':
        return '(1 = 1)';
      case 'false':
        return '(1 = 0)';
      case 'and':
      case 'or':
        return f.args.length === 0 ? (f.op === 'and' ? '(1 = 1)' : '(1 = 0)') : `(${f.args.map((a) => this.build(a)).join(f.op === 'and' ? ' AND ' : ' OR ')})`;
      case 'eq':
      case 'ne':
      case 'lt':
      case 'lte':
      case 'gt':
      case 'gte': {
        if ('ref' in f) return `(${this.scalar(f.field, 'string')} ${CMP_SQL[f.op]} ${this.scalar(f.ref, 'string')})`;
        const as = this.kindOf(f.value);
        return `(${this.scalar(f.field, as)} ${CMP_SQL[f.op]} ${this.param(f.value)})`;
      }
      case 'cmp':
        return `(${this.term(f.left)} ${CMP_SQL[f.cmp]} ${this.term(f.right)})`;
      case 'in':
      case 'not_in': {
        if (f.values.length === 0) return f.op === 'in' ? '(1 = 0)' : '(1 = 1)';
        const as = this.kindOf(f.values[0]!);
        const col = this.scalar(f.field, as);
        if (this.d === 'postgres' && f.values.every((v) => typeof v === 'string')) {
          return f.op === 'in' ? `(${col} = ANY(${this.param(f.values)}))` : `(${col} <> ALL(${this.param(f.values)}))`;
        }
        const list = f.values.map((v) => this.param(v)).join(', ');
        return `(${col} ${f.op === 'in' ? 'IN' : 'NOT IN'} (${list}))`;
      }
      case 'contains':
      case 'not_contains': {
        const neg = f.op === 'not_contains';
        const { sql, native } = this.setExpr(f.field);
        let test: string;
        if (this.d === 'postgres') {
          test = native ? `${this.param(f.value)} = ANY(${sql})` : `${sql} @> ${this.param(JSON.stringify([f.value]))}::jsonb`;
        } else if (this.d === 'mysql') {
          test = `JSON_CONTAINS(${sql}, ${this.param(JSON.stringify(f.value))})`;
        } else {
          test = `EXISTS (SELECT 1 FROM json_each(${sql}) WHERE value = ${this.param(f.value)})`;
        }
        // SQLite's json_each(NULL) is empty, so NOT EXISTS would be true for a missing field: guard it.
        return neg ? `(${this.d === 'sqlite' ? `${sql} IS NOT NULL AND ` : ''}NOT ${test})` : `(${test})`;
      }
      case 'like':
      case 'not_like': {
        const col = this.scalar(f.field, 'string');
        const neg = f.op === 'not_like' ? 'NOT ' : '';
        if (this.d === 'sqlite') {
          // LIKE is case-insensitive in SQLite; GLOB is case-sensitive and its wildcard is already `*`.
          return `(${col} ${neg}GLOB ${this.param(f.pattern.replace(/[?[]/g, '[$&]'))})`;
        }
        const pat = this.param(this.likePattern(f.pattern));
        return this.d === 'mysql' ? `(${col} ${neg}LIKE BINARY ${pat} ESCAPE '\\\\')` : `(${col} ${neg}LIKE ${pat} ESCAPE '\\')`;
      }
      case 'exists':
      case 'missing': {
        const { col, path } = this.spec(f.field);
        const v = path ? this.scalar(f.field, 'string') : col;
        return `(${v} IS ${f.op === 'exists' ? 'NOT ' : ''}NULL)`;
      }
      case 'relation':
      case 'not_relation':
        throw new FilterCompileError('Relation conditions must be resolved first: pass resolve_relations to partial_evaluate.');
    }
  }
}

/**
 * Compile a filter to a parameterised `WHERE` fragment. Column names come from
 * `columns` only and are validated and quoted; every value is a bound parameter.
 */
export function filterToSql(filter: Filter, options: SqlOptions): SqlFragment {
  const b = new SqlBuilder(options, options.dialect ?? 'postgres');
  const text = b.build(filter);
  return { text, params: b.params };
}

/* ------------------------------ Prisma-style ------------------------------- */

export interface PrismaOptions {
  /** field -> Prisma field path (`"department"` or a relation path `"owner.department"`). A field with no entry is an error. */
  fields: Record<string, string>;
}

type Obj = Record<string, unknown>;

const nest = (path: string, cond: unknown): Obj => path.split('.').reduceRight<unknown>((acc, seg) => ({ [seg]: acc }), cond) as Obj;

/**
 * Compile a filter to a Prisma `where` object. Field-to-field comparisons,
 * arithmetic and mid-string `like` patterns have no Prisma form and throw
 * {@link FilterCompileError}; use {@link filterToSql} with `$queryRaw` for those.
 */
export function filterToPrisma(filter: Filter, options: PrismaOptions): Obj {
  const path = (field: string): string => {
    const p = options.fields[field];
    if (p === undefined) throw new FilterCompileError(`No Prisma field is mapped for "${field}".`);
    return p;
  };
  const one = (f: Filter): Obj => {
    switch (f.op) {
      case 'true':
        return {};
      case 'false':
        return { OR: [] };
      case 'and':
        return { AND: f.args.map(one) };
      case 'or':
        return { OR: f.args.map(one) };
      case 'eq':
      case 'ne':
      case 'lt':
      case 'lte':
      case 'gt':
      case 'gte': {
        if ('ref' in f) throw new FilterCompileError('Comparing two fields has no Prisma form; use filterToSql.');
        const c = f.op === 'eq' ? { equals: f.value } : f.op === 'ne' ? { not: f.value } : { [f.op]: f.value };
        return nest(path(f.field), c);
      }
      case 'cmp':
        throw new FilterCompileError('Arithmetic has no Prisma form; use filterToSql.');
      case 'in':
        return nest(path(f.field), { in: f.values });
      case 'not_in':
        return { AND: [nest(path(f.field), { notIn: f.values }), nest(path(f.field), { not: null })] };
      case 'contains':
        return nest(path(f.field), { has: f.value });
      case 'not_contains':
        return { AND: [{ NOT: nest(path(f.field), { has: f.value }) }, nest(path(f.field), { not: null })] };
      case 'exists':
        return nest(path(f.field), { not: null });
      case 'missing':
        return nest(path(f.field), { equals: null });
      case 'like':
      case 'not_like': {
        const m = /^(\*?)([^*]*)(\*?)$/.exec(f.pattern);
        if (!m) throw new FilterCompileError(`Pattern "${f.pattern}" has no Prisma form (only x, x*, *x and *x*); use filterToSql.`);
        const [, lead, body, trail] = m;
        const c = lead && trail ? { contains: body } : lead ? { endsWith: body } : trail ? { startsWith: body } : { equals: body };
        const pos = nest(path(f.field), c);
        return f.op === 'like' ? pos : { AND: [{ NOT: pos }, nest(path(f.field), { not: null })] };
      }
      case 'relation':
      case 'not_relation':
        throw new FilterCompileError('Relation conditions must be resolved first: pass resolve_relations to partial_evaluate.');
    }
  };
  return one(filter);
}

/* ------------------------------ Drizzle-style ------------------------------ */

/**
 * The operators from `drizzle-orm` (pass them in so this package needs no dependency):
 * `import * as d from 'drizzle-orm'; filterToDrizzle(f, { columns, ops: d })`.
 */
export interface DrizzleOps {
  and(...c: unknown[]): unknown;
  or(...c: unknown[]): unknown;
  eq(a: unknown, b: unknown): unknown;
  ne(a: unknown, b: unknown): unknown;
  gt(a: unknown, b: unknown): unknown;
  gte(a: unknown, b: unknown): unknown;
  lt(a: unknown, b: unknown): unknown;
  lte(a: unknown, b: unknown): unknown;
  inArray(a: unknown, v: unknown[]): unknown;
  notInArray(a: unknown, v: unknown[]): unknown;
  isNull(a: unknown): unknown;
  isNotNull(a: unknown): unknown;
  like(a: unknown, p: string): unknown;
  notLike(a: unknown, p: string): unknown;
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
}

export interface DrizzleOptions {
  /** field -> Drizzle column object. */
  columns: Record<string, unknown>;
  ops: DrizzleOps;
  /** Fields held in a native array column (Postgres); `contains` uses `= ANY(col)`. Others are treated as JSONB arrays. */
  arrayFields?: string[];
}

/** Compile a filter to a Drizzle SQL condition (Postgres). */
export function filterToDrizzle(filter: Filter, options: DrizzleOptions): unknown {
  const { ops, columns } = options;
  const { sql } = ops;
  const col = (field: string): unknown => {
    if (!(field in columns)) throw new FilterCompileError(`No Drizzle column is mapped for "${field}".`);
    return columns[field];
  };
  const term = (t: FilterTerm): unknown => {
    if ('field' in t) return col(t.field);
    if ('value' in t) return sql`${t.value}`;
    if ('neg' in t) return sql`(-${term(t.neg)})`;
    const [l, r] = [term(t.left), term(t.right)];
    return t.arith === 'add' ? sql`(${l} + ${r})` : t.arith === 'sub' ? sql`(${l} - ${r})` : sql`(${l} * ${r})`;
  };
  const likeEsc = (p: string) => p.split('*').map((x) => x.replace(/[\\%_]/g, '\\$&')).join('%');
  const one = (f: Filter): unknown => {
    switch (f.op) {
      case 'true':
        return sql`(1 = 1)`;
      case 'false':
        return sql`(1 = 0)`;
      case 'and':
        return f.args.length ? ops.and(...f.args.map(one)) : sql`(1 = 1)`;
      case 'or':
        return f.args.length ? ops.or(...f.args.map(one)) : sql`(1 = 0)`;
      case 'eq':
      case 'ne':
      case 'lt':
      case 'lte':
      case 'gt':
      case 'gte': {
        return ops[f.op](col(f.field), 'ref' in f ? col(f.ref) : f.value);
      }
      case 'cmp': {
        const [l, r] = [term(f.left), term(f.right)];
        switch (f.cmp) {
          case 'eq':
            return sql`${l} = ${r}`;
          case 'ne':
            return sql`${l} <> ${r}`;
          case 'lt':
            return sql`${l} < ${r}`;
          case 'lte':
            return sql`${l} <= ${r}`;
          case 'gt':
            return sql`${l} > ${r}`;
          case 'gte':
            return sql`${l} >= ${r}`;
        }
      }
      case 'in':
        return f.values.length ? ops.inArray(col(f.field), f.values) : sql`(1 = 0)`;
      case 'not_in':
        return f.values.length ? ops.and(ops.notInArray(col(f.field), f.values), ops.isNotNull(col(f.field))) : sql`(1 = 1)`;
      case 'contains':
      case 'not_contains': {
        const c = col(f.field);
        const has = options.arrayFields?.includes(f.field) ? sql`${f.value} = ANY(${c})` : sql`${c} @> ${JSON.stringify([f.value])}::jsonb`;
        return f.op === 'contains' ? has : ops.and(ops.isNotNull(c), sql`NOT (${has})`);
      }
      case 'like':
        return ops.like(col(f.field), likeEsc(f.pattern));
      case 'not_like':
        return ops.notLike(col(f.field), likeEsc(f.pattern));
      case 'exists':
        return ops.isNotNull(col(f.field));
      case 'missing':
        return ops.isNull(col(f.field));
      case 'relation':
      case 'not_relation':
        throw new FilterCompileError('Relation conditions must be resolved first: pass resolve_relations to partial_evaluate.');
    }
  };
  return one(filter);
}
