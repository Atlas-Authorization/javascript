import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateRecord } from '@atlasauth/migrate';
import { describe, expect, it } from 'vitest';
import { exportAppUsers } from './app-users';
import { exportAuthJs } from './authjs';
import { DEVISE_EXPORT_SCRIPT, exportDevise } from './devise';
import { DJANGO_EXPORT_SCRIPT, decodeSessionData, exportDjango } from './django';
import { base32, coseFromSec1, decryptGuideValue, exportLucia } from './lucia';
import { FrameworkExport, Tables, readDumpDir, tablesFromStream, time } from './tables';
import { parseAttestationObject } from './webauthn';
import { createCipheriv, randomBytes } from 'node:crypto';

/**
 * The framework exporters, run over dumps in the shapes the frameworks' own
 * tooling writes: a Prisma database exported with `psql \copy … csv`, a
 * MongoDB adapter exported with mongoexport (extended JSON), Lucia v2 tables
 * from `sqlite3 -json`, `manage.py dumpdata`, and the Rails runner script's
 * NDJSON stream (with the boot noise a real app prints first).
 */
const FIXTURES = join(__dirname, '../../../../fixtures/frameworks');
const NOW = new Date('2026-10-25T12:00:00Z');

/** Every record the exporter produced must pass the bundle writer's validation. */
function expectValid(out: FrameworkExport) {
  for (const [model, data] of out.entries()) expect(validateRecord(model, data), `${model} ${JSON.stringify(data)}`).toEqual([]);
}

describe('Auth.js', () => {
  it('maps a Prisma adapter dump', () => {
    const out = exportAuthJs(readDumpDir(join(FIXTURES, 'authjs-prisma')), { rpId: 'example.com', now: NOW });
    expectValid(out);
    const users = out.list('user');
    expect(users.map((u) => u.id)).toEqual(['clu1ada', 'clu2grace', 'clu4plain']);
    expect(users[0]).toMatchObject({
      emails: [{ email: 'ada@example.com', verified: true, primary: true }],
      first_name: 'Ada',
      last_name: 'Lovelace',
      image_url: 'https://avatars.example.com/ada.png',
      password: { algorithm: 'bcrypt', hash: '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy' },
    });
    expect(users[1]!.emails![0]!.verified).toBe(false);
    expect(users[2]!.password).toBeUndefined();
    expect(out.warnings.some((w) => w.includes('1 password value(s) are not a hash format'))).toBe(true);
    expect(out.omitted.user).toEqual({ count: 1, reason: expect.stringContaining('no email') });

    expect(out.list('identity')).toEqual([
      { user_id: 'clu1ada', provider: 'github', provider_user_id: '583231', kind: 'oauth', scopes: ['read:user', 'user:email'] },
      { user_id: 'clu2grace', provider: 'google', provider_user_id: '109876543210', kind: 'oidc', scopes: ['openid', 'email', 'profile'] },
    ]);
    expect(out.manifest.providers).toEqual(['github', 'google']);

    expect(out.list('passkey')).toEqual([
      {
        user_id: 'clu1ada',
        credential_id: 'q83vEjRWeJA',
        public_key: 'pQECAyYgASFYIA',
        sign_count: 7,
        rp_id: 'example.com',
        transports: ['internal', 'hybrid'],
        backed_up: true,
      },
    ]);

    expect(out.list('session')).toEqual([
      {
        id: 's1',
        user_id: 'clu1ada',
        token_hash: '1e635cac06a55e949a19b466f4806224e07d6304d9d29132c654c1964398697a',
        expires_at: '2026-11-20T08:00:00.000Z',
      },
    ]);
    expect(out.omitted.session).toEqual({ count: 1, reason: 'expired' });
  });

  it('carries OAuth tokens only when asked, with expires_at in seconds', () => {
    const out = exportAuthJs(readDumpDir(join(FIXTURES, 'authjs-prisma')), { oauthTokens: true, now: NOW });
    expect(out.list('identity')[1]).toMatchObject({ access_token: 'ya29.token', refresh_token: '1//refresh', expires_at: 1793000000000 });
    // Without an RP id the passkeys stay out, with the reason.
    expect(out.count('passkey')).toBe(0);
    expect(out.omitted.passkey?.reason).toContain('--rp-id');
  });

  it('maps a MongoDB adapter export (extended JSON)', () => {
    const out = exportAuthJs(readDumpDir(join(FIXTURES, 'authjs-mongo')), { now: NOW });
    expectValid(out);
    expect(out.list('user')[0]).toMatchObject({ id: '65f1c0ffee0000000000000a', emails: [{ email: 'mongo@example.com', verified: true }] });
    expect(out.list('identity')[0]).toMatchObject({ user_id: '65f1c0ffee0000000000000a', provider: 'discord' });
    expect(out.list('session')[0]).toMatchObject({ id: '65f1c0ffee0000000000000c', expires_at: '2026-11-18T11:06:40.000Z' });
  });
});

