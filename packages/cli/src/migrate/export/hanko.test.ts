import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDumpDir, Tables } from './frameworks/tables';
import { exportHankoApi, exportHankoTables, hankoPasswordHash } from './hanko';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';

const DUMP = join(__dirname, '__fixtures__/hanko/db');
const JOHN = 'b5dd5267-b462-48be-b70d-bcd6f1bbe7a5';
const JDOE_PUBLIC = 'd15d9f1b-2020-4b22-8b22-202020202020';
const GITHUBBER = '1d6a4824-d935-4980-8f18-8ee5d6efe2fc';
const BCRYPT = '$2a$12$Cf7k.dG6pznTUJ5u2u1pgu6I4VXH5.9O0NZsDk8TwWwyBkZovYVli';
const FB = (p: number) =>
  `$fbscrypt$v=1,n=14,r=8,p=${p},ss=Bw==,sk=ou9tdYTGyYm8kuR6Dt0Bp0kDuAYoXrK16mbZO4yGwAn3oLspjnN0/c41v8xZnO1n14J3MjKj1b2g6AUCAlFwMw==$C0sHCg9ek77hsg==$zKVTMvnWVw5BBOZNUdnsalx4c4c7y/w7IS5p6Ut2+CfEFFlz37J9huyQfov4iizN8dbjvEJlM5tQaJP84+hfTw==`;

describe('hankoPasswordHash', () => {
  it('keeps bcrypt verbatim', () => {
    expect(hankoPasswordHash(BCRYPT)).toEqual({ algorithm: 'bcrypt', hash: BCRYPT });
  });

  it('maps the $fbscrypt$ import format onto Firebase scrypt with its parameters', () => {
    expect(hankoPasswordHash(FB(1))).toEqual({
      algorithm: 'scrypt_firebase',
      hash: 'zKVTMvnWVw5BBOZNUdnsalx4c4c7y/w7IS5p6Ut2+CfEFFlz37J9huyQfov4iizN8dbjvEJlM5tQaJP84+hfTw==',
      salt: 'C0sHCg9ek77hsg==',
      params: {
        rounds: 8,
        mem_cost: 14,
        salt_separator: 'Bw==',
        signer_key: 'ou9tdYTGyYm8kuR6Dt0Bp0kDuAYoXrK16mbZO4yGwAn3oLspjnN0/c41v8xZnO1n14J3MjKj1b2g6AUCAlFwMw==',
      },
    });
  });

  it('refuses what Atlas cannot verify (parallelism other than 1, no signer key, unknown formats, empty)', () => {
    expect(hankoPasswordHash(FB(2))).toBeNull();
    expect(hankoPasswordHash('$fbscrypt$v=1,n=14,r=8,p=1$c2FsdA==$aGFzaA==')).toBeNull();
    expect(hankoPasswordHash('$argon2id$v=19$m=65536,t=1,p=4$c2FsdA$aGFzaA')).toBeNull();
    expect(hankoPasswordHash('')).toBeNull();
    expect(hankoPasswordHash(null)).toBeNull();
  });
});

