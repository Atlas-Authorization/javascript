import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { clerkPasswordHash, exportClerk } from './clerk';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';

/**
 * Clerk Backend API responses as Clerk returns them (2025-04-10 shapes: users
 * as a bare array, organizations wrapped in `{ data, total_count }`), and the
 * dashboard CSV export's header row.
 */
const CSV = [
  'id,first_name,last_name,username,primary_email_address,primary_phone_number,verified_email_addresses,unverified_email_addresses,verified_phone_numbers,unverified_phone_numbers,totp_secret,password_digest,password_hasher',
  'user_2a,Ada,Lovelace,,ada@example.com,+14155550100,ada@example.com,,+14155550100,,JBSWY3DPEHPK3PXP,$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy,bcrypt',
  'user_2b,Bob,,bobby,bob@example.com,,,bob@example.com,,,,pbkdf2_sha256$600000$c2FsdA==$aGFzaA==,pbkdf2_sha256',
  'user_gone,Old,User,,old@example.com,,old@example.com,,,,,,',
].join('\n');

const ADA = {
  id: 'user_2a',
  username: null,
  first_name: 'Ada',
  last_name: 'Lovelace',
  image_url: 'https://img.clerk.com/ada',
  has_image: true,
  primary_email_address_id: 'idn_ada',
  primary_phone_number_id: 'idn_ph',
  email_addresses: [
    { id: 'idn_ada', email_address: 'Ada@Example.com', verification: { status: 'verified', strategy: 'email_code' } },
    { id: 'idn_ada2', email_address: 'ada@work.example', verification: { status: 'unverified' } },
  ],
  phone_numbers: [{ id: 'idn_ph', phone_number: '+1 415 555 0100', verification: { status: 'verified' } }],
  external_accounts: [
    {
      id: 'eac_1',
      provider: 'oauth_google',
      provider_user_id: '1093849',
      email_address: 'ada@gmail.com',
      approved_scopes: 'email profile openid',
      first_name: 'Ada',
      verification: { status: 'verified', strategy: 'oauth_google' },
    },
  ],
  enterprise_accounts: [
    { id: 'eaa_1', provider: 'saml_okta', active: true, provider_user_id: 'ada@corp.example', email_address: 'ada@corp.example', enterprise_connection: { id: 'ent_1' } },
  ],
  public_metadata: { plan: 'pro' },
  private_metadata: { stripe: 'cus_1' },
  unsafe_metadata: {},
  banned: false,
  locked: false,
  password_enabled: true,
  totp_enabled: true,
  backup_code_enabled: true,
  passkeys: [{ id: 'pk_1', name: 'MacBook' }],
  created_at: 1700000000000,
  last_sign_in_at: 1710000000000,
};

const BOB = {
  id: 'user_2b',
  username: 'bobby',
  first_name: 'Bob',
  last_name: null,
  primary_email_address_id: 'idn_bob',
  email_addresses: [{ id: 'idn_bob', email_address: 'bob@example.com', verification: { status: 'unverified' } }],
  phone_numbers: [],
  external_accounts: [],
  banned: true,
  password_enabled: true,
  created_at: 1700000001000,
};

const WALLET_ONLY = { id: 'user_2w', email_addresses: [], phone_numbers: [], web3_wallets: [{ web3_wallet: '0xabc' }], created_at: 1 };

