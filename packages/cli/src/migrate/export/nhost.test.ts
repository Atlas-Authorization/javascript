import { createCipheriv, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';
import { byteaToBase64url, decryptTotp, exportNhost, fetchNhostRows, nhostGraphqlUrl, readNhostDump, refreshTokenHash, type NhostRows } from './nhost';

/**
 * Nhost's auth schema as Hasura serves it to the admin role (camelCase custom
 * names, bytea as `\x…` hex, refresh_token_hash as `\x` + hex sha256 of the
 * refresh token UUID), and the same tables dumped with psql (snake_case).
 */
const GQL = nhostGraphqlUrl({ subdomain: 'abcdefgh', region: 'eu-central-1' });
const HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
const KEY = Buffer.alloc(32, 7);
const TOTP_PLAIN = 'JBSWY3DPEHPK3PXP';

/** hex(nonce || ciphertext || tag): the format current Nhost writes to users.totp_secret. */
function encryptLikeNhost(plain: string): string {
  const nonce = Buffer.alloc(12, 3);
  const c = createCipheriv('aes-256-gcm', KEY, nonce);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([nonce, body, c.getAuthTag()]).toString('hex');
}

const LIVE = '2f3c9d1e-5b6a-4c7d-8e9f-0a1b2c3d4e5f';
const LIVE_HASH = '454b783724805d3b60f2cde911a04c6605e83628c05b78684bdb44baf24a1794';

const ROWS: NhostRows = {
  users: [
    {
      id: '6b1c4a0e-0000-4000-8000-000000000001', createdAt: '2024-01-02T03:04:05+00:00', lastSeen: '2024-05-01T00:00:00+00:00', disabled: false,
      displayName: 'Ada Lovelace', avatarUrl: 'https://www.gravatar.com/avatar/x', locale: 'en', email: 'Ada@Example.com', phoneNumber: '+14155550100',
      passwordHash: HASH, emailVerified: true, phoneNumberVerified: false, defaultRole: 'user', isAnonymous: false,
      totpSecret: encryptLikeNhost(TOTP_PLAIN), activeMfaType: 'totp', metadata: { plan: 'pro' },
    },
    {
      id: '6b1c4a0e-0000-4000-8000-000000000002', createdAt: '2024-01-03T00:00:00+00:00', disabled: true, displayName: '', avatarUrl: '', locale: 'fr',
      email: null, phoneNumber: '+33612345678', passwordHash: null, emailVerified: false, phoneNumberVerified: true, defaultRole: 'editor', isAnonymous: false,
      totpSecret: null, activeMfaType: 'sms', metadata: {},
    },
    { id: '6b1c4a0e-0000-4000-8000-000000000003', isAnonymous: true, email: null, phoneNumber: null, defaultRole: 'anonymous', metadata: null },
    { id: '6b1c4a0e-0000-4000-8000-000000000004', isAnonymous: false, email: null, phoneNumber: null },
  ],
  providers: [
    { id: 'p1', userId: '6b1c4a0e-0000-4000-8000-000000000001', providerId: 'github', providerUserId: '583231' },
    { id: 'p2', userId: 'gone', providerId: 'google', providerUserId: '1' },
  ],
  securityKeys: [
    { id: 'k1', userId: '6b1c4a0e-0000-4000-8000-000000000001', credentialId: 'AQIDBAUG', credentialPublicKey: '\\xa50102032620012158', counter: 7, transports: 'internal,hybrid', nickname: 'MacBook' },
  ],
  userRoles: [
    { userId: '6b1c4a0e-0000-4000-8000-000000000001', role: 'user' },
    { userId: '6b1c4a0e-0000-4000-8000-000000000001', role: 'me' },
    { userId: '6b1c4a0e-0000-4000-8000-000000000001', role: 'Billing Admin' },
  ],
  refreshTokens: [
    { id: 'r1', userId: '6b1c4a0e-0000-4000-8000-000000000001', createdAt: '2024-05-01T00:00:00+00:00', expiresAt: '2030-01-01T00:00:00+00:00', refreshTokenHash: `\\x${LIVE_HASH}`, type: 'regular' },
    { id: 'r2', userId: '6b1c4a0e-0000-4000-8000-000000000001', expiresAt: '2020-01-01T00:00:00+00:00', refreshTokenHash: `\\x${'0'.repeat(64)}`, type: 'regular' },
    { id: 'r3', userId: '6b1c4a0e-0000-4000-8000-000000000001', expiresAt: '2030-01-01T00:00:00+00:00', refreshTokenHash: `\\x${'1'.repeat(64)}`, type: 'pat' },
  ],
};

const NOW = () => Date.parse('2025-01-01T00:00:00Z');

describe('exportNhost', () => {
  it('maps users, bcrypt hashes, roles, social links, security keys, TOTP, SMS factors and live refresh tokens', () => {
    const set = exportNhost(ROWS, { encryptionKey: KEY.toString('hex'), rpId: 'example.com', origin: 'abcdefgh (eu-central-1)', now: NOW });
    const users = set.list('user');
    expect(users.map((u) => u.id.slice(-1))).toEqual(['1', '2', '3']);
    expect(users[0]).toEqual({
      id: '6b1c4a0e-0000-4000-8000-000000000001',
      emails: [{ email: 'ada@example.com', verified: true, primary: true }],
      phones: [{ phone: '+14155550100', verified: false, primary: false }],
      name: 'Ada Lovelace',
      image_url: 'https://www.gravatar.com/avatar/x',
      password: { algorithm: 'auto', hash: HASH },
      roles: ['billing_admin'],
      public_metadata: { plan: 'pro', locale: 'en' },
      created_at: '2024-01-02T03:04:05+00:00',
      last_sign_in_at: '2024-05-01T00:00:00+00:00',
    });
    expect(users[1]).toMatchObject({ banned: true, roles: ['editor'], phones: [{ phone: '+33612345678', verified: true, primary: true }] });
    expect(users[1]!.password).toBeUndefined();
    expect(users[2]).toMatchObject({ anonymous: true });
    expect(users[2]!.roles).toBeUndefined();
    expect(set.omitted.user?.count).toBe(1);

    expect(set.list('role').map((r) => r.key)).toEqual(['billing_admin', 'editor']);
    expect(set.list('identity')).toEqual([{ id: 'p1', user_id: '6b1c4a0e-0000-4000-8000-000000000001', provider: 'github', provider_user_id: '583231', kind: 'oauth' }]);
    expect(set.list('mfa_factor')).toEqual([
      { user_id: '6b1c4a0e-0000-4000-8000-000000000001', type: 'totp', secret_base32: TOTP_PLAIN, digits: 6, period: 30, algorithm: 'SHA1', verified: true },
      { user_id: '6b1c4a0e-0000-4000-8000-000000000002', type: 'phone', phone: '+33612345678', verified: true },
    ]);
    expect(set.list('passkey')).toEqual([
      { id: 'k1', user_id: '6b1c4a0e-0000-4000-8000-000000000001', credential_id: 'AQIDBAUG', public_key: Buffer.from('a50102032620012158', 'hex').toString('base64url'), sign_count: 7, rp_id: 'example.com', transports: ['internal', 'hybrid'], name: 'MacBook' },
    ]);
    // Only the live, regular refresh token; the hash is what the bridge computes from the cookie.
    expect(set.list('session')).toEqual([{ id: 'r1', user_id: '6b1c4a0e-0000-4000-8000-000000000001', token_hash: LIVE_HASH, expires_at: '2030-01-01T00:00:00+00:00', created_at: '2024-05-01T00:00:00+00:00' }]);
    expect(createHash('sha256').update(LIVE).digest('hex')).toBe(LIVE_HASH);
    expect(set.omitted.session).toBeDefined();
    expect(set.manifest).toMatchObject({ origin: 'abcdefgh (eu-central-1)', providers: ['github'], rpId: 'example.com' });
  });

  it('leaves encrypted TOTP secrets and security keys out without the key and rp id', () => {
    const set = exportNhost(ROWS, { now: NOW });
    expect(set.list('mfa_factor').map((f) => f.type)).toEqual(['phone']);
    expect(set.omitted.mfa_factor?.reason).toMatch(/nhost-encryption-key/);
    expect(set.count('passkey')).toBe(0);
    expect(set.omitted.passkey?.reason).toMatch(/rp-id/);
  });

  it('keeps a legacy plaintext TOTP secret and rejects a wrong key', () => {
    const legacy = exportNhost({ ...ROWS, users: [{ ...ROWS.users[0]!, totpSecret: 'jbswy3dpehpk3pxp' }] }, { now: NOW });
    expect(legacy.list('mfa_factor')[0]).toMatchObject({ type: 'totp', secret_base32: 'JBSWY3DPEHPK3PXP' });
    const wrong = exportNhost(ROWS, { encryptionKey: 'ab'.repeat(32), now: NOW });
    expect(wrong.omitted.mfa_factor?.reason).toMatch(/does not decrypt/);
    expect(() => exportNhost(ROWS, { encryptionKey: 'abcd' })).toThrow(/64 hex/);
  });
});

describe('Nhost helpers', () => {
  it('reads refresh-token hashes and bytea', () => {
    expect(refreshTokenHash({ refreshTokenHash: `\\x${LIVE_HASH.toUpperCase()}` })).toBe(LIVE_HASH);
    expect(refreshTokenHash({ refreshToken: '9a8b7c6d-1111-4222-8333-944455556666' })).toBe('85eec96ec463b5fa1988318efdeb7d7a5b4e6d8ff9fc37b68bcff4ea576461fc');
    expect(refreshTokenHash({ refreshTokenHash: 'nope' })).toBeUndefined();
    expect(byteaToBase64url('\\x0102ff')).toBe('AQL_');
    expect(decryptTotp(encryptLikeNhost('ABC'), KEY)).toBe('ABC');
    expect(decryptTotp('00', KEY)).toBeUndefined();
  });
});

describe('fetchNhostRows', () => {
  it('reads every auth table through Hasura with the admin secret, paging users', async () => {
    const seen: string[] = [];
    const v = fakeVendor('https://abcdefgh.graphql.eu-central-1.nhost.run', {
      'POST /v1': ({ body, headers }: { body: unknown; headers: Headers }) => {
        expect(headers.get('x-hasura-admin-secret')).toBe('nhost-admin-secret');
        const query = (body as { query: string }).query;
        const root = /query \{ (\w+)\(/.exec(query)![1]!;
        const offset = Number(/offset: (\d+)/.exec(query)![1]);
        seen.push(`${root}@${offset}`);
        if (root === 'users') return { data: { users: offset === 0 ? Array.from({ length: 1000 }, (_, i) => ({ id: `u${i}`, email: `u${i}@example.com` })) : [ROWS.users[0]] } };
        if (root === 'authRefreshTokens' && query.includes(' type ')) return { errors: [{ message: "field 'type' not found in type: 'authRefreshTokens'" }] };
        const map: Record<string, unknown[]> = { authUserProviders: ROWS.providers, authUserSecurityKeys: ROWS.securityKeys, authUserRoles: ROWS.userRoles, authRefreshTokens: ROWS.refreshTokens };
        return { data: { [root]: map[root] } };
      },
    });
    const rows = await fetchNhostRows({ graphqlUrl: GQL, adminSecret: 'nhost-admin-secret', fetchImpl: v.fetchImpl, sleep: noSleep });
    expect(rows.users).toHaveLength(1001);
    expect(rows.refreshTokens).toHaveLength(3);
    expect(seen).toEqual(['users@0', 'users@1000', 'authUserProviders@0', 'authUserSecurityKeys@0', 'authUserRoles@0', 'authRefreshTokens@0', 'authRefreshTokens@0']);
    expect(v.calls[0]!.body).toMatchObject({ query: expect.stringContaining('passwordHash') });
  });

  it('surfaces a GraphQL error', async () => {
    const v = fakeVendor('https://abcdefgh.graphql.eu-central-1.nhost.run', { 'POST /v1': { errors: [{ message: 'access-denied' }] } });
    await expect(fetchNhostRows({ graphqlUrl: GQL, adminSecret: 'x', fetchImpl: v.fetchImpl, sleep: noSleep })).rejects.toThrow('access-denied');
  });
});

describe('readNhostDump', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('reads psql CSV dumps of the auth schema (snake_case, t/f booleans)', () => {
    dir = mkdtempSync(join(tmpdir(), 'nhost-dump-'));
    writeFileSync(
      join(dir, 'auth.users.csv'),
      ['id,email,email_verified,phone_number,password_hash,disabled,is_anonymous,default_role,display_name,metadata,created_at', `u1,ada@example.com,t,,${HASH},f,f,user,Ada,"{""plan"":""pro""}",2024-01-02 03:04:05+00`].join('\n'),
    );
    writeFileSync(join(dir, 'auth.refresh_tokens.csv'), `id,user_id,expires_at,refresh_token_hash,type\nr1,u1,2030-01-01T00:00:00Z,\\x${LIVE_HASH},regular\n`);
    writeFileSync(join(dir, 'auth.user_providers.json'), JSON.stringify([{ id: 'p1', user_id: 'u1', provider_id: 'google', provider_user_id: 'g1' }]));
    const rows = readNhostDump(dir);
    const set = exportNhost(rows, { now: NOW });
    expect(set.list('user')[0]).toMatchObject({ id: 'u1', emails: [{ email: 'ada@example.com', verified: true, primary: true }], password: { algorithm: 'auto', hash: HASH }, public_metadata: { plan: 'pro' } });
    expect(set.list('user')[0]!.banned).toBeUndefined();
    expect(set.list('session')[0]).toMatchObject({ token_hash: LIVE_HASH });
    expect(set.list('identity')[0]).toMatchObject({ provider: 'google', provider_user_id: 'g1' });
  });

  it('refuses a folder without auth.users', () => {
    dir = mkdtempSync(join(tmpdir(), 'nhost-dump-'));
    expect(() => readNhostDump(dir)).toThrow(/auth\.users/);
  });
});
