import { createCipheriv, hkdfSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionTokenHash } from '@atlasauth/migrate';
import { afterAll, describe, expect, it } from 'vitest';
import { decryptGotrueColumn, exportSupabase, mapSupabaseTables, readTableDump, supabasePassword } from './supabase';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';

/**
 * auth-schema rows as `psql \copy … csv header` writes them (NULL as an empty
 * field, booleans t/f, jsonb as JSON text, bytea as \x hex) and as JSON dumps.
 */
const NOW = Date.parse('2026-10-01T00:00:00Z');
const JANE = 'a1b2c3d4-0000-4000-8000-000000000001';
const SAM = 'a1b2c3d4-0000-4000-8000-000000000002';
const GONE = 'a1b2c3d4-0000-4000-8000-000000000003';
const ANON = 'a1b2c3d4-0000-4000-8000-000000000004';
const FB = 'a1b2c3d4-0000-4000-8000-000000000005';
const SSO = '5a5a5a5a-0000-4000-8000-0000000000aa';

/** supabase/auth internal/crypto/password_test.go: password "mytestpassword". */
const FBSCRYPT =
  '$fbscrypt$v=1,n=14,r=8,p=1,ss=Bw==,sk=ou9tdYTGyYm8kuR6Dt0Bp0kDuAYoXrK16mbZO4yGwAn3oLspjnN0/c41v8xZnO1n14J3MjKj1b2g6AUCAlFwMw==$C0sHCg9ek77hsg==$zKVTMvnWVw5BBOZNUdnsalx4c4c7y/w7IS5p6Ut2+CfEFFlz37J9huyQfov4iizN8dbjvEJlM5tQaJP84+hfTw==';
const BCRYPT = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

const USERS_CSV = [
  'instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,last_sign_in_at,raw_app_meta_data,raw_user_meta_data,created_at,phone,phone_confirmed_at,banned_until,is_sso_user,deleted_at,is_anonymous',
  `00000000-0000-0000-0000-000000000000,${JANE},authenticated,authenticated,Jane@Example.com,${BCRYPT},2024-01-02 03:04:05.123+00,2026-09-01 10:00:00+00,"{""provider"": ""email"", ""providers"": [""email"", ""google""], ""plan"": ""pro""}","{""full_name"": ""Jane Doe"", ""avatar_url"": ""https://img.example/j.png""}",2024-01-01 00:00:00+00,14155550101,2024-01-03 00:00:00+00,,f,,f`,
  `00000000-0000-0000-0000-000000000000,${SAM},authenticated,service_admin,sam@example.com,"{""key_id"":""k1"",""alg"":""aes-gcm-hkdf"",""data"":""AAAA"",""nonce"":""BBBB""}",,,"{}","{}",2024-02-01 00:00:00+00,,,2027-01-01 00:00:00+00,t,,f`,
  `00000000-0000-0000-0000-000000000000,${GONE},authenticated,authenticated,gone@example.com,${BCRYPT},,,"{}","{}",2024-02-01 00:00:00+00,,,,f,2025-01-01 00:00:00+00,f`,
  `00000000-0000-0000-0000-000000000000,${ANON},authenticated,authenticated,,,,,"{}","{}",2024-02-01 00:00:00+00,,,,f,,t`,
  `00000000-0000-0000-0000-000000000000,${FB},authenticated,authenticated,fb@example.com,"${FBSCRYPT}",2024-01-02 00:00:00+00,,"{}","{}",2024-02-01 00:00:00+00,,,,f,,f`,
].join('\n');

const IDENTITIES_CSV = [
  'provider_id,user_id,identity_data,provider,last_sign_in_at,created_at,updated_at,email,id',
  `${JANE},${JANE},"{""sub"": ""${JANE}"", ""email"": ""jane@example.com""}",email,,2024-01-01 00:00:00+00,,jane@example.com,11111111-0000-4000-8000-000000000001`,
  `109384912,${JANE},"{""sub"": ""109384912"", ""email"": ""jane@gmail.com"", ""email_verified"": true, ""name"": ""Jane""}",google,,2024-01-01 00:00:00+00,,jane@gmail.com,11111111-0000-4000-8000-000000000002`,
  `sam@corp.example,${SAM},"{""sub"": ""sam@corp.example""}",sso:${SSO},,2024-01-01 00:00:00+00,,sam@corp.example,11111111-0000-4000-8000-000000000003`,
].join('\n');

