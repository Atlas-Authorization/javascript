import { createHash, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { appwritePasswordHash, appwriteTeamRole, exportAppwrite } from './appwrite';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';

/**
 * Appwrite Server API responses in the 1.6 model shapes (`{ total, users }`,
 * `$id`, `hashOptions` passed through raw), paged with JSON queries.
 */
const ORIGIN = 'https://cloud.appwrite.io';

const ADA = {
  $id: 'ada01',
  $createdAt: '2024-01-02T03:04:05.000+00:00',
  $updatedAt: '2024-01-02T03:04:05.000+00:00',
  name: 'Ada Lovelace',
  password: '$argon2id$v=19$m=65536,t=4,p=3$c29tZXNhbHQ$9sTbSlTio3Biev89thdrlKKiCaYsjjYVJxGAL3swxpQ',
  hash: 'argon2',
  hashOptions: { type: 'argon2', memoryCost: 65536, timeCost: 4, threads: 3 },
  registration: '2024-01-02T03:04:05.000+00:00',
  status: true,
  labels: ['admin', 'Beta Testers'],
  email: 'Ada@Example.com',
  phone: '+14155550100',
  emailVerification: true,
  phoneVerification: true,
  mfa: true,
  prefs: { theme: 'dark' },
  accessedAt: '2024-05-01T00:00:00.000+00:00',
};
const BOB = {
  $id: 'bob02',
  name: '',
  password: 'f2ff0f1ebb6a000551377b6a7bfb92fdc486133eb77409af96875eba25e977881788a919573f6b2c9132083b88d4c67316a63066cd083cee22c25b1ed67acd99',
  hash: 'scrypt',
  hashOptions: { type: 'scrypt', salt: 'Kq9vR2sXz', costCpu: 8, costMemory: 14, costParallel: 1, length: 64 },
  status: false,
  labels: [],
  email: 'bob@example.com',
  phone: '',
  emailVerification: false,
  phoneVerification: false,
  mfa: false,
  prefs: {},
};
const GUEST = { $id: 'anon03', name: '', password: '', hash: 'argon2', hashOptions: {}, status: true, labels: [], email: '', phone: '', mfa: false, prefs: {} };

function queries(url: URL): Array<{ method: string; values: unknown[] }> {
  return url.searchParams.getAll('queries[]').map((q) => JSON.parse(q) as { method: string; values: unknown[] });
}

function api(pageSize = 100) {
  return fakeVendor(ORIGIN, {
    'GET /v1/users': ({ url }: { url: URL }) => {
      const all = [ADA, BOB, GUEST];
      const after = queries(url).find((q) => q.method === 'cursorAfter')?.values[0];
      const start = after ? all.findIndex((u) => u.$id === after) + 1 : 0;
      return { total: all.length, users: all.slice(start, start + pageSize) };
    },
    'GET /v1/users/identities': {
      total: 2,
      identities: [
        { $id: 'idt1', userId: 'ada01', provider: 'github', providerUid: '583231', providerEmail: 'Ada@GitHub.example', providerAccessToken: '' },
        { $id: 'idt2', userId: 'ghost', provider: 'google', providerUid: '1', providerEmail: '' },
      ],
    },
    'GET /v1/users/ada01/mfa/factors': { totp: true, phone: true, email: false, recoveryCode: true },
    'GET /v1/users/ada01/mfa/recovery-codes': { recoveryCodes: ['a1b2c3d4e5', 'f6g7h8i9j0'] },
    'GET /v1/teams': { total: 1, teams: [{ $id: 'team1', name: 'Acme', total: 2, prefs: { tier: 'gold' }, $createdAt: '2024-02-01T00:00:00.000+00:00' }] },
    'GET /v1/teams/team1/memberships': {
      total: 3,
      memberships: [
        { $id: 'm1', userId: 'ada01', userEmail: 'ada@example.com', teamId: 'team1', roles: ['owner'], confirm: true, joined: '2024-02-01T00:00:00.000+00:00' },
        { $id: 'm2', userId: 'bob02', userEmail: 'bob@example.com', teamId: 'team1', roles: ['Editor'], confirm: true, joined: '2024-02-02T00:00:00.000+00:00' },
        { $id: 'm3', userId: 'carol', userEmail: 'Carol@Example.com', teamId: 'team1', roles: ['viewer'], confirm: false, invited: '2024-02-03T00:00:00.000+00:00' },
      ],
    },
  });
}

describe('exportAppwrite', () => {
  it('maps users, hashes, labels, identities, MFA, teams, memberships and invitations', async () => {
    const v = api();
    const set = await exportAppwrite({ projectId: 'proj1', apiKey: 'standard_key', recoveryCodes: true, fetchImpl: v.fetchImpl, sleep: noSleep });

    expect(v.calls.every((c) => c.headers.get('x-appwrite-project') === 'proj1' && c.headers.get('x-appwrite-key') === 'standard_key')).toBe(true);
    const users = set.list('user');
    expect(users.map((u) => u.id)).toEqual(['ada01', 'bob02', 'anon03']);
    expect(users[0]).toEqual({
      id: 'ada01',
      emails: [{ email: 'ada@example.com', verified: true, primary: true }],
      phones: [{ phone: '+14155550100', verified: true, primary: false }],
      name: 'Ada Lovelace',
      roles: ['admin', 'beta_testers'],
      public_metadata: { theme: 'dark' },
      created_at: '2024-01-02T03:04:05.000+00:00',
      last_sign_in_at: '2024-05-01T00:00:00.000+00:00',
      password: { algorithm: 'auto', hash: ADA.password },
    });
    expect(users[1]!.banned).toBe(true);
    expect(users[1]!.password).toMatchObject({ algorithm: 'scrypt', salt: 'Kq9vR2sXz', params: { n: 8, r: 14, p: 1, key_length: 64, salt_encoding: 'utf8', encoding: 'hex' } });
    expect(users[2]).toMatchObject({ id: 'anon03', anonymous: true });
    expect(users[2]!.password).toBeUndefined();

    expect(set.list('role')).toEqual([
      { key: 'admin', name: 'admin', scope: 'app' },
      { key: 'beta_testers', name: 'beta_testers', scope: 'app' },
      { key: 'editor', name: 'editor', scope: 'organization' },
      { key: 'viewer', name: 'viewer', scope: 'organization' },
    ]);
    // The identity of a user that is not exported is dropped.
    expect(set.list('identity')).toEqual([{ id: 'idt1', user_id: 'ada01', provider: 'github', provider_user_id: '583231', kind: 'oauth', email: 'ada@github.example' }]);
    expect(set.list('mfa_factor')).toEqual([
      { user_id: 'ada01', type: 'phone', phone: '+14155550100', verified: true },
      { user_id: 'ada01', type: 'backup_codes', backup_codes: ['a1b2c3d4e5', 'f6g7h8i9j0'], verified: true },
    ]);
    expect(set.omitted.mfa_factor?.count).toBe(1);
    expect(set.list('organization')).toEqual([{ id: 'team1', name: 'Acme', public_metadata: { tier: 'gold' }, created_at: '2024-02-01T00:00:00.000+00:00' }]);
    expect(set.list('membership').map((m) => [m.user_id, m.role])).toEqual([['ada01', 'admin'], ['bob02', 'editor']]);
    expect(set.list('invitation')).toEqual([{ id: 'm3', organization_id: 'team1', email: 'carol@example.com', role: 'viewer', status: 'pending', created_at: '2024-02-03T00:00:00.000+00:00' }]);
    expect(set.manifest.origin).toBe('https://cloud.appwrite.io/v1 project proj1');
    expect(set.manifest.providers).toEqual(['github']);
  });

  it('pages users with cursorAfter on the last $id', async () => {
    // A page size of 100 is fixed in the exporter: 3 users fit one page, so one call.
    const v = api();
    await exportAppwrite({ projectId: 'p', apiKey: 'k', skipTeams: true, fetchImpl: v.fetchImpl, sleep: noSleep });
    const userCalls = v.calls.filter((c) => new URL(c.url).pathname === '/v1/users');
    expect(userCalls).toHaveLength(1);
    expect(queries(new URL(userCalls[0]!.url))).toEqual([{ method: 'limit', values: [100] }]);
    expect(v.calls.some((c) => c.url.includes('/teams'))).toBe(false);
  });

  it('follows the cursor when a page is full', async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ $id: `u${String(i).padStart(3, '0')}`, email: `u${i}@example.com`, status: true }));
    const v = fakeVendor(ORIGIN, {
      'GET /v1/users': ({ url }: { url: URL }) => {
        const after = queries(url).find((q) => q.method === 'cursorAfter')?.values[0];
        const start = after ? many.findIndex((u) => u.$id === after) + 1 : 0;
        return { total: many.length, users: many.slice(start, start + 100) };
      },
      'GET /v1/users/identities': { total: 0, identities: [] },
    });
    const set = await exportAppwrite({ projectId: 'p', apiKey: 'k', skipTeams: true, fetchImpl: v.fetchImpl, sleep: noSleep });
    expect(set.count('user')).toBe(150);
    const second = v.calls.filter((c) => new URL(c.url).pathname === '/v1/users')[1]!;
    expect(queries(new URL(second.url))).toContainEqual({ method: 'cursorAfter', values: ['u099'] });
  });

  it('warns when recovery codes were not requested and when identities are unavailable', async () => {
    const v = fakeVendor(ORIGIN, {
      'GET /v1/users': { total: 1, users: [ADA] },
      'GET /v1/users/identities': { status: 404, body: { message: 'Route not found' } },
      'GET /v1/users/ada01/mfa/factors': { totp: false, phone: false, email: false, recoveryCode: true },
    });
    const set = await exportAppwrite({ projectId: 'p', apiKey: 'k', skipTeams: true, fetchImpl: v.fetchImpl, sleep: noSleep });
    expect(set.warnings.some((w) => w.includes('identities listing'))).toBe(true);
    expect(set.warnings.some((w) => w.includes('appwrite-recovery-codes'))).toBe(true);
    expect(set.count('mfa_factor')).toBe(0);
  });
});