function clerkApi(extra: Record<string, unknown> = {}) {
  return fakeVendor('https://api.clerk.com', {
    'GET /v1/organizations': { data: [{ id: 'org_1', name: 'Acme', slug: 'acme', max_allowed_memberships: 0, public_metadata: { tier: 'gold' }, created_at: 1700000000000 }], total_count: 1 },
    'GET /v1/organizations/org_1/domains': {
      data: [
        { name: 'acme.example', verification: { status: 'verified' } },
        { name: 'pending.example', verification: { status: 'unverified' } },
      ],
      total_count: 2,
    },
    'GET /v1/organization_roles': {
      data: [
        { key: 'org:admin', name: 'Admin', permissions: [{ key: 'org:sys_memberships:manage' }] },
        { key: 'org:billing', name: 'Billing', description: 'Pays', permissions: [{ key: 'org:invoices:read' }] },
      ],
      total_count: 2,
    },
    'GET /v1/users': [ADA, BOB, WALLET_ONLY],
    'GET /v1/organizations/org_1/memberships': {
      data: [
        { id: 'orgmem_1', role: 'org:admin', public_user_data: { user_id: 'user_2a' }, created_at: 1700000000500 },
        { id: 'orgmem_2', role: 'org:billing', public_user_data: { user_id: 'user_2b' } },
      ],
      total_count: 2,
    },
    'GET /v1/organizations/org_1/invitations': { data: [{ id: 'orginv_1', email_address: 'new@example.com', role: 'org:billing', status: 'pending', expires_at: 1800000000000 }], total_count: 1 },
    'GET /v1/invitations': [{ id: 'inv_1', email_address: 'solo@example.com', status: 'pending' }],
    'GET /v1/api_keys': { data: [{ id: 'ak_1', name: 'ci', subject: 'org_1', scopes: ['read'], revoked: false, created_at: 1 }, { id: 'ak_2', subject: 'user_2a', revoked: true }], total_count: 2 },
    'GET /v1/api_keys/ak_1/secret': { secret: 'ak_live_supersecretvalue' },
    'GET /v1/enterprise_connections': {
      data: [
        {
          id: 'ent_1',
          name: 'Corp Okta',
          domains: ['corp.example'],
          active: true,
          organization_id: 'org_1',
          saml_connection: { idp_entity_id: 'http://www.okta.com/exk1', idp_sso_url: 'https://corp.okta.com/sso', idp_certificate: 'MIIC...', acs_url: 'https://clerk.acme.example/v1/saml/acs/ent_1', sp_entity_id: 'https://clerk.acme.example/saml/ent_1', attribute_mapping: { email_address: 'mail', first_name: '' } },
        },
      ],
      total_count: 1,
    },
    'GET /v1/jwks': { keys: [{ kid: 'ins_1', kty: 'RSA', n: 'abc', e: 'AQAB', alg: 'RS256', use: 'sig' }] },
    ...extra,
  });
}

