import { describe, expect, it } from 'vitest';
import { memoryMirrorStore, postgresMirrorStore, redisMirrorStore, type MirrorRedisClient } from './stores';
import { prismaMirrorStore } from './prisma';

const rec = (id: string, version: number) => ({ resource_type: 'user' as const, resource_id: id, version, data: { id } });

describe('memoryMirrorStore', () => {
  it('guards writes by version', async () => {
    const s = memoryMirrorStore();
    expect(await s.upsert(rec('a', 5))).toBe(true);
    expect(await s.upsert(rec('a', 5))).toBe(false);
    expect(await s.upsert(rec('a', 4))).toBe(false);
    expect(await s.remove('user', 'a', 4)).toBe(false);
    expect(await s.remove('user', 'a', 5)).toBe(true);
    expect(await s.get('user', 'a')).toBeNull();
  });
});

describe('postgresMirrorStore', () => {
  it('refuses a table name that is not a plain identifier', () => {
    expect(() => postgresMirrorStore(async () => ({ rows: [] }), { table: 'x; drop table y' })).toThrow(/identifier/);
  });

  it('upserts with a version guard and reports whether a row was written', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const s = postgresMirrorStore(async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }, { table: 'mirror_t' });
    expect(await s.upsert(rec('a', 3))).toBe(false);
    expect(calls[0]!.sql).toContain('INSERT INTO mirror_t');
    expect(calls[0]!.sql).toContain('WHERE t.version < EXCLUDED.version');
    expect(calls[0]!.params).toEqual(['user', 'a', 3, '{"id":"a"}']);
    expect(s.migrationSql()).toContain('mirror_t_state');
  });

  it('reads the cursor and returns pruned ids', async () => {
    const s = postgresMirrorStore(async (sql) =>
      sql.startsWith('SELECT cursor') ? { rows: [{ cursor: '42' }] } : { rows: [{ resource_id: 'x' }, { resource_id: 'y' }] },
    );
    expect(await s.getCursor()).toBe(42);
    expect(await s.pruneBefore('user', 9)).toEqual(['x', 'y']);
  });
});

describe('redisMirrorStore', () => {
  it('keys hashes by type, encodes version with the data and reads the cursor', async () => {
    const evals: Array<{ keys: string; args: string[] }> = [];
    const redis: MirrorRedisClient = {
      get: async () => '7',
      set: async () => 'OK',
      hget: async () => JSON.stringify({ v: 3, d: { id: 'a' } }),
      hgetall: async () => ({ a: JSON.stringify({ v: 3, d: { id: 'a' } }) }),
      eval: async (_s, _n, key, ...args) => {
        evals.push({ keys: key!, args });
        return 1;
      },
    };
    const s = redisMirrorStore(redis, { prefix: 'p' });
    expect(await s.getCursor()).toBe(7);
    expect(await s.upsert(rec('a', 3))).toBe(true);
    expect(evals[0]).toEqual({ keys: 'p:user', args: ['a', '3', '{"v":3,"d":{"id":"a"}}'] });
    expect((await s.get('user', 'a'))!.version).toBe(3);
    expect(await s.pruneBefore('user', 9)).toEqual(['a']);
  });
});

describe('prismaMirrorStore', () => {
  function fakePrisma() {
    const rows = new Map<string, Record<string, any>>();
    const delegate = {
      async updateMany({ where, data }: any) {
        const row = rows.get(where.id);
        if (!row || !(row.v === null || row.v < where.OR[1].v.lt)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
      async findUnique({ where }: any) {
        return rows.get(where.id) ?? null;
      },
      async create({ data }: any) {
        rows.set(data.id, data);
      },
    };
    return { prisma: { atlasUser: delegate }, rows };
  }

  it('creates a missing row, updates a lower version, drops an equal one', async () => {
    const { prisma, rows } = fakePrisma();
    const s = prismaMirrorStore({
      prisma,
      models: { user: { model: 'atlasUser', fields: { id: 'id', version: 'v' }, map: (d) => ({ email: d.email }) } },
      cursor: { get: async () => null, set: async () => undefined },
    });
    expect(await s.upsert({ ...rec('a', 3), data: { id: 'a', email: 'x' } })).toBe(true);
    expect(rows.get('a')).toMatchObject({ id: 'a', v: 3, email: 'x' });
    expect(await s.upsert(rec('a', 3))).toBe(false);
    expect(await s.upsert({ ...rec('a', 4), data: { id: 'a', email: 'y' } })).toBe(true);
    expect(rows.get('a')!.email).toBe('y');
  });

  it('refuses soft delete without a deletedAt field', async () => {
    const s = prismaMirrorStore({
      prisma: {},
      models: { user: { model: 'u', fields: { id: 'id', version: 'v' }, map: () => ({}), onDelete: 'soft' } },
      cursor: { get: async () => null, set: async () => undefined },
    });
    await expect(s.get('user', 'a')).rejects.toThrow(/deletedAt/);
  });
});
