import { describe, expect, it } from 'vitest';
import { AtlasLinkConflictError, syncLocalUser, type NewLocalUser } from './sync-local-user';

interface Row { id: number; sub: string | null; email: string | null; emailVerified: boolean }

/** An in-memory table with unique indexes on sub and email, and async gaps like a real DB. */
function store(seed: Row[] = []) {
  const rows = [...seed];
  let next = rows.length + 1;
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const opts = {
    findBySub: async (sub: string) => { await tick(); return rows.find((r) => r.sub === sub) ?? null; },
    findByEmail: async (email: string) => { await tick(); return rows.find((r) => r.email === email) ?? null; },
    subOf: (r: Row) => r.sub,
    isLocalEmailVerified: (r: Row) => r.emailVerified,
    link: async (r: Row, sub: string) => { await tick(); r.sub = sub; return r; },
    create: async (u: NewLocalUser): Promise<Row> => {
      await tick();
      if (rows.some((r) => r.sub === u.sub)) throw Object.assign(new Error('dup'), { code: '23505' });
      if (u.email && rows.some((r) => r.email === u.email)) throw new Error('duplicate key value violates unique constraint "users_email"');
      const row = { id: next++, sub: u.sub, email: u.email ?? null, emailVerified: u.email_verified };
      rows.push(row);
      return row;
    },
  };
  return { rows, opts };
}

describe('syncLocalUser', () => {
  it('returns the row bound to the sub', async () => {
    const { opts } = store([{ id: 1, sub: 'user_a', email: 'a@x.test', emailVerified: true }]);
    expect(await syncLocalUser({ sub: 'user_a' }, opts)).toEqual({ user: expect.objectContaining({ id: 1 }), created: false, linked: false });
  });

  it('links an unbound row when both sides proved the email', async () => {
    const { opts, rows } = store([{ id: 1, sub: null, email: 'a@x.test', emailVerified: true }]);
    const r = await syncLocalUser({ sub: 'user_a', email: 'a@x.test', email_verified: true }, opts);
    expect(r).toMatchObject({ created: false, linked: true });
    expect(rows[0]!.sub).toBe('user_a');
  });

  it('never links on an unverified token email', async () => {
    const { opts, rows } = store([{ id: 1, sub: null, email: 'a@x.test', emailVerified: true }]);
    await expect(syncLocalUser({ sub: 'user_a', email: 'a@x.test', email_verified: false }, opts)).rejects.toThrow(/duplicate/);
    expect(rows[0]!.sub).toBeNull();
  });

  it('never links a row whose local email was not proven (pre-account hijacking)', async () => {
    const { opts, rows } = store([{ id: 1, sub: null, email: 'a@x.test', emailVerified: false }]);
    await expect(syncLocalUser({ sub: 'user_a', email: 'a@x.test', email_verified: true }, opts)).rejects.toThrow(/duplicate/);
    expect(rows[0]!.sub).toBeNull();
  });

  it('refuses to relink a row bound to another sub', async () => {
    const { opts } = store([{ id: 1, sub: 'user_old', email: 'a@x.test', emailVerified: true }]);
    const err = await syncLocalUser({ sub: 'user_new', email: 'a@x.test', email_verified: true }, opts).catch((e) => e);
    expect(err).toBeInstanceOf(AtlasLinkConflictError);
    expect(err).toMatchObject({ code: 'atlas_link_conflict', existingSub: 'user_old', sub: 'user_new' });
  });

  it('creates with the claims', async () => {
    const { opts, rows } = store();
    const r = await syncLocalUser({ sub: 'user_a', email: 'a@x.test', email_verified: true, external_id: 'ext_1' }, opts);
    expect(r).toMatchObject({ created: true, linked: false });
    expect(rows).toEqual([{ id: 1, sub: 'user_a', email: 'a@x.test', emailVerified: true }]);
  });

  it('parallel first logins for one sub end on one row', async () => {
    const { opts, rows } = store();
    const results = await Promise.all(Array.from({ length: 8 }, () => syncLocalUser({ sub: 'user_a', email: 'a@x.test', email_verified: true }, opts)));
    expect(rows).toHaveLength(1);
    expect(new Set(results.map((r) => r.user.id))).toEqual(new Set([1]));
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });

  it('rethrows a non-duplicate create error', async () => {
    const { opts } = store();
    await expect(syncLocalUser({ sub: 'user_a' }, { ...opts, create: async () => { throw new Error('boom'); } })).rejects.toThrow('boom');
  });
});