describe('exportClerk', () => {
  it('maps users, identities, orgs, roles, memberships, invitations, keys, SSO and JWKS from the Backend API + CSV', async () => {
    const api = clerkApi();
    const set = await exportClerk({ secretKey: 'sk_test_1', csv: CSV, fetchImpl: api.fetchImpl, sleep: noSleep });

    // Credentials only ever go to Clerk.
    expect(api.calls.every((c) => c.url.startsWith('https://api.clerk.com/') && c.headers.get('authorization') === 'Bearer sk_test_1')).toBe(true);

    const [ada, bob] = set.list('user');
    expect(ada).toEqual({
      id: 'user_2a',
      emails: [
        { email: 'ada@example.com', verified: true, primary: true },
        { email: 'ada@work.example', verified: false, primary: false },
      ],
      phones: [{ phone: '+14155550100', verified: true, primary: true }],
      first_name: 'Ada',
      last_name: 'Lovelace',
      image_url: 'https://img.clerk.com/ada',
      public_metadata: { plan: 'pro' },
      private_metadata: { stripe: 'cus_1' },
      created_at: 1700000000000,
      last_sign_in_at: 1710000000000,
      password: { algorithm: 'bcrypt', hash: '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy' },
    });
    expect(bob).toMatchObject({ id: 'user_2b', username: 'bobby', banned: true });
    expect(bob!.password).toEqual({
      algorithm: 'pbkdf2',
      hash: 'aGFzaA==',
      salt: 'c2FsdA==',
      params: { digest: 'sha256', iterations: 600000, encoding: 'base64', salt_encoding: 'base64' },
    });
    expect(set.count('user')).toBe(2);
    // The wallet-only user, and the CSV row Clerk no longer has (first reason kept).
    expect(set.omitted.user).toEqual({ count: 2, reason: 'no email, phone or username (wallet-only users)' });

    expect(set.list('identity')).toEqual([
      {
        id: 'eac_1',
        user_id: 'user_2a',
        provider: 'oauth_google',
        provider_user_id: '1093849',
        kind: 'oauth',
        email: 'ada@gmail.com',
        email_verified: true,
        scopes: ['email', 'profile', 'openid'],
        profile: { first_name: 'Ada' },
      },
      { id: 'eaa_1', user_id: 'user_2a', provider: 'saml_okta', provider_user_id: 'ada@corp.example', kind: 'saml', sso_connection_id: 'ent_1', email: 'ada@corp.example' },
    ]);
    expect(set.list('mfa_factor')).toEqual([
      { user_id: 'user_2a', type: 'totp', secret_base32: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30, algorithm: 'SHA1', verified: true },
    ]);
    expect(set.omitted.mfa_factor?.reason).toBe('Clerk does not export backup codes');
    expect(set.omitted.passkey).toEqual({ count: 1, reason: 'Clerk does not export passkey public keys' });

    expect(set.list('organization')).toEqual([
      { id: 'org_1', name: 'Acme', slug: 'acme', domains: ['acme.example'], public_metadata: { tier: 'gold' }, created_at: 1700000000000 },
    ]);
    expect(set.list('role')).toEqual([
      { key: 'admin', name: 'Admin', scope: 'organization', permissions: ['sys_memberships:manage'] },
      { key: 'billing', name: 'Billing', description: 'Pays', scope: 'organization', permissions: ['invoices:read'] },
    ]);
    expect(set.list('membership')).toEqual([
      { id: 'orgmem_1', organization_id: 'org_1', user_id: 'user_2a', role: 'admin', created_at: 1700000000500 },
      { id: 'orgmem_2', organization_id: 'org_1', user_id: 'user_2b', role: 'billing' },
    ]);
    expect(set.list('invitation')).toEqual([
      { id: 'orginv_1', organization_id: 'org_1', email: 'new@example.com', role: 'billing', status: 'pending', expires_at: 1800000000000 },
      { id: 'inv_1', email: 'solo@example.com', status: 'pending' },
    ]);
    expect(set.list('api_key')).toEqual([
      {
        id: 'ak_1',
        organization_id: 'org_1',
        name: 'ci',
        hash: createHash('sha256').update('ak_live_supersecretvalue').digest('hex'),
        hash_algorithm: 'sha256',
        start: 'ak_live_',
        scopes: ['read'],
        created_at: 1,
      },
    ]);
    expect(set.list('sso_connection')).toEqual([
      {
        id: 'ent_1',
        name: 'Corp Okta',
        organization_id: 'org_1',
        protocol: 'saml',
        domains: ['corp.example'],
        enabled: true,
        saml: {
          idp_entity_id: 'http://www.okta.com/exk1',
          idp_sso_url: 'https://corp.okta.com/sso',
          idp_certificate: 'MIIC...',
          sp_entity_id: 'https://clerk.acme.example/saml/ent_1',
          sp_acs_url: 'https://clerk.acme.example/v1/saml/acs/ent_1',
          attribute_mapping: { email_address: 'mail' },
        },
      },
    ]);
    expect(set.list('jwks')).toHaveLength(1);
    expect(set.manifest.providers).toEqual(['oauth_google', 'saml_okta']);
    // Canonical order: organizations → roles → SSO connections → users → … → jwks.
    expect([...new Set([...set.ordered()].map((r) => r.model))]).toEqual([
      'organization',
      'role',
      'sso_connection',
      'user',
      'identity',
      'mfa_factor',
      'membership',
      'invitation',
      'api_key',
      'jwks',
    ]);
  });

  it('pages users 500 at a time and warns when no CSV carries the digests', async () => {
    const page = (offset: number) => Array.from({ length: offset === 0 ? 500 : 3 }, (_, i) => ({ ...BOB, id: `user_${offset + i}`, banned: false }));
    const api = clerkApi({
      'GET /v1/users': ({ url }: { url: URL }) => page(Number(url.searchParams.get('offset'))),
    });
    const set = await exportClerk({ secretKey: 'sk_test_1', fetchImpl: api.fetchImpl, sleep: noSleep, skipApiKeys: true });
    expect(set.count('user')).toBe(503);
    expect(api.calls.filter((c) => new URL(c.url).pathname === '/v1/users').map((c) => new URL(c.url).searchParams.get('offset'))).toEqual(['0', '500']);
    expect(set.warnings.some((w) => w.includes('only exports them in the dashboard CSV'))).toBe(true);
    expect(set.omitted.password?.count).toBe(503);
  });

  it('retries a 429 after Retry-After', async () => {
    let first = true;
    const waits: number[] = [];
    const api = clerkApi({
      'GET /v1/jwks': () => {
        if (first) {
          first = false;
          return { status: 429, body: { errors: [{ message: 'slow down' }] }, headers: { 'retry-after': '2' } };
        }
        return { keys: [] };
      },
    });
    await exportClerk({ secretKey: 'sk', fetchImpl: api.fetchImpl, sleep: async (ms) => void waits.push(ms), skipApiKeys: true });
    expect(waits).toEqual([2000]);
  });

  it('works from the CSV alone', async () => {
    const set = await exportClerk({ csv: CSV });
    expect(set.list('user').map((u) => u.id)).toEqual(['user_2a', 'user_2b', 'user_gone']);
    expect(set.list('user')[0]!.emails).toEqual([{ email: 'ada@example.com', verified: true, primary: true }]);
    expect(set.warnings[0]).toMatch(/dashboard CSV only/);
  });
});

