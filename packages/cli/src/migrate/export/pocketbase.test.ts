import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exportPocketBase, parseTable, pbTime, readPocketBaseDump, type PocketBaseTables } from './pocketbase';

/**
 * PocketBase tables as `sqlite3 -json pb_data/data.db "select * from …"`
 * prints them: v0.23 `_collections` (options and fields as JSON text,
 * booleans as 0/1), the `users` auth table with its bcrypt `password`
 * column, and `_externalAuths`.
 */
const HASH_ADA = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
const HASH_ROOT = '$2a$10$8K1p/a0dURXAm7QiTRqUzuN0/SpuDMaM9Zmz8tYO9Kz5jR6r5hGaa';

const COLLECTIONS = [
  { id: 'pbc_3142635823', system: 1, type: 'auth', name: '_superusers', options: '{"authToken":{"duration":86400}}', fields: '[]' },
  {
    id: '_pb_users_auth_',
    system: 0,
    type: 'auth',
    name: 'users',
    options: JSON.stringify({ passwordAuth: { enabled: true, identityFields: ['email'] }, oauth2: { enabled: true, providers: [{ name: 'google', clientId: 'g-123' }] }, authToken: { duration: 604800 } }),
    fields: '[{"name":"password","type":"password","min":8}]',
  },
  { id: 'pbc_posts', system: 0, type: 'base', name: 'posts', options: '{}', fields: '[]' },
];
const USERS = [
  { id: 'ada000000000001', email: 'Ada@Example.com', emailVisibility: 0, verified: 1, password: HASH_ADA, tokenKey: 'k'.repeat(50), name: 'Ada Lovelace', avatar: 'ada_x1.png', plan: 'pro', tags: '["a","b"]', created: '2024-01-02 03:04:05.123Z', updated: '2024-01-03 03:04:05.123Z' },
  { id: 'bob000000000002', email: 'bob@example.com', emailVisibility: 1, verified: 0, password: HASH_ADA, tokenKey: 'k'.repeat(50), name: '', avatar: '', created: '2024-01-04 00:00:00.000Z' },
  { id: 'nobody000000003', email: '', verified: 0, password: HASH_ADA, tokenKey: 'x' },
];
const SUPERUSERS = [{ id: 'root00000000001', email: 'root@example.com', verified: 1, password: HASH_ROOT, tokenKey: 'r' }];
const EXTERNAL = [
  { id: 'ea1', collectionRef: '_pb_users_auth_', recordRef: 'ada000000000001', provider: 'google', providerId: '1093849', created: '2024-01-02 03:04:05.123Z' },
  { id: 'ea2', collectionRef: '_pb_users_auth_', recordRef: 'gone00000000009', provider: 'github', providerId: '7' },
];

function tables(extra: Record<string, unknown[]> = {}): PocketBaseTables {
  const byName = new Map<string, Record<string, unknown>[]>([
    ['users', USERS],
    ['_superusers', SUPERUSERS],
    ['_externalAuths', EXTERNAL],
    ...Object.entries(extra).map(([k, v]) => [k, v as Record<string, unknown>[]] as [string, Record<string, unknown>[]]),
  ]);
  return { collections: COLLECTIONS.map((c) => ({ ...c, options: JSON.parse(c.options) as unknown, fields: JSON.parse(c.fields) as unknown })), tables: byName };
}