describe('Lucia', () => {
  it('maps v2 users, keys and sessions', () => {
    const out = exportLucia(readDumpDir(join(FIXTURES, 'lucia-v2')), { now: NOW });
    expectValid(out);
    expect(out.manifest.sourceVersion).toBe('lucia v1/v2');
    const [ada, grace] = out.list('user');
    expect(ada).toMatchObject({
      id: 'k3v9qz0w1m2n4b7',
      emails: [{ email: 'ada@example.com', verified: true, primary: true }],
      password: { algorithm: 'scrypt_lucia' },
    });
    expect(grace).toMatchObject({ id: 'p0o9i8u7y6t5r4e', username: 'grace' });
    expect(grace!.password).toBeUndefined();
    expect(out.omitted.user?.count).toBe(1);
    expect(out.list('identity')).toEqual([{ user_id: 'k3v9qz0w1m2n4b7', provider: 'github', provider_user_id: '583231', kind: 'oauth' }]);
    expect(out.list('session')).toEqual([
      {
        id: 'f2nq3w9r8t7y6u5i4o3p2a1s0d9f8g7h6j5k4l3z',
        user_id: 'k3v9qz0w1m2n4b7',
        token_hash: '5bff72c1541c49a0efd3def1391ffd523da0402578f555b0f275cdd42dcc4c9b',
        expires_at: new Date(1794000000000).toISOString(),
      },
    ]);
  });

  it('reads the guide schema: hashed session ids, encrypted TOTP + recovery code, SEC1 passkeys', () => {
    const key = randomBytes(16);
    const seal = (data: Buffer) => {
      const iv = randomBytes(16);
      const c = createCipheriv('aes-128-gcm', key, iv);
      return Buffer.concat([iv, c.update(data), c.final(), c.getAuthTag()]).toString('base64');
    };
    const totpKey = Buffer.from('12345678901234567890');
    const point = Buffer.concat([Buffer.from([4]), randomBytes(64)]);
    const tables = new Tables({
      user: [{ id: 1, email: 'ada@example.com', email_verified: 1, username: 'ada', password_hash: '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaGhhc2hoYXNo', recovery_code: seal(Buffer.from('ABCD-EFGH')) }],
      session: [{ id: 'a'.repeat(64), user_id: 1, expires_at: 1795000000 }],
      totp_credential: [{ id: 1, user_id: 1, key: seal(totpKey) }],
      passkey_credential: [{ id: Buffer.from('cred-1').toString('base64'), user_id: 1, name: 'Phone', algorithm: -7, public_key: point.toString('base64') }],
    });
    const out = exportLucia(tables, { encryptionKey: key.toString('base64'), rpId: 'example.com', now: NOW });
    expectValid(out);
    expect(out.list('user')[0]!.password).toEqual({ algorithm: 'argon2', hash: expect.stringMatching(/^\$argon2id\$/) });
    expect(out.list('session')[0]).toMatchObject({ token_hash: 'a'.repeat(64), expires_at: new Date(1795000000 * 1000).toISOString() });
    expect(out.manifest.settings).toMatchObject({ session_id_hashing: 'sha256-hex' });
    expect(out.list('mfa_factor')).toEqual([
      { user_id: '1', type: 'backup_codes', backup_codes: ['ABCD-EFGH'] },
      { user_id: '1', type: 'totp', secret_base32: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', digits: 6, period: 30, algorithm: 'SHA1', verified: true },
    ]);
    const passkey = out.list('passkey')[0]!;
    expect(passkey.credential_id).toBe(Buffer.from('cred-1').toString('base64url'));
    expect(Buffer.from(passkey.public_key, 'base64url').subarray(10, 42)).toEqual(point.subarray(1, 33));
  });

  it('without the encryption key, TOTP rows are reported, not guessed', () => {
    const out = exportLucia(new Tables({ user: [{ id: 'u', email: 'a@b.co' }], totp_credential: [{ user_id: 'u', key: 'AAAA' }] }), { now: NOW });
    expect(out.count('mfa_factor')).toBe(0);
    expect(out.omitted.mfa_factor?.reason).toContain('--encryption-key');
  });

  it('helpers: RFC 4648 base32, COSE from SEC1, guide decryption', () => {
    expect(base32(Buffer.from('12345678901234567890'))).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32(Buffer.from('f'))).toBe('MY');
    expect(coseFromSec1(Buffer.alloc(33, 2))).toBeNull();
    expect(decryptGuideValue('AAAA', Buffer.alloc(16))).toBeNull();
  });
});

