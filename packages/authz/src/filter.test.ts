import { describe, expect, it } from 'vitest';
import { FilterCompileError, evalFilter, filterToDrizzle, filterToPrisma, filterToSql, type DrizzleOps, type Filter } from './filter';

const dept: Filter = { op: 'eq', field: 'resource.department', value: 'eng' };
const COLS = { 'resource.department': 'department', 'resource.level': 'level', 'resource.tags': { column: 'tags', kind: 'array' as const }, 'resource.$id': 'id', 'resource.owner': 'owner' };

describe('evalFilter', () => {
  const rows = (r: Record<string, unknown>) => ({ resource: r });
  it('treats a missing field as false for every leaf', () => {
    for (const f of [dept, { op: 'ne', field: 'resource.department', value: 'x' }, { op: 'lt', field: 'resource.level', value: 3 }, { op: 'in', field: 'resource.department', values: ['a'] }, { op: 'contains', field: 'resource.tags', value: 'a' }] as Filter[]) {
      expect(evalFilter(f, rows({}))).toBe(false);
    }
    expect(evalFilter({ op: 'missing', field: 'resource.department' }, rows({}))).toBe(true);
  });
  it('compares fields, arithmetic and entity references', () => {
    expect(evalFilter({ op: 'eq', field: 'resource.a', ref: 'resource.b' }, rows({ a: 1, b: 1 }))).toBe(true);
    expect(evalFilter({ op: 'cmp', cmp: 'gt', left: { arith: 'add', left: { field: 'resource.a' }, right: { value: 1 } }, right: { value: 2 } }, rows({ a: 2 }))).toBe(true);
    expect(evalFilter({ op: 'eq', field: 'resource.owner', value: 'User::u1' }, rows({ owner: { type: 'User', id: 'u1' } }))).toBe(true);
    expect(evalFilter({ op: 'like', field: 'resource.department', pattern: 'e*g' }, rows({ department: 'eng' }))).toBe(true);
  });
  it('refuses an unresolved relation', () => {
    expect(() => evalFilter({ op: 'relation', relation: 'viewer', type: 'doc', field: 'resource.$id', subject: 'user:a' }, rows({}))).toThrow(FilterCompileError);
  });
});

describe('filterToSql', () => {
  it('parameterises values and quotes columns (postgres)', () => {
    const f: Filter = { op: 'and', args: [dept, { op: 'lte', field: 'resource.level', value: 3 }, { op: 'contains', field: 'resource.tags', value: 'a' }] };
    expect(filterToSql(f, { columns: COLS })).toEqual({
      text: '(("department" = $1) AND ("level" <= $2) AND ($3 = ANY("tags")))',
      params: ['eng', 3, 'a'],
    });
    expect(filterToSql(f, { columns: COLS, paramOffset: 4 }).text).toContain('$5');
  });

  it('uses ? placeholders for mysql and sqlite, and json containment for sets', () => {
    const c = filterToSql({ op: 'contains', field: 'resource.tags', value: 'a' }, { columns: { 'resource.tags': 'tags' }, dialect: 'mysql' });
    expect(c).toEqual({ text: '(JSON_CONTAINS(`tags`, ?))', params: ['"a"'] });
    const s = filterToSql({ op: 'not_contains', field: 'resource.tags', value: 'a' }, { columns: { 'resource.tags': 'tags' }, dialect: 'sqlite' });
    expect(s.text).toBe('("tags" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM json_each("tags") WHERE value = ?))');
  });

  it('never interpolates a value or an unmapped field', () => {
    const evil = "x'; DROP TABLE users; --";
    const out = filterToSql({ op: 'eq', field: 'resource.department', value: evil }, { columns: COLS });
    expect(out.text).not.toContain('DROP');
    expect(out.params).toEqual([evil]);
    expect(() => filterToSql({ op: 'eq', field: 'resource.nope', value: 1 }, { columns: COLS })).toThrow(/No column is mapped/);
    expect(() => filterToSql(dept, { columns: { 'resource.department': 'department"; DROP TABLE x; --' } })).toThrow(/not a safe column name/);
    expect(() => filterToSql(dept, { columns: { 'resource.department': { column: 'data', json: "a'b" } } })).toThrow(/not a safe JSON path/);
  });

  it('escapes LIKE wildcards in the pattern and keeps * as the wildcard', () => {
    const out = filterToSql({ op: 'like', field: 'resource.department', pattern: '100%_a*' }, { columns: COLS });
    expect(out.params).toEqual(['100\\%\\_a%']);
    expect(out.text).toBe("(\"department\" LIKE $1 ESCAPE '\\')");
  });

  it('handles empty lists, constants, arithmetic, ids and json paths', () => {
    expect(filterToSql({ op: 'in', field: 'resource.$id', values: [] }, { columns: COLS }).text).toBe('(1 = 0)');
    expect(filterToSql({ op: 'not_in', field: 'resource.$id', values: [] }, { columns: COLS }).text).toBe('(1 = 1)');
    expect(filterToSql({ op: 'in', field: 'resource.$id', values: ['a', 'b'] }, { columns: COLS })).toEqual({ text: '("id" = ANY($1))', params: [['a', 'b']] });
    expect(filterToSql({ op: 'in', field: 'resource.$id', values: ['a', 'b'] }, { columns: COLS, dialect: 'mysql' })).toEqual({ text: '(`id` IN (?, ?))', params: ['a', 'b'] });
    expect(filterToSql({ op: 'true' }, { columns: {} }).text).toBe('(1 = 1)');
    const cmp = filterToSql({ op: 'cmp', cmp: 'gt', left: { arith: 'mul', left: { field: 'resource.level' }, right: { value: 2 } }, right: { value: 4 } }, { columns: COLS });
    expect(cmp).toEqual({ text: '(("level" * $1) > $2)', params: [2, 4] });
    const j = filterToSql({ op: 'gte', field: 'resource.level', value: 2 }, { columns: { 'resource.level': { column: 'metadata', json: 'stats.level' } } });
    expect(j.text).toBe(`(("metadata" #>> '{stats,level}')::numeric >= $1)`);
    expect(() => filterToSql({ op: 'relation', relation: 'v', type: 'doc', field: 'resource.$id', subject: 'user:a' }, { columns: COLS })).toThrow(/resolved first/);
  });
});

