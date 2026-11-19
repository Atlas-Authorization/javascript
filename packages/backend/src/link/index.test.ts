import { describe, expect, it } from 'vitest';
import { sqlUserLink } from './index';
import { describeUserLinkContract } from './testing';

// node:sqlite (Node 22.5+) is a real SQL engine with RETURNING and unique indexes, no install needed.
const { DatabaseSync } = (process as any).getBuiltinModule('node:sqlite');

function fresh(policy?: 'verified_email_oldest' | 'strict') {
  const db = new DatabaseSync(':memory:');
  db.exec('create table users (id integer primary key autoincrement, email text, atlas_sub text, name text)');
  db.exec('create unique index users_sub on users (atlas_sub)');
  const query = async (sql: string, params: unknown[]) => {
    const st = db.prepare(sql);
    if (/^\s*select|\sreturning\s/i.test(sql)) return { rows: st.all(...params) as any[] };
    const r = st.run(...params);
    return { rows: [], affectedRows: Number(r.changes) };
  };
  const link = sqlUserLink({
    query,
    dialect: 'sqlite',
    table: 'users',
    idColumn: 'id',
    emailColumn: 'email',
    subColumn: 'atlas_sub',
    policy,
    create: (c) => ({ name: c.name ?? null }),
  });
  const seed = async (row: { email: string; sub: string | null }) =>
    Number(db.prepare('insert into users (email, atlas_sub) values (?, ?)').run(row.email, row.sub).lastInsertRowid);
  return { db, link, seed, query };
}

for (const policy of ['verified_email_oldest', 'strict'] as const) {
  const { db, link, seed } = fresh(policy);
  describeUserLinkContract(link, { describe, it, expect, reset: () => void db.exec('delete from users'), seed });
}

describe('sqlUserLink', () => {
  it('links the OLDEST unbound row', async () => {
    const { link, seed } = fresh();
    const first = await seed({ email: 'x@example.com', sub: null });
    await seed({ email: 'X@example.com', sub: null });
    expect((await link.resolve({ sub: 's', email: 'x@example.com', email_verified: true })).localId).toBe(first);
  });

  it('writes create() columns on a new row', async () => {
    const { db, link } = fresh();
    await link.resolve({ sub: 's', email: 'n@example.com', email_verified: true, name: 'Nia' });
    expect(db.prepare('select name, email from users').get()).toMatchObject({ name: 'Nia', email: 'n@example.com' });
  });

  it('rejects an unsafe identifier', () => {
    expect(() =>
      sqlUserLink({ query: async () => ({ rows: [] }), table: 'users; drop table users', idColumn: 'id', emailColumn: 'e', subColumn: 's' }),
    ).toThrow(/plain table or column/);
  });

  it('uses numbered placeholders on postgres and backticks on mysql', async () => {
    const seen: string[] = [];
    const rec = (rows: any[]) => async (sql: string) => (seen.push(sql), { rows, affectedRows: 0 });
    await sqlUserLink({ query: rec([{ local_id: 1 }]), table: 'u', idColumn: 'id', emailColumn: 'e', subColumn: 's' }).resolve({ sub: 'x' });
    expect(seen[0]).toContain('$1');
    seen.length = 0;
    await sqlUserLink({ query: rec([{ local_id: 1 }]), dialect: 'mysql', table: 'u', idColumn: 'id', emailColumn: 'e', subColumn: 's' }).resolve({ sub: 'x' });
    expect(seen[0]).toContain('`s` = ?');
  });
});