describe('Passport (app users + express-session store)', () => {
  it('maps passport-local-mongoose users, provider id columns and connect-mongo sessions', () => {
    const out = exportAppUsers(readDumpDir(join(FIXTURES, 'passport-mongo')), { now: NOW });
    expectValid(out);
    const [ada, grace] = out.list('user');
    expect(ada!.password).toEqual({
      algorithm: 'auto',
      hash: '$pbkdf2-sha256$25000$OWY4NmQwODE4ODRjN2Q2NTlhMmZlYWEwYzU1YWQwMTVhM2JmNGYxYjJiMGI4MjJjZDE1ZDZjMTViMGYwMGEwOA$0gnXhptufes',
    });
    expect(ada!.created_at).toBe('2024-05-06T07:08:09.000Z');
    expect(grace).toMatchObject({ emails: [{ email: 'grace@example.com', verified: true }], password: { algorithm: 'bcrypt' } });
    expect(out.list('identity')).toEqual([
      { user_id: '64b000000000000000000001', provider: 'google', provider_user_id: '110248495921238986420', kind: 'oauth' },
    ]);
    expect(out.list('session')).toEqual([
      {
        id: '42640101ca684a6737e746822d81f220',
        user_id: '64b000000000000000000001',
        token_hash: '42640101ca684a6737e746822d81f2203e914509ff1ac142f5080b68ca7010b2',
        expires_at: '2026-11-01T00:00:00.000Z',
      },
    ]);
    expect(out.omitted.session?.reason).toContain('anonymous');
  });

  it('honours column overrides and connect-pg-simple rows', () => {
    const tables = new Tables({
      members: [{ member_id: 9, mail: 'x@example.com', pw: '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', gh: '77' }],
      session: [{ sid: 'abc', sess: { cookie: { expires: '2026-12-01T00:00:00Z' }, passport: { user: { id: 9 } } }, expire: '2026-12-01 00:00:00' }],
    });
    const out = exportAppUsers(tables, {
      usersTable: 'members',
      idColumn: 'member_id',
      emailColumn: 'mail',
      passwordColumn: 'pw',
      identityColumns: { github: 'gh' },
      now: NOW,
    });
    expectValid(out);
    expect(out.list('user')[0]).toMatchObject({ id: '9', password: { algorithm: 'bcrypt' } });
    expect(out.list('identity')[0]).toMatchObject({ provider: 'github', provider_user_id: '77' });
    expect(out.list('session')[0]).toMatchObject({ user_id: '9', expires_at: '2026-12-01T00:00:00.000Z' });
  });
});