const tables = () => ({
  users: [] as never[],
  sso_providers: [{ id: SSO, resource_id: 'corp', disabled: false }],
  sso_domains: [{ id: 'd1', sso_provider_id: SSO, domain: 'Corp.example' }],
  saml_providers: [{ id: 's1', sso_provider_id: SSO, entity_id: 'https://idp.corp.example', metadata_xml: '<EntityDescriptor/>', attribute_mapping: { keys: { email: { name: 'mail' } } } }],
  mfa_factors: [
    { id: 'f-totp', user_id: JANE, friendly_name: 'Phone app', factor_type: 'totp', status: 'verified', secret: 'JBSWY3DPEHPK3PXP', created_at: '2024-03-01T00:00:00Z' },
    { id: 'f-phone', user_id: JANE, factor_type: 'phone', status: 'verified', phone: '14155550199' },
    { id: 'f-new', user_id: JANE, factor_type: 'totp', status: 'unverified', secret: 'AAAA' },
    { id: 'f-enc', user_id: SAM, factor_type: 'totp', status: 'verified', secret: '{"key_id":"k1","alg":"aes-gcm-hkdf","data":"x","nonce":"y"}' },
    {
      id: 'f-wa',
      user_id: JANE,
      factor_type: 'webauthn',
      status: 'verified',
      friendly_name: 'YubiKey',
      web_authn_aaguid: 'cb69481e-8ff7-4039-93ec-0a2729a154a8',
      web_authn_credential: { id: 'q83vEjRWeJA=', publicKey: 'pQECAyYgASFY', transport: ['usb'], flags: { backupState: false }, authenticator: { signCount: 7 } },
    },
  ],
  webauthn_credentials: [{ id: 'w1', user_id: JANE, credential_id: '\\x0102ff', public_key: '\\xa50102', sign_count: '3', transports: '["internal","hybrid"]', backed_up: 't', friendly_name: 'MacBook', aaguid: 'adce0002-35bc-c60a-648b-0b25f1f05503', created_at: '2026-01-01 00:00:00+00' }],
  mfa_recovery_code_sets: [{ id: 'rs1', user_id: JANE, mfa_factor_id: 'f-totp' }],
  mfa_recovery_codes: [
    { id: 'rc1', mfa_recovery_code_set_id: 'rs1', code_hash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g' },
    { id: 'rc2', mfa_recovery_code_set_id: 'rs1', code_hash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA', consumed_at: '2025-01-01T00:00:00Z' },
  ],
  sessions: [
    { id: 'sess-1', user_id: JANE, aal: 'aal2', not_after: null, refreshed_at: '2026-09-30 00:00:00', ip: '203.0.113.9', user_agent: 'Mozilla/5.0' },
    { id: 'sess-2', user_id: JANE, aal: 'aal1', not_after: '2026-09-01T00:00:00Z' },
  ],
  refresh_tokens: [
    { id: '101', token: 'abcDEF123456', user_id: JANE, revoked: 'f', session_id: 'sess-1', created_at: '2026-09-30 00:00:00+00' },
    { id: '100', token: 'oldTOKEN0000', user_id: JANE, revoked: 't', session_id: 'sess-1' },
    { id: '102', token: 'expTOKEN1111', user_id: JANE, revoked: false, session_id: 'sess-2' },
  ],
});

const dir = mkdtempSync(join(tmpdir(), 'sb-dump-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('readTableDump', () => {
  it('reads CSV, JSON and NDJSON tables, auth. prefix dropped, NULL as null', () => {
    writeFileSync(join(dir, 'auth.users.csv'), USERS_CSV);
    writeFileSync(join(dir, 'identities.csv'), IDENTITIES_CSV);
    const t = tables();
    writeFileSync(join(dir, 'mfa_factors.json'), JSON.stringify(t.mfa_factors));
    writeFileSync(join(dir, 'sessions.ndjson'), t.sessions.map((s) => JSON.stringify(s)).join('\n'));
    writeFileSync(join(dir, 'notes.txt'), 'ignored');
    const read = readTableDump(dir);
    expect(Object.keys(read).sort()).toEqual(['identities', 'mfa_factors', 'sessions', 'users']);
    expect(read.users).toHaveLength(5);
    expect(read.users![1]!.email_confirmed_at).toBeNull();
    expect(read.sessions![0]!.id).toBe('sess-1');
  });
});

describe('exportSupabase from a dump', () => {
  it('maps users, hashes, identities, SSO, factors, passkeys, recovery codes and sessions', async () => {
    const { users: _u, ...rest } = tables();
    const fromDir = readTableDump(dir);
    const set = mapSupabaseTables({ ...rest, users: fromDir.users!, identities: fromDir.identities! }, { rpId: 'app.example.com', url: 'https://abcdefghijklmnopqrst.supabase.co', now: NOW });

    expect(set.list('user').map((u) => u.id)).toEqual([JANE, SAM, FB]);
    expect(set.omitted.user).toEqual({ count: 2, reason: expect.any(String) });
    const jane = set.list('user')[0]!;
    expect(jane).toMatchObject({
      emails: [{ email: 'jane@example.com', verified: true, primary: true }],
      phones: [{ phone: '+14155550101', verified: true, primary: true }],
      name: 'Jane Doe',
      image_url: 'https://img.example/j.png',
      password: { algorithm: 'auto', hash: BCRYPT },
      public_metadata: { plan: 'pro' },
      unsafe_metadata: { full_name: 'Jane Doe', avatar_url: 'https://img.example/j.png' },
      created_at: Date.parse('2024-01-01T00:00:00Z'),
      last_sign_in_at: Date.parse('2026-09-01T10:00:00Z'),
    });
    const sam = set.list('user')[1]!;
    expect(sam.password).toBeUndefined();
    expect(sam).toMatchObject({ banned: true, ban_expires_at: Date.parse('2027-01-01T00:00:00Z'), private_metadata: { supabase_role: 'service_admin', supabase_sso_user: true } });
    expect(set.list('user')[2]!.password).toEqual({
      algorithm: 'scrypt_firebase',
      hash: 'zKVTMvnWVw5BBOZNUdnsalx4c4c7y/w7IS5p6Ut2+CfEFFlz37J9huyQfov4iizN8dbjvEJlM5tQaJP84+hfTw==',
      salt: 'C0sHCg9ek77hsg==',
      params: { rounds: 8, mem_cost: 14, salt_separator: 'Bw==', signer_key: 'ou9tdYTGyYm8kuR6Dt0Bp0kDuAYoXrK16mbZO4yGwAn3oLspjnN0/c41v8xZnO1n14J3MjKj1b2g6AUCAlFwMw==' },
    });
    expect(set.warnings.join('\n')).toMatch(/column encryption/);

    expect(set.list('sso_connection')).toEqual([
      { id: SSO, name: 'corp', protocol: 'saml', domains: ['corp.example'], enabled: true, saml: { idp_entity_id: 'https://idp.corp.example', idp_metadata_xml: '<EntityDescriptor/>', attribute_mapping: { email: 'mail' } } },
    ]);
    expect(set.list('identity')).toEqual([
      expect.objectContaining({ user_id: JANE, provider: 'google', provider_user_id: '109384912', kind: 'oauth', email: 'jane@gmail.com', email_verified: true }),
      expect.objectContaining({ user_id: SAM, provider: 'saml', kind: 'saml', sso_connection_id: SSO, provider_user_id: 'sam@corp.example' }),
    ]);

    expect(set.list('mfa_factor')).toEqual([
      expect.objectContaining({ id: 'f-totp', type: 'totp', secret_base32: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30, algorithm: 'SHA1' }),
      expect.objectContaining({ id: 'f-phone', type: 'phone', phone: '+14155550199' }),
      { user_id: JANE, type: 'backup_codes', backup_code_hashes: [{ algorithm: 'auto', hash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g' }], verified: true },
    ]);
    expect(set.omitted.mfa_factor?.count).toBe(2);

    expect(set.list('passkey')).toEqual([
      expect.objectContaining({ id: 'f-wa', credential_id: 'q83vEjRWeJA', public_key: 'pQECAyYgASFY', sign_count: 7, rp_id: 'app.example.com', transports: ['usb'], name: 'YubiKey' }),
      expect.objectContaining({ id: 'w1', credential_id: 'AQL_', public_key: 'pQEC', sign_count: 3, transports: ['internal', 'hybrid'], backed_up: true, name: 'MacBook' }),
    ]);

    // One live session, keyed by the refresh token the SSR cookie holds; revoked and expired ones left out.
    expect(set.list('session')).toEqual([
      {
        id: '101',
        user_id: JANE,
        token_hash: sessionTokenHash('abcDEF123456'),
        expires_at: Date.parse('2026-09-30T00:00:00Z') + 30 * 24 * 3600_000,
        mfa_verified: true,
        created_at: Date.parse('2026-09-30T00:00:00Z'),
        ip: '203.0.113.9',
        user_agent: 'Mozilla/5.0',
      },
    ]);
    expect(set.omitted.session?.count).toBe(1);
    expect(set.manifest).toMatchObject({ origin: 'supabase abcdefghijklmnopqrst.supabase.co', rpId: 'app.example.com', providers: ['google', 'saml'] });
  });

  it('leaves passkeys out without a relying-party id', () => {
    const { users: _u, ...rest } = tables();
    const set = mapSupabaseTables({ ...rest, users: readTableDump(dir).users! }, { now: NOW });
    expect(set.list('passkey')).toEqual([]);
    expect(set.omitted.passkey).toEqual({ count: 2, reason: expect.stringContaining('--rp-id') });
  });

  it('refuses a dump without a users table', async () => {
    await expect(exportSupabase({ tables: { identities: [] } })).rejects.toThrow(/no users table/);
  });
});

describe('exportSupabase through the Admin API', () => {
  it('pages users and warns that hashes need a dump', async () => {
    const page = (n: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: `00000000-0000-4000-8000-${String(n * 10000 + i).padStart(12, '0')}`,
        email: `u${n}-${i}@example.com`,
        email_confirmed_at: '2024-01-01T00:00:00Z',
        app_metadata: { provider: 'email', providers: ['email', 'github'] },
        user_metadata: {},
        identities: i === 0 ? [{ identity_id: 'iid-1', id: '4242', user_id: undefined, provider: 'github', identity_data: { sub: '4242' } }] : [],
        factors: i === 0 ? [{ id: 'fx', factor_type: 'totp', status: 'verified' }] : [],
        created_at: '2024-01-01T00:00:00Z',
      }));
    const v = fakeVendor('https://abcdefghijklmnopqrst.supabase.co', {
      'GET /auth/v1/admin/users?page=1&per_page=1000': { users: page(1, 1000), aud: 'authenticated' },
      'GET /auth/v1/admin/users?page=2&per_page=1000': { users: page(2, 3), aud: 'authenticated' },
    });
    const set = await exportSupabase({ url: 'https://abcdefghijklmnopqrst.supabase.co', serviceRoleKey: 'sb_secret_test', fetchImpl: v.fetchImpl, sleep: noSleep, now: () => NOW });
    expect(set.count('user')).toBe(1003);
    // The same GitHub account on two users is kept once (the first user).
    expect(set.list('identity')).toEqual([expect.objectContaining({ id: 'iid-1', user_id: '00000000-0000-4000-8000-000000010000', provider: 'github', provider_user_id: '4242' })]);
    expect(set.omitted.mfa_factor?.reason).toMatch(/Admin API/);
    expect(set.warnings.join('\n')).toMatch(/lazy-migration/);
    expect(v.calls.every((c) => c.headers.get('apikey') === 'sb_secret_test')).toBe(true);
  });
});

describe('supabasePassword', () => {
  it('reads every encrypted_password format GoTrue writes', () => {
    expect(supabasePassword('')).toEqual({});
    expect(supabasePassword(BCRYPT)).toEqual({ password: { algorithm: 'auto', hash: BCRYPT } });
    expect(supabasePassword('$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA').password?.algorithm).toBe('auto');
    expect(supabasePassword('{"alg":"aes-gcm-hkdf"}')).toEqual({ problem: 'encrypted' });
    expect(supabasePassword('$fbscrypt$v=1,n=14,r=8,p=1$c2FsdA==$aGFzaA==')).toEqual({ problem: 'no_signer_key' });
    expect(supabasePassword('md5:abc')).toEqual({ problem: 'unknown' });
  });
});

describe('GoTrue column encryption', () => {
  // crypto.EncryptedString as GoTrue writes it: HKDF-SHA256(base64url key, info = row id) → AES-256-GCM.
  const KEY = Buffer.alloc(32, 9).toString('base64url');
  function encrypt(plain: string, rowId: string, keyId = 'k1'): string {
    const key = Buffer.from(hkdfSync('sha256', Buffer.from(KEY, 'base64url'), Buffer.alloc(0), Buffer.from(rowId), 32));
    const nonce = Buffer.alloc(12, 5);
    const c = createCipheriv('aes-256-gcm', key, nonce);
    const data = Buffer.concat([c.update(plain, 'utf8'), c.final(), c.getAuthTag()]);
    return JSON.stringify({ key_id: keyId, alg: 'aes-gcm-hkdf', data: data.toString('base64'), nonce: nonce.toString('base64') });
  }
  const USER = '1f0e2d3c-0000-4000-8000-00000000000a';
  const FACTOR = '1f0e2d3c-0000-4000-8000-00000000000f';

  it('opens a value with the matching key id or a bare key, bound to the row id', () => {
    const v = encrypt(BCRYPT, USER);
    expect(decryptGotrueColumn(v, USER, [`k1:${KEY}`])).toBe(BCRYPT);
    expect(decryptGotrueColumn(v, USER, [KEY])).toBe(BCRYPT);
    expect(decryptGotrueColumn(v, USER, [`k2:${KEY}`])).toBeUndefined();
    expect(decryptGotrueColumn(v, FACTOR, [KEY])).toBeUndefined();
    expect(decryptGotrueColumn(v, USER, [Buffer.alloc(32, 1).toString('base64url')])).toBeUndefined();
    expect(decryptGotrueColumn('{"alg":"other"}', USER, [KEY])).toBeUndefined();
  });

  it('carries encrypted password hashes and TOTP secrets when the keys are given, and counts them out otherwise', () => {
    const tables = {
      users: [{ id: USER, email: 'enc@example.com', email_confirmed_at: '2024-01-01T00:00:00Z', encrypted_password: encrypt(BCRYPT, USER), created_at: '2024-01-01T00:00:00Z' }],
      mfa_factors: [{ id: FACTOR, user_id: USER, factor_type: 'totp', status: 'verified', secret: encrypt('JBSWY3DPEHPK3PXP', FACTOR), created_at: '2024-01-01T00:00:00Z' }],
    };
    const open = mapSupabaseTables(tables, { dbEncryptionKeys: [`k1:${KEY}`], now: Date.parse('2025-01-01T00:00:00Z') });
    expect(open.list('user')[0]!.password).toEqual({ algorithm: 'auto', hash: BCRYPT });
    expect(open.list('mfa_factor')[0]).toMatchObject({ type: 'totp', secret_base32: 'JBSWY3DPEHPK3PXP' });
    const locked = mapSupabaseTables(tables, { now: Date.parse('2025-01-01T00:00:00Z') });
    expect(locked.list('user')[0]!.password).toBeUndefined();
    expect(locked.list('mfa_factor')).toEqual([]);
    expect(locked.warnings.join(' ')).toMatch(/supabase-db-encryption-keys/);
  });
});