describe('exportPocketBase', () => {
  it('maps auth records, bcrypt hashes, custom fields and OAuth2 links; skips superusers', () => {
    const set = exportPocketBase(tables(), { url: 'https://pb.example.com/', origin: 'pb_data/data.db' });
    const users = set.list('user');
    expect(users.map((u) => u.id)).toEqual(['ada000000000001', 'bob000000000002']);
    expect(users[0]).toEqual({
      id: 'ada000000000001',
      emails: [{ email: 'ada@example.com', verified: true, primary: true }],
      name: 'Ada Lovelace',
      image_url: 'https://pb.example.com/api/files/_pb_users_auth_/ada000000000001/ada_x1.png',
      password: { algorithm: 'auto', hash: HASH_ADA },
      public_metadata: { plan: 'pro', tags: ['a', 'b'] },
      created_at: '2024-01-02T03:04:05.123Z',
    });
    expect(users[1]!.emails![0]!.verified).toBe(false);
    expect(set.omitted.user).toEqual({ count: 1, reason: 'record without an email or username' });
    // The link of a record that is not exported is dropped.
    expect(set.list('identity')).toEqual([{ id: 'ea1', user_id: 'ada000000000001', provider: 'google', provider_user_id: '1093849', kind: 'oauth' }]);
    expect(set.manifest).toMatchObject({ origin: 'pb_data/data.db', providers: ['google'] });
    // tokenKey never travels.
    expect(JSON.stringify(users)).not.toContain('kkkkk');
  });

  it('exports superusers when asked, tagged with their collection', () => {
    const set = exportPocketBase(tables(), { includeSuperusers: true });
    const root = set.list('user').find((u) => u.id === 'root00000000001')!;
    expect(root.password).toEqual({ algorithm: 'auto', hash: HASH_ROOT });
    expect(root.private_metadata).toEqual({ pocketbase_collection: '_superusers' });
  });

  it('reads ≤0.22 records (passwordHash, username, collectionId/recordId links)', () => {
    const old: PocketBaseTables = {
      collections: [{ id: '_pb_users_auth_', type: 'auth', name: 'users', options: { allowEmailAuth: true, allowUsernameAuth: true } }],
      tables: new Map([
        ['users', [{ id: 'u1', username: 'ada', email: '', verified: 0, passwordHash: HASH_ADA, lastResetSentAt: '' }]],
        ['_externalAuths', [{ id: 'e1', collectionId: '_pb_users_auth_', recordId: 'u1', provider: 'github', providerId: '42' }]],
      ]),
    };
    const set = exportPocketBase(old);
    expect(set.list('user')).toEqual([{ id: 'u1', username: 'ada', password: { algorithm: 'auto', hash: HASH_ADA } }]);
    expect(set.list('identity')[0]).toMatchObject({ user_id: 'u1', provider: 'github', provider_user_id: '42' });
  });

  it('exports only the named collections and warns about unknown ones', () => {
    const set = exportPocketBase(tables(), { collections: ['users', 'members'] });
    expect(set.count('user')).toBe(2);
    expect(set.warnings.some((w) => w.includes('"members" is not an auth collection'))).toBe(true);
  });
});

describe('PocketBase dump reader', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('reads sqlite3 -json files, NDJSON and CSV from a folder', () => {
    dir = mkdtempSync(join(tmpdir(), 'pb-dump-'));
    writeFileSync(join(dir, '_collections.json'), JSON.stringify(COLLECTIONS));
    writeFileSync(join(dir, 'users.json'), JSON.stringify(USERS));
    writeFileSync(join(dir, '_externalAuths.ndjson'), EXTERNAL.map((e) => JSON.stringify(e)).join('\n'));
    writeFileSync(join(dir, 'notes.txt'), 'ignored');
    const db = readPocketBaseDump(dir);
    expect(db.collections.find((c) => c.name === 'users')!.options).toMatchObject({ passwordAuth: { enabled: true } });
    const set = exportPocketBase(db);
    expect(set.count('user')).toBe(2);
    expect(set.count('identity')).toBe(1);
  });

  it('parses the table formats', () => {
    expect(parseTable('id,email\nu1,a@example.com\n', '.csv')).toEqual([{ id: 'u1', email: 'a@example.com' }]);
    expect(parseTable('{"rows":[{"id":"u1"}]}', '.json')).toEqual([{ id: 'u1' }]);
    expect(parseTable('', '.json')).toEqual([]);
    expect(pbTime('2024-01-02 03:04:05.123Z')).toBe('2024-01-02T03:04:05.123Z');
    expect(pbTime('')).toBeUndefined();
  });
});