describe('Devise', () => {
  const stream = readFileSync(join(FIXTURES, 'devise/rails-runner.ndjson'), 'utf8');

  it('maps the Rails runner stream', () => {
    const out = exportDevise(tablesFromStream(stream), { now: NOW });
    expectValid(out);
    const [ada, grace] = out.list('user');
    expect(ada).toMatchObject({
      id: '17',
      emails: [{ email: 'ada@example.com', verified: true }],
      password: { algorithm: 'bcrypt', hash: '$2a$12$K5tRZ1o6aF1k3Q1vXk0cJ.3m0uV7m6c9nJ8Wq3zE5j1oX7yYb2Z9e' },
      roles: ['admin'],
      last_sign_in_at: '2026-10-20T10:00:00.000Z',
    });
    expect(grace).toMatchObject({ id: '18', emails: [{ verified: false }], locked: true, roles: ['editor'] });
    expect(grace!.password).toBeUndefined();
    expect(out.warnings.some((w) => w.includes('devise-encryptable'))).toBe(true);
    expect(out.list('role')).toEqual([{ key: 'editor', name: 'editor', scope: 'app' }]);
    expect(out.warnings.some((w) => w.includes('scoped to a resource'))).toBe(true);
    expect(out.list('identity')).toEqual([
      { user_id: '17', provider: 'github', provider_user_id: '583231', kind: 'oauth' },
      { user_id: '18', provider: 'google_oauth2', provider_user_id: '110248495921238986420', kind: 'oauth', email: 'grace@example.com' },
    ]);
    expect(out.list('mfa_factor')).toEqual([
      { user_id: '17', type: 'totp', secret_base32: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30, algorithm: 'SHA1', verified: true },
      {
        user_id: '17',
        type: 'backup_codes',
        backup_code_hashes: [{ algorithm: 'bcrypt', hash: '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy' }],
      },
    ]);
    // activerecord-session_store keeps the private id: the hash of the cookie's id.
    expect(out.list('session')).toEqual([
      {
        id: '4c4f6c1e0a3a4f6b9d1e2f3a4b5c6d7e',
        user_id: '17',
        token_hash: '4c4f6c1e0a3a4f6b9d1e2f3a4b5c6d7e8f9012345678901234567890abcdef12',
        expires_at: '2026-11-07T00:00:00.000Z',
      },
    ]);
    expect(out.manifest.settings).toMatchObject({ session_store: 'active_record_store', session_cookie: '_shop_session' });
  });

  it('carries the pepper with every bcrypt digest when config.pepper is set', () => {
    const peppered = stream.replace('"pepper":null', '"pepper":"s3cret-pepper"');
    const out = exportDevise(tablesFromStream(peppered), { now: NOW });
    expect(out.list('user')[0]!.password).toEqual({
      algorithm: 'bcrypt_pepper',
      hash: '$2a$12$K5tRZ1o6aF1k3Q1vXk0cJ.3m0uV7m6c9nJ8Wq3zE5j1oX7yYb2Z9e',
      params: { pepper: 's3cret-pepper' },
    });
    expect(out.list('mfa_factor')[1]!.backup_code_hashes![0]).toMatchObject({ algorithm: 'bcrypt_pepper', params: { pepper: 's3cret-pepper' } });
  });

  it('ships a runner script', () => {
    expect(DEVISE_EXPORT_SCRIPT).toContain('model.find_each');
    expect(DEVISE_EXPORT_SCRIPT).toContain('u.otp_secret');
  });
});