describe('exportHankoTables (database dump)', () => {
  const set = exportHankoTables(readDumpDir(DUMP), { rpId: 'example.com' });
  const user = (id: string) => set.list('user').find((u) => u.id === id)!;

  it('exports users under the public id the session JWT carries as sub', () => {
    expect(set.list('user').map((u) => u.id).sort()).toEqual([JOHN, JDOE_PUBLIC, GITHUBBER].sort());
    const john = user(JOHN);
    expect(john.first_name).toBe('John');
    expect(john.last_name).toBe('Doe');
    expect(john.image_url).toBe('https://example.com/john.png');
  });

  it('puts the primary email first, lowercases addresses and keeps verified flags', () => {
    expect(user(JOHN).emails).toEqual([
      { email: 'john.doe@example.com', verified: true, primary: true },
      { email: 'john.doe+3@example.com', verified: false, primary: false },
    ]);
  });

  it('keeps usernames and drops a user with nothing to sign in with', () => {
    expect(user(JDOE_PUBLIC).username).toBe('jdoe_2');
    expect(set.omitted.user?.count).toBe(1);
  });

  it('carries bcrypt and Firebase-scrypt hashes and warns about the one it cannot verify', () => {
    expect(user(JOHN).password).toEqual({ algorithm: 'bcrypt', hash: BCRYPT });
    expect(user(JDOE_PUBLIC).password?.algorithm).toBe('scrypt_firebase');
    expect(user(GITHUBBER).password).toBeUndefined();
    expect(set.warnings.some((w) => w.includes('1 password hash(es)') && w.includes('lazy-migration'))).toBe(true);
  });

  it('keeps metadata and wraps custom claims as private metadata', () => {
    const john = user(JOHN);
    expect(john.public_metadata).toEqual({ existing_public_str: 'data', existing_public_num: 1, existing_public_bool: true });
    expect(john.private_metadata).toMatchObject({ existing_private_str: 'data', hanko_custom_claims: { department: 'engineering' } });
    expect(john.unsafe_metadata).toBeUndefined();
  });

  it('exports TOTP secrets with Hanko defaults (SHA-1, 6 digits, 30 s)', () => {
    expect(set.list('mfa_factor')).toEqual([
      expect.objectContaining({ user_id: JOHN, type: 'totp', secret_base32: 'RANDOMOTPSECRET', digits: 6, period: 30, algorithm: 'SHA1', verified: true }),
    ]);
  });

  it('exports passkeys with the relying-party id, counters, aaguid and transports; leaves out unexported users', () => {
    const passkeys = set.list('passkey');
    expect(passkeys).toHaveLength(2);
    const icloud = passkeys.find((p) => p.name === 'iCloud Keychain')!;
    expect(icloud).toMatchObject({
      user_id: JOHN,
      credential_id: '4iVZGFN_jktXJmwmBmaSq0Qr4T62T0jX7PS7XcgAWlM',
      rp_id: 'example.com',
      sign_count: 1650958750,
      aaguid: '01020304-0506-0708-0102-030405060708',
      backed_up: true,
      transports: ['internal', 'hybrid'],
    });
    const key = passkeys.find((p) => !p.name)!;
    expect(key.aaguid).toBeUndefined();
    expect(key.sign_count).toBeUndefined();
    expect(set.warnings.some((w) => w.includes('mfa_only'))).toBe(true);
  });

  it('leaves passkeys out, with the reason, when no relying-party id is given', () => {
    const noRp = exportHankoTables(readDumpDir(DUMP));
    expect(noRp.count('passkey')).toBe(0);
    expect(noRp.omitted.passkey?.reason).toMatch(/relying-party id/);
    expect(noRp.warnings.some((w) => w.includes('hanko-rp-id'))).toBe(true);
  });

  it('maps third-party identities (user resolved through the email when user_id is null) and SAML identities', () => {
    const ids = set.list('identity');
    const google = ids.find((i) => i.provider === 'google')!;
    expect(google).toMatchObject({ user_id: JOHN, provider_user_id: 'google_123', kind: 'oauth', email: 'john.doe@example.com', email_verified: true });
    expect(ids.find((i) => i.provider === 'github')).toMatchObject({ user_id: GITHUBBER, kind: 'oauth' });
    const corp = ids.find((i) => i.provider_user_id === 'john@corp.example')!;
    expect(corp).toMatchObject({ kind: 'saml', sso_connection_id: '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d' });
    // the discord identity belongs to the user without an identifier
    expect(ids.find((i) => i.provider === 'discord')).toBeUndefined();
    expect(set.omitted.identity?.count).toBe(1);
    expect(set.manifest.providers).toEqual(['github', 'google']);
  });

  it('exports database SAML providers with their metadata and creates one from config.yaml identities', () => {
    const conns = set.list('sso_connection');
    const corp = conns.find((c) => c.name === 'Corp IdP')!;
    expect(corp).toMatchObject({
      protocol: 'saml',
      domains: ['corp.example'],
      enabled: true,
      saml: {
        idp_entity_id: 'https://idp.corp.example/metadata',
        idp_sso_url: 'https://idp.corp.example/sso',
        attribute_mapping: { email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress' },
      },
    });
    expect(conns.find((c) => c.id === 'saml:partner.example')).toMatchObject({ domains: ['partner.example'], saml: { idp_entity_id: 'https://sso.partner.example' } });
    expect(set.warnings.some((w) => w.includes('config.yaml'))).toBe(true);
  });

  it('exports organizations, roles and memberships, keeping one role per membership', () => {
    expect(set.list('organization')).toEqual([expect.objectContaining({ name: 'Acme' })]);
    expect(set.list('role').map((r) => r.key).sort()).toEqual(['admin', 'billing']);
    const members = set.list('membership');
    expect(members).toHaveLength(2);
    expect(members.find((m) => m.user_id === JOHN)?.role).toBe('admin');
    expect(members.find((m) => m.user_id === GITHUBBER)?.role).toBe('member');
    expect(set.warnings.some((w) => w.includes('more than one Hanko role'))).toBe(true);
  });

  it('does not export live sessions (the JWT bridge takes them) and notes webhooks', () => {
    expect(set.omitted.session).toMatchObject({ count: 1 });
    expect(set.warnings.some((w) => w.includes('webhook'))).toBe(true);
  });

  it('refuses a dump without users and a multi-tenant dump without a tenant id', () => {
    expect(() => exportHankoTables(new Tables({}))).toThrow(/No users table/);
    const multi = new Tables({ users: [{ id: 'a', tenant_id: 't1' }, { id: 'b', tenant_id: 't2' }] });
    expect(() => exportHankoTables(multi)).toThrow(/2 Hanko tenants/);
    const one = exportHankoTables(
      new Tables({
        users: [{ id: 'a', tenant_id: 't1' }, { id: 'b', tenant_id: 't2' }],
        emails: [{ id: 'e1', user_id: 'a', tenant_id: 't1', address: 'A@x.test', verified: true }, { id: 'e2', user_id: 'b', tenant_id: 't2', address: 'b@x.test', verified: true }],
      }),
      { tenantId: 't1' },
    );
    expect(one.list('user').map((u) => u.id)).toEqual(['a']);
    expect(one.list('user')[0]!.emails).toEqual([{ email: 'a@x.test', verified: true, primary: true }]);
  });

  it('reads the pre-2022 schema with one email on the user row', () => {
    const legacy = exportHankoTables(new Tables({ users: [{ id: 'u1', email: 'Old@X.test', verified: true }] }));
    expect(legacy.list('user')[0]!.emails).toEqual([{ email: 'old@x.test', verified: true, primary: true }]);
  });
});

describe('exportHankoApi (Admin API)', () => {
  const ORIGIN = 'https://admin.hanko.test';
  const jwk = { kty: 'RSA', kid: 'k1', n: 'abc', e: 'AQAB', alg: 'RS256' };
  const routes = {
    'GET /organizations': [{ id: 'org1', name: 'Acme', created_at: '2024-01-01T00:00:00Z' }],
    'GET /roles': [{ id: 'r1', slug: 'admin', name: 'Administrator' }],
    'GET /users': [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }],
    'GET /users/u1': {
      id: 'u1',
      created_at: '2024-02-02T00:00:00Z',
      given_name: 'Ada',
      emails: [
        { id: 'em2', address: 'Second@X.test', is_verified: false, is_primary: false },
        { id: 'em1', address: 'Ada@X.test', is_verified: true, is_primary: true },
      ],
      username: { username: 'ada' },
      password: { id: 'p1' },
      otp: { id: 'o1' },
      identities: [{ id: 'i1', provider_name: 'google', provider_id: 'g-1', email_id: 'em1' }],
      webauthn_credentials: [{ id: 'cred_1', public_key: 'pQECAyYg', name: 'Phone', mfa_only: true, transports: ['internal'] }],
      metadata: { public_metadata: { plan: 'pro' } },
      custom_claims: { dept: 'eng' },
      organizations: [{ id: 'org1', name: 'Acme', roles: [{ slug: 'admin', name: 'Administrator' }] }],
    },
    'GET /users/u2': { id: 'u2', emails: [] },
    'GET /users/u3': { status: 404 },
    'GET /.well-known/jwks.json': { keys: [jwk, { kty: 'RSA', kid: 'secret', d: 'x' }] },
  };

  it('exports users, identities, passkeys, memberships and the JWKS, and says what the API withholds', async () => {
    const v = fakeVendor(ORIGIN, routes);
    const set = await exportHankoApi({ adminUrl: ORIGIN, apiKey: 'key-1', apiUrl: 'https://api.hanko.test', rpId: 'x.test', fetchImpl: v.fetchImpl, sleep: noSleep });
    expect(v.calls.every((c) => !c.url.includes('key-1'))).toBe(true);
    expect(v.calls.find((c) => c.url.includes('/users?'))?.headers.get('authorization')).toBe('Bearer key-1');
    const users = set.list('user');
    expect(users.map((u) => u.id)).toEqual(['u1']);
    expect(users[0]).toMatchObject({ username: 'ada', first_name: 'Ada', public_metadata: { plan: 'pro' }, private_metadata: { hanko_custom_claims: { dept: 'eng' } } });
    expect(users[0]!.emails).toEqual([
      { email: 'ada@x.test', verified: true, primary: true },
      { email: 'second@x.test', verified: false, primary: false },
    ]);
    expect(users[0]!.password).toBeUndefined();
    expect(set.list('identity')[0]).toMatchObject({ provider: 'google', provider_user_id: 'g-1', kind: 'oauth', email: 'ada@x.test' });
    expect(set.list('passkey')[0]).toMatchObject({ credential_id: 'cred_1', rp_id: 'x.test', transports: ['internal'] });
    expect(set.list('membership')).toEqual([{ organization_id: 'org1', user_id: 'u1', role: 'admin' }]);
    expect(set.list('jwks').map((k) => k.kid)).toEqual(['k1']);
    expect(set.warnings.some((w) => w.includes('lazy migration'))).toBe(true);
    expect(set.warnings.some((w) => w.includes('enrol an authenticator'))).toBe(true);
    expect(set.omitted.user?.count).toBe(2);
  });

  it('leaves passkeys out without a relying-party id', async () => {
    const v = fakeVendor(ORIGIN, routes);
    const set = await exportHankoApi({ adminUrl: ORIGIN, fetchImpl: v.fetchImpl, sleep: noSleep });
    expect(set.count('passkey')).toBe(0);
    expect(set.omitted.passkey?.count).toBe(1);
  });

  it('works against a Hanko without organizations or roles (404) and pages through listings', async () => {
    const all = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}` }));
    const v = fakeVendor(ORIGIN, {
      'GET /users': ({ url }: { url: URL }) => all.slice((Number(url.searchParams.get('page')) - 1) * 2, Number(url.searchParams.get('page')) * 2),
      ...Object.fromEntries(all.map((u) => [`GET /users/${u.id}`, { id: u.id, emails: [{ address: `${u.id}@x.test`, is_verified: true, is_primary: true }] }])),
    });
    const set = await exportHankoApi({ adminUrl: ORIGIN, pageSize: 2, fetchImpl: v.fetchImpl, sleep: noSleep });
    expect(set.count('user')).toBe(5);
    expect(set.count('organization')).toBe(0);
  });

  it('stops with the status when the API key is rejected', async () => {
    const v = fakeVendor(ORIGIN, { 'GET /users': { status: 401, body: { message: 'unauthorized' } } });
    await expect(exportHankoApi({ adminUrl: ORIGIN, fetchImpl: v.fetchImpl, sleep: noSleep })).rejects.toThrow(/401/);
  });
});