describe('clerkPasswordHash', () => {
  it('maps every documented hasher onto a registry algorithm', () => {
    expect(clerkPasswordHash('argon2id', '$argon2id$v=19$m=64,t=4,p=8$Z2liZXJyaXNo$iGXEpMBTDYQ8G/71tF0qGjxRHEmR3gpGULcE93zUJVU')).toMatchObject({ algorithm: 'argon2' });
    expect(clerkPasswordHash('bcrypt_sha256_django', 'bcrypt_sha256$$2b$12$abc')).toEqual({ algorithm: 'bcrypt_sha256_django', hash: 'bcrypt_sha256$$2b$12$abc' });
    expect(clerkPasswordHash('pbkdf2_sha256_django', 'pbkdf2_sha256$870000$salt$hash')).toEqual({ algorithm: 'pbkdf2_django', hash: 'pbkdf2_sha256$870000$salt$hash' });
    expect(clerkPasswordHash('pbkdf2_sha1', 'pbkdf2_sha1$1000$a1b2$deadbeef$20')).toEqual({
      algorithm: 'pbkdf2',
      hash: 'deadbeef',
      salt: 'a1b2',
      params: { digest: 'sha1', iterations: 1000, encoding: 'hex', salt_encoding: 'hex', key_length: 20 },
    });
    expect(clerkPasswordHash('pbkdf2_sha1', 'pbkdf2_sha1$1000$NaCl$deadbeef')).toMatchObject({ params: { salt_encoding: 'utf8' } });
    expect(clerkPasswordHash('pbkdf2_sha512', 'pbkdf2_sha512$10000$rawsalt$abcd')).toMatchObject({ algorithm: 'pbkdf2', salt: 'rawsalt', params: { digest: 'sha512', salt_encoding: 'utf8', encoding: 'hex' } });
    expect(clerkPasswordHash('pbkdf2_sha512_hex', 'pbkdf2_sha512_hex$10000$0a0b$abcd')).toMatchObject({ params: { salt_encoding: 'hex' } });
    expect(clerkPasswordHash('scrypt_firebase', 'hh==$ss==$kk==$Bw==$8$14')).toEqual({
      algorithm: 'scrypt_firebase',
      hash: 'hh==',
      salt: 'ss==',
      params: { signer_key: 'kk==', salt_separator: 'Bw==', rounds: 8, mem_cost: 14 },
    });
    expect(clerkPasswordHash('scrypt_werkzeug', '$scrypt:32768:8:1$salt$abcd')).toEqual({ algorithm: 'scrypt_werkzeug', hash: 'scrypt:32768:8:1$salt$abcd' });
    // Clerk's documented base64 hash becomes Werkzeug's hex.
    expect(clerkPasswordHash('scrypt_werkzeug', '$scrypt:32768:8:1$salt$q83v')).toEqual({ algorithm: 'scrypt_werkzeug', hash: 'scrypt:32768:8:1$salt$abcdef' });
    expect(clerkPasswordHash('sha512_symfony', 'sha512_symfony$5000$salt$aGFzaA==')).toEqual({ algorithm: 'sha512_symfony', hash: 'aGFzaA==', salt: 'salt', params: { iterations: 5000, encoding: 'base64' } });
    expect(clerkPasswordHash('md5', '5F4DCC3B5AA765D61D8327DEB882CF99')).toEqual({ algorithm: 'md5', hash: '5f4dcc3b5aa765d61d8327deb882cf99', params: { encoding: 'hex' } });
    expect(clerkPasswordHash('phpass', '$P$Babc')).toEqual({ algorithm: 'phpass', hash: '$P$Babc' });
  });

  it('refuses what cannot verify outside Clerk, with a reason', () => {
    for (const h of ['bcrypt_peppered', 'awscognito', 'md5_salted', 'sha256_salted', 'something_new']) {
      expect(clerkPasswordHash(h, 'x$y')).toHaveProperty('reason');
    }
    expect(clerkPasswordHash('pbkdf2_sha256', 'pbkdf2_sha256$x$y')).toEqual({ reason: 'malformed pbkdf2_sha256 digest' });
  });
});