describe('Django', () => {
  const tables = readDumpDir(join(FIXTURES, 'django'));

  it('maps dumpdata: users, emails, groups, social accounts, MFA, passkeys, sessions', () => {
    const out = exportDjango(tables, { rpId: 'example.com', now: NOW });
    expectValid(out);
    const [ada, grace] = out.list('user');
    expect(ada).toMatchObject({
      id: '1',
      username: 'ada',
      first_name: 'Ada',
      emails: [
        { email: 'ada@example.com', verified: true, primary: true },
        { email: 'ada@work.example', verified: false, primary: false },
      ],
      password: { algorithm: 'auto', hash: 'pbkdf2_sha256$1800000$seasalt$sXv9FzN4gEo6/P8G5H1jvir9BIb5e5EkXoVGyjOniNE=' },
      roles: ['billing', 'superuser', 'staff'],
      last_sign_in_at: '2026-10-01T09:00:00.000Z',
    });
    expect(grace).toMatchObject({ id: '2', banned: true });
    expect(grace!.password).toBeUndefined();
    expect(out.list('role')).toEqual([
      { key: 'billing', name: 'billing', scope: 'app', permissions: ['add_invoice'] },
      { key: 'superuser', name: 'superuser', scope: 'app' },
      { key: 'staff', name: 'staff', scope: 'app' },
    ]);
    expect(out.list('identity')).toEqual([
      {
        user_id: '2',
        provider: 'github',
        provider_user_id: '1024',
        kind: 'oauth',
        email: 'grace@example.com',
        profile: { login: 'grace', email: 'grace@example.com' },
      },
    ]);
    expect(out.list('mfa_factor')).toEqual([
      { user_id: '1', type: 'totp', secret_base32: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30, algorithm: 'SHA1', verified: true, created_at: '2025-06-01T00:00:00.000Z' },
    ]);
    expect(out.omitted.mfa_factor?.reason).toContain('export script');
    expect(out.list('passkey')).toEqual([
      {
        user_id: '1',
        credential_id: 'q83vASNFZ4mrze8BI0VniQ',
        public_key: 'pQECAyYgASFYIAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gIlggISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-P0A',
        sign_count: 42,
        aaguid: 'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4',
        backed_up: true,
        transports: ['internal', 'hybrid'],
        rp_id: 'example.com',
        name: 'MacBook',
        created_at: '2025-07-01T00:00:00.000Z',
      },
    ]);
    // Session 1 (Django ≥ 3.1, compressed) belongs to user 1; the legacy-format one to user 2; one is anonymous.
    expect(out.list('session').map((s) => s.user_id)).toEqual(['1', '2']);
    expect(out.list('session')[0]!.token_hash).toBe('c7dda305f7bca99f8ae17c43587c923ced1507ffe280d02597efc9084f0cb3ae');
    expect(out.omitted.session).toEqual({ count: 1, reason: 'anonymous session' });
  });

  it('takes recovery codes and decrypted TOTP secrets from the export script', () => {
    const withScript = tablesFromStream(
      [
        '{"table":"mfa_secrets","row":{"authenticator_id":10,"secret":"KRSXG5CTMVRXEZLU"}}',
        '{"table":"mfa_secrets","row":{"authenticator_id":11,"codes":["1a2b3c4d","5e6f7a8b"]}}',
      ].join('\n'),
      readDumpDir(join(FIXTURES, 'django')),
    );
    const out = exportDjango(withScript, { now: NOW });
    expect(out.list('mfa_factor').map((f) => [f.type, f.secret_base32 ?? f.backup_codes])).toEqual([
      ['totp', 'KRSXG5CTMVRXEZLU'],
      ['backup_codes', ['1a2b3c4d', '5e6f7a8b']],
    ]);
  });

  it('decodes both session_data formats', () => {
    expect(decodeSessionData(Buffer.from('abc:{"_auth_user_id":"5"}').toString('base64'))).toEqual({ _auth_user_id: '5' });
    expect(decodeSessionData('garbage')).toBeNull();
  });

  it('ships an export script', () => {
    expect(DJANGO_EXPORT_SCRIPT).toContain('call_command("dumpdata"');
    expect(DJANGO_EXPORT_SCRIPT).toContain('get_unused_codes()');
  });
});

describe('dump readers', () => {
  it('reads SQL timestamps and epoch values', () => {
    expect(time('2025-03-01 10:00:00+00')).toBe('2025-03-01T10:00:00.000Z');
    expect(time('2025-03-01 10:00:00.123+0530')).toBe('2025-03-01T04:30:00.123Z');
    expect(time(1795000000)).toBe(1795000000000);
    expect(time('')).toBeUndefined();
  });

  it('parses the WebAuthn attestation object out of allauth data', () => {
    expect(parseAttestationObject('oA')).toBeNull();
  });
});