describe('appwritePasswordHash', () => {
  const hash = (password: string, hashName: string, hashOptions: Record<string, unknown> = {}) => appwritePasswordHash({ password, hash: hashName, hashOptions });

  it('keeps self-describing argon2 / bcrypt digests', () => {
    expect(hash('$2y$08$abcdefghijklmnopqrstuuJ7uEoXOrsyDNM9fyDP7ZTSxNzAK1HYa', 'bcrypt').hash).toEqual({ algorithm: 'auto', hash: '$2y$08$abcdefghijklmnopqrstuuJ7uEoXOrsyDNM9fyDP7ZTSxNzAK1HYa' });
  });

  it('maps md5 and every SHA version to unsalted hex', () => {
    expect(hash('482C811DA5D5B4BC6D497FFA98491E38', 'md5').hash).toEqual({ algorithm: 'md5', hash: '482c811da5d5b4bc6d497ffa98491e38', params: { encoding: 'hex' } });
    const versions: Record<string, string> = {
      sha1: 'sha1', sha224: 'sha224', sha256: 'sha256', sha384: 'sha384', sha512: 'sha512',
      'sha512/224': 'sha512_224', 'sha512/256': 'sha512_256',
      'sha3-224': 'sha3_224', 'sha3-256': 'sha3_256', 'sha3-384': 'sha3_384', 'sha3-512': 'sha3_512',
    };
    for (const [version, algorithm] of Object.entries(versions)) {
      expect(hash('ab', 'sha', { type: 'sha', version }).hash?.algorithm).toBe(algorithm);
    }
    // PHP hash('sha512/256', 'password123') — the digest the import stores.
    const d = createHash('sha512-256').update('password123').digest('hex');
    expect(d).toBe('2a444beff5bec5ae7bd970374b5a734baa7a2f05b693e8336eda752cafa1501e');
    expect(hash(d, 'sha', { type: 'sha', version: 'sha512/256' }).hash).toEqual({ algorithm: 'sha512_256', hash: d, params: { encoding: 'hex' } });
  });

  it('guesses a versionless SHA by length (1.x sha3-512, 2.x sha256)', () => {
    const sha3 = '4ad2c01fc6007f58720b00fc99b978c2a17c577859d31fdbba4b3a749de9383ac4b0738aeaf0b13337db8bfeaf9d8f87faa236fc3c8a68fbf23eb6862fadb86e';
    expect(createHash('sha3-512').update('password123').digest('hex')).toBe(sha3);
    expect(hash(sha3, 'sha', { type: 'sha' })).toEqual({ hash: { algorithm: 'sha3_512', hash: sha3, params: { encoding: 'hex' } }, guessed: true });
    const sha256 = 'ef92b778bafe771e89245b89ecbc08a44a4e166c06659911881f383d4473e94f';
    expect(hash(sha256, 'sha', {}).hash?.algorithm).toBe('sha256');
    expect(hash('abcd', 'sha', {}).problem).toMatch(/unexpected length/);
  });

  it('carries plain scrypt with php-scrypt semantics (literal N, string salt, hex)', () => {
    const out = hash(BOB.password, 'scrypt', BOB.hashOptions).hash!;
    // The parameters reproduce the digest computed with Python's hashlib.scrypt (same as php-scrypt).
    const dk = scryptSync('password123', Buffer.from(out.salt!, 'utf8'), Number(out.params!.key_length), { N: Number(out.params!.n), r: Number(out.params!.r), p: Number(out.params!.p) });
    expect(dk.toString('hex')).toBe(out.hash);
    expect(hash(BOB.password, 'scrypt', { costCpu: 8 }).problem).toMatch(/without its salt/);
  });

  it('maps scryptMod onto Firebase scrypt with Appwrite\'s fixed cost', () => {
    const out = hash('lSrfV15cpx95/sZS2W9c9Kp6i/LVgQNDNC/qzrCnh1SAyZvqmZqAjTdn3aoItz+VHjoZilo78198JAdRuid5lQ==', 'scryptMod', {
      type: 'scryptMod',
      salt: '42xEC+ixf3L2lw==',
      saltSeparator: 'Bw==',
      signerKey: 'jxspr8Ki0RYycVU8zykbdLGjFQ3McFUH0uiiTvC8pVMXAn210wjLNmdZJzxUECKbm0QsEmYUSDzZvpjeJ9WmXA==',
    });
    expect(out.hash).toEqual({
      algorithm: 'scrypt_firebase',
      hash: 'lSrfV15cpx95/sZS2W9c9Kp6i/LVgQNDNC/qzrCnh1SAyZvqmZqAjTdn3aoItz+VHjoZilo78198JAdRuid5lQ==',
      salt: '42xEC+ixf3L2lw==',
      params: { signer_key: 'jxspr8Ki0RYycVU8zykbdLGjFQ3McFUH0uiiTvC8pVMXAn210wjLNmdZJzxUECKbm0QsEmYUSDzZvpjeJ9WmXA==', salt_separator: 'Bw==', rounds: 8, mem_cost: 14 },
    });
  });

  it('treats a phpass row holding a bcrypt digest as bcrypt, and reports unknown types', () => {
    expect(hash('$P$BzFJ3Xr2n0E5bR7FPMGUu8T0vMgkL/1', 'phpass').hash?.algorithm).toBe('phpass');
    expect(hash('$2a$08$abcdefghijklmnopqrstuuJ7uEoXOrsyDNM9fyDP7ZTSxNzAK1HYa', 'phpass').hash?.algorithm).toBe('auto');
    expect(hash('x', 'whirlpool').problem).toMatch(/unknown type "whirlpool"/);
  });

  it('turns team roles into one membership role', () => {
    expect(appwriteTeamRole(['owner', 'billing'])).toBe('admin');
    expect(appwriteTeamRole(['Billing Admin'])).toBe('billing_admin');
    expect(appwriteTeamRole([])).toBe('member');
  });
});