describe('filterToPrisma', () => {
  const fields = { 'resource.department': 'department', 'resource.tags': 'tags', 'resource.owner': 'owner.name', 'resource.level': 'level' };
  it('builds a where object', () => {
    const f: Filter = { op: 'or', args: [dept, { op: 'and', args: [{ op: 'gt', field: 'resource.level', value: 2 }, { op: 'contains', field: 'resource.tags', value: 'a' }] }] };
    expect(filterToPrisma(f, { fields })).toEqual({ OR: [{ department: { equals: 'eng' } }, { AND: [{ level: { gt: 2 } }, { tags: { has: 'a' } }] }] });
    expect(filterToPrisma({ op: 'eq', field: 'resource.owner', value: 'x' }, { fields })).toEqual({ owner: { name: { equals: 'x' } } });
    expect(filterToPrisma({ op: 'true' }, { fields })).toEqual({});
    expect(filterToPrisma({ op: 'like', field: 'resource.department', pattern: 'e*' }, { fields })).toEqual({ department: { startsWith: 'e' } });
  });
  it('refuses what Prisma cannot say', () => {
    expect(() => filterToPrisma({ op: 'like', field: 'resource.department', pattern: 'a*b' }, { fields })).toThrow(FilterCompileError);
    expect(() => filterToPrisma({ op: 'eq', field: 'resource.department', ref: 'resource.level' }, { fields })).toThrow(FilterCompileError);
    expect(() => filterToPrisma({ op: 'eq', field: 'resource.zzz', value: 1 }, { fields })).toThrow(/No Prisma field/);
  });
});

describe('filterToDrizzle', () => {
  const sqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings.join('?'), values });
  const ops: DrizzleOps = {
    and: (...c) => ({ and: c }),
    or: (...c) => ({ or: c }),
    eq: (a, b) => ({ eq: [a, b] }),
    ne: (a, b) => ({ ne: [a, b] }),
    gt: (a, b) => ({ gt: [a, b] }),
    gte: (a, b) => ({ gte: [a, b] }),
    lt: (a, b) => ({ lt: [a, b] }),
    lte: (a, b) => ({ lte: [a, b] }),
    inArray: (a, v) => ({ inArray: [a, v] }),
    notInArray: (a, v) => ({ notInArray: [a, v] }),
    isNull: (a) => ({ isNull: a }),
    isNotNull: (a) => ({ isNotNull: a }),
    like: (a, p) => ({ like: [a, p] }),
    notLike: (a, p) => ({ notLike: [a, p] }),
    sql: sqlTag,
  };
  const columns = { 'resource.department': 'COL_DEPT', 'resource.level': 'COL_LEVEL', 'resource.tags': 'COL_TAGS' };
  it('calls the supplied operators with the mapped columns', () => {
    expect(filterToDrizzle({ op: 'and', args: [dept, { op: 'in', field: 'resource.level', values: [1, 2] }] }, { columns, ops })).toEqual({
      and: [{ eq: ['COL_DEPT', 'eng'] }, { inArray: ['COL_LEVEL', [1, 2]] }],
    });
    expect(filterToDrizzle({ op: 'contains', field: 'resource.tags', value: 'a' }, { columns, ops, arrayFields: ['resource.tags'] })).toMatchObject({ values: ['a', 'COL_TAGS'] });
    expect(() => filterToDrizzle({ op: 'eq', field: 'resource.q', value: 1 }, { columns, ops })).toThrow(/No Drizzle column/);
  });
});
