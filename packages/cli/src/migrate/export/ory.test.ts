import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Tables } from './frameworks/tables';
import { exportOryApi, exportOryTables, nextPageToken, oryPasswordHash } from './ory';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';

/**
 * Kratos as it stores and serves identities: the SQL tables (`identities`,
 * `identity_credentials`, `identity_verifiable_addresses`, `sessions`) and the
 * Admin API's identity JSON. Password vectors are Kratos' own (hasher_test.go).
 */

const JANE = '9f425a8d-7efc-4768-8792-2e202d77e8a0';
const SAM = 'c1d8f1a2-0000-4000-8000-0000000000a1';
const OLD = 'c1d8f1a2-0000-4000-8000-0000000000a2';
const GONE = 'c1d8f1a2-0000-4000-8000-0000000000a3';
const BCRYPT = '$2a$12$o6hx.Wog/wvFSkT/Bp/6DOxCtLRTDj7lm9on9suF/WaCGNVHbkfL6';
const ARGON = '$argon2id$v=19$m=32,t=2,p=4$cm94YnRVOW5jZzFzcVE4bQ$MNzk5BtR2vUhrp6qQEjRNw';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function dump(over: Record<string, Array<Record<string, unknown>>> = {}): Tables {
  return new Tables({
    identity_credential_types: [
      { id: 't-pw', name: 'password' },
      { id: 't-oidc', name: 'oidc' },
      { id: 't-totp', name: 'totp' },
      { id: 't-lookup', name: 'lookup_secret' },
      { id: 't-webauthn', name: 'webauthn' },
    ],
    identities: [
      {
        id: JANE,
        schema_id: 'customer',
        state: 'active',
        traits: JSON.stringify({ email: 'Jane@Example.com', name: { first: 'Jane', last: 'Doe' }, newsletter: true }),
        metadata_public: JSON.stringify({ plan: 'pro' }),
        metadata_admin: JSON.stringify({ crm: 'c-1' }),
        created_at: '2024-01-02 03:04:05.123456+00',
        nid: 'n1',
      },
      { id: SAM, schema_id: 'default', state: 'active', traits: { email: 'sam@example.com', username: 'sam' }, created_at: '2024-02-01T00:00:00Z', nid: 'n1' },
      { id: OLD, schema_id: 'default', state: 'inactive', traits: { email: 'old@example.com' }, nid: 'n1' },
      { id: GONE, schema_id: 'default', state: 'active', traits: { favourite_colour: 'teal' }, nid: 'n1' },
    ],
    identity_verifiable_addresses: [
      { id: 'a1', identity_id: JANE, via: 'email', value: 'jane@example.com', verified: 't', status: 'completed', nid: 'n1' },
      { id: 'a2', identity_id: JANE, via: 'sms', value: '+1 (415) 555-0101', verified: 'f', status: 'pending', nid: 'n1' },
      { id: 'a3', identity_id: SAM, via: 'email', value: 'sam@example.com', verified: 'f', status: 'pending', nid: 'n1' },
    ],
    identity_credentials: [
      { id: 'c1', identity_id: JANE, identity_credential_type_id: 't-pw', config: JSON.stringify({ hashed_password: BCRYPT }), nid: 'n1' },
      {
        id: 'c2',
        identity_id: JANE,
        identity_credential_type_id: 't-oidc',
        config: JSON.stringify({ providers: [{ subject: '10938475', provider: 'google', initial_id_token: 'enc' }] }),
        nid: 'n1',
      },
      { id: 'c3', identity_id: JANE, identity_credential_type_id: 't-totp', config: JSON.stringify({ totp_url: 'otpauth://totp/Ory:jane%40example.com?issuer=Ory&secret=JBSWY3DPEHPK3PXP' }), nid: 'n1' },
      {
        id: 'c4',
        identity_id: JANE,
        identity_credential_type_id: 't-lookup',
        config: JSON.stringify({ recovery_codes: [{ code: 'aaaa1111', used_at: null }, { code: 'bbbb2222', used_at: '2024-03-01T00:00:00Z' }, { code: 'cccc3333' }] }),
        nid: 'n1',
      },
      {
        id: 'c5',
        identity_id: JANE,
        identity_credential_type_id: 't-webauthn',
        config: JSON.stringify({
          credentials: [
            {
              id: 'AQIDBA==',
              public_key: 'pQECAyYgASFY',
              attestation_type: 'none',
              authenticator: { aaguid: 'AQIDBAUGBwgJCgsMDQ4PEA==', sign_count: 7, clone_warning: false },
              display_name: 'MacBook',
              is_passwordless: true,
              added_at: '2024-01-03T00:00:00Z',
              flags: { backup_state: true },
            },
            { id: 'BQYHCA==', public_key: 'pQECAyYgASFY', authenticator: { aaguid: 'AAAAAAAAAAAAAAAAAAAAAA==', sign_count: 0 }, display_name: 'YubiKey', is_passwordless: false },
          ],
          user_handle: 'dXNlcg==',
        }),
        nid: 'n1',
      },
      { id: 'c6', identity_id: SAM, identity_credential_type_id: 't-pw', config: { hashed_password: '$hmac-md4$MWQ5ZTI4Nzc2Zjg4YmE2MTQ5YjQ0OTMyOGE4NWU4YjA=$MTIzNDU=' }, nid: 'n1' },
      { id: 'c7', identity_id: OLD, identity_credential_type_id: 't-pw', config: { hashed_password: ARGON }, nid: 'n1' },
    ],
    identity_credential_identifiers: [
      { identity_credential_id: 'c1', identifier: 'Jane@Example.com', nid: 'n1' },
      { identity_credential_id: 'c6', identifier: 'sam', nid: 'n1' },
    ],
    sessions: [
      { id: 's1', identity_id: JANE, token: 'ory_st_aaaaaaaa', active: 't', expires_at: '2030-01-01 00:00:00+00', authenticated_at: '2026-01-01 00:00:00+00', aal: 'aal2', nid: 'n1' },
      { id: 's2', identity_id: JANE, token: 'ory_st_expired', active: 't', expires_at: '2020-01-01 00:00:00+00', nid: 'n1' },
      { id: 's3', identity_id: SAM, token: 'ory_st_loggedout', active: 'f', expires_at: '2030-01-01 00:00:00+00', nid: 'n1' },
      { id: 's4', identity_id: 'unknown', token: 'ory_st_orphan', active: 't', expires_at: '2030-01-01 00:00:00+00', nid: 'n1' },
    ],
    ...over,
  });
}

describe('oryPasswordHash', () => {
  it('keeps bcrypt, Argon2 and LDAP digests verbatim', () => {
    expect(oryPasswordHash(BCRYPT)).toEqual({ algorithm: 'bcrypt', hash: BCRYPT });
    expect(oryPasswordHash(ARGON)).toEqual({ algorithm: 'argon2', hash: ARGON });
    expect(oryPasswordHash('{SSHA}JFZFs0oHzxbMwkSJmYVeI8MnTDy/276a')).toEqual({ algorithm: 'auto', hash: '{SSHA}JFZFs0oHzxbMwkSJmYVeI8MnTDy/276a' });
  });

  it('maps $pbkdf2-<digest>$i=,l= onto generic PBKDF2 with base64 fields', () => {
    expect(oryPasswordHash('$pbkdf2-sha256$i=100000,l=32$1jP+5Zxpxgtee/iPxGgOz0RfE9/KJuDElP1ley4VxXc$QJxzfvdbHYBpydCbHoFg3GJEqMFULwskiuqiJctoYpI')).toEqual({
      algorithm: 'pbkdf2',
      hash: 'QJxzfvdbHYBpydCbHoFg3GJEqMFULwskiuqiJctoYpI',
      salt: '1jP+5Zxpxgtee/iPxGgOz0RfE9/KJuDElP1ley4VxXc',
      params: { digest: 'sha256', iterations: 100000, key_length: 32, encoding: 'base64', salt_encoding: 'base64' },
    });
  });

  it('maps $scrypt$ln= (N itself) and $firescrypt$', () => {
    expect(oryPasswordHash('$scrypt$ln=16384,r=8,p=1$2npRo7P03Mt8keSoMbyD/tKFWyUzjiQf2svUaNDSrhA=$MiCzNcIplSMqSBrm4HckjYqYhaVPPjTARTzwB1cVNYE=')).toEqual({
      algorithm: 'scrypt',
      hash: 'MiCzNcIplSMqSBrm4HckjYqYhaVPPjTARTzwB1cVNYE=',
      salt: '2npRo7P03Mt8keSoMbyD/tKFWyUzjiQf2svUaNDSrhA=',
      params: { n: 16384, r: 8, p: 1, encoding: 'base64', salt_encoding: 'base64' },
    });
    const fire = '$firescrypt$ln=14,r=8,p=1$sPtDhWcd1MfdAw==$xbSou7FOl6mChCyzpCPIQ7tku7nsQMTFtyOZSXXd7tjBa4NtimOx7v42Gv2SfzPQu1oxM2/k4SsbOu73wlKe1A==$Bw==$YE0dO4bwD4JnJafh6lZZfkp1MtKzuKAXQcDCJNJNyeCHairWHKENOkbh3dzwaCdizzOspwr/FITUVlnOAwPKyw==';
    expect(oryPasswordHash(fire)).toEqual({
      algorithm: 'scrypt_firebase',
      hash: 'xbSou7FOl6mChCyzpCPIQ7tku7nsQMTFtyOZSXXd7tjBa4NtimOx7v42Gv2SfzPQu1oxM2/k4SsbOu73wlKe1A==',
      salt: 'sPtDhWcd1MfdAw==',
      params: { rounds: 8, mem_cost: 14, salt_separator: 'Bw==', signer_key: 'YE0dO4bwD4JnJafh6lZZfkp1MtKzuKAXQcDCJNJNyeCHairWHKENOkbh3dzwaCdizzOspwr/FITUVlnOAwPKyw==' },
    });
    expect(oryPasswordHash(fire.replace('p=1', 'p=2'))).toBeNull();
  });

  it('leaves the Kratos-only digest formats to the registry ("auto") and maps plain md5', () => {
    const pf = '$sha1$pf=e1NBTFR9e1BBU1NXT1JEfQ==$NW9wbWtnejAzcg==$99h9net4BXl7qdTRaiGUobLROxM=';
    const hmac = '$hmac-sha256$ZTAzMWJhMWMyOTM4YjFkMjgzZjkxOWExZGY5YWM2NmMxOTJhN2RkNzQ0MzJkNWZkNGFkYTI5OTk0MWJhMTA5Zg==$MTIzNDU=';
    expect(oryPasswordHash(pf)).toEqual({ algorithm: 'auto', hash: pf });
    expect(oryPasswordHash(hmac)).toEqual({ algorithm: 'auto', hash: hmac });
    expect(oryPasswordHash('$md5$CY9rzUYh03PK3k6DJie09g==')).toEqual({ algorithm: 'md5', hash: 'CY9rzUYh03PK3k6DJie09g==', params: { encoding: 'base64' } });
  });

  it('swaps the Kratos crypt prefixes for the crypt(3) ones', () => {
    expect(oryPasswordHash('$md5-crypt$abcdefgh$1234567890123456789012')).toEqual({ algorithm: 'auto', hash: '$1$abcdefgh$1234567890123456789012' });
    expect(oryPasswordHash('$sha512-crypt$rounds=5000$salt$hashvalue')).toEqual({ algorithm: 'auto', hash: '$6$rounds=5000$salt$hashvalue' });
  });

  it('refuses formats Atlas cannot verify', () => {
    expect(oryPasswordHash('$hmac-md4$MWQ5ZTI4Nzc2Zjg4YmE2MTQ5YjQ0OTMyOGE4NWU4YjA=$MTIzNDU=')).toBeNull();
    expect(oryPasswordHash('plaintext')).toBeNull();
    expect(oryPasswordHash('')).toBeNull();
    expect(oryPasswordHash(undefined)).toBeNull();
  });
});

describe('exportOryTables (database dump)', () => {
  const set = exportOryTables(dump(), { rpId: 'example.com', networkId: 'n1', now: Date.parse('2026-06-01T00:00:00Z') });
  const user = (id: string) => set.list('user').find((u) => u.id === id)!;

  it('exports the identity id as the user id, with traits mapped onto the profile', () => {
    expect(set.list('user').map((u) => u.id)).toEqual([JANE, SAM, OLD]);
    expect(user(JANE)).toMatchObject({
      first_name: 'Jane',
      last_name: 'Doe',
      emails: [{ email: 'jane@example.com', verified: true, primary: true }],
      phones: [{ phone: '+14155550101', verified: false, primary: true }],
      public_metadata: { plan: 'pro' },
      private_metadata: { crm: 'c-1', ory_schema_id: 'customer' },
      unsafe_metadata: { ory_traits: { newsletter: true } },
      created_at: '2024-01-02T03:04:05.123Z',
    });
    expect(user(SAM)).toMatchObject({ username: 'sam', emails: [{ email: 'sam@example.com', verified: false }] });
  });

  it('treats an inactive identity as banned and drops identities with no way to sign in', () => {
    expect(user(OLD)).toMatchObject({ banned: true, ban_reason: 'Deactivated in Ory' });
    expect(set.omitted.user).toEqual({ count: 1, reason: 'Identity with no email address, phone number or username' });
  });

  it('carries password hashes in their algorithm and warns for the ones it cannot verify', () => {
    expect(user(JANE).password).toEqual({ algorithm: 'bcrypt', hash: BCRYPT });
    expect(user(OLD).password).toEqual({ algorithm: 'argon2', hash: ARGON });
    expect(user(SAM).password).toBeUndefined();
    expect(set.warnings.join('\n')).toMatch(/1 password hash\(es\) are in a format Atlas cannot verify/);
  });

  it('links social identities by provider and subject', () => {
    expect(set.list('identity')).toEqual([{ user_id: JANE, provider: 'google', provider_user_id: '10938475', email: 'jane@example.com' }]);
    expect(set.manifest.providers).toEqual(['google']);
  });

  it('exports the TOTP seed and only the unused recovery codes', () => {
    expect(set.list('mfa_factor')).toEqual([
      { user_id: JANE, type: 'totp', secret_base32: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30, algorithm: 'SHA1', verified: true },
      { user_id: JANE, type: 'backup_codes', backup_codes: ['aaaa1111', 'cccc3333'], verified: true },
    ]);
  });

  it('exports WebAuthn credentials as passkeys bound to the relying-party id', () => {
    expect(set.list('passkey')).toEqual([
      {
        id: 'AQIDBA',
        user_id: JANE,
        credential_id: 'AQIDBA',
        public_key: 'pQECAyYgASFY',
        sign_count: 7,
        rp_id: 'example.com',
        aaguid: '01020304-0506-0708-090a-0b0c0d0e0f10',
        backed_up: true,
        name: 'MacBook',
        created_at: '2024-01-03T00:00:00.000Z',
      },
      { id: 'BQYHCA', user_id: JANE, credential_id: 'BQYHCA', public_key: 'pQECAyYgASFY', rp_id: 'example.com', name: 'YubiKey' },
    ]);
    expect(set.warnings.join('\n')).toMatch(/1 WebAuthn credential\(s\) were security keys used only as a second factor/);
    expect(set.manifest.rpId).toBe('example.com');
  });

  it('exports only live sessions of exported identities, as token hashes', () => {
    expect(set.list('session')).toEqual([
      { id: 's1', user_id: JANE, token_hash: sha('ory_st_aaaaaaaa'), expires_at: Date.parse('2030-01-01T00:00:00Z'), mfa_verified: true, created_at: '2026-01-01T00:00:00.000Z' },
    ]);
    expect(set.omitted.session).toEqual({ count: 2, reason: 'Session already expired, signed out or without a token' });
  });

  it('leaves passkeys out, with a warning, when no relying-party id is given', () => {
    const noRp = exportOryTables(dump(), { networkId: 'n1' });
    expect(noRp.list('passkey')).toEqual([]);
    expect(noRp.omitted.passkey).toEqual({ count: 2, reason: 'No relying-party id given (--set ory-rp-id)' });
    expect(noRp.warnings.join('\n')).toMatch(/--set ory-rp-id/);
  });

  it('refuses a multi-project dump without a network id, and reads only that project with one', () => {
    const multi = dump({ identities: [{ id: JANE, traits: { email: 'a@example.com' }, nid: 'n1' }, { id: SAM, traits: { email: 'b@example.com' }, nid: 'n2' }] });
    expect(() => exportOryTables(multi)).toThrow(/several Ory projects.*--set ory-nid/);
    expect(exportOryTables(multi, { networkId: 'n2' }).list('user').map((u) => u.id)).toEqual([SAM]);
  });

  it('infers the credential type from its config when the types table is missing', () => {
    const bare = new Tables({
      identities: [{ id: JANE, traits: { email: 'a@example.com' } }],
      identity_credentials: [{ id: 'c1', identity_id: JANE, config: { hashed_password: BCRYPT } }],
    });
    expect(exportOryTables(bare).list('user')[0]!.password).toEqual({ algorithm: 'bcrypt', hash: BCRYPT });
  });

  it('flags a password still held by the migration webhook', () => {
    const hook = new Tables({
      identities: [{ id: JANE, traits: { email: 'a@example.com' } }],
      identity_credential_types: [{ id: 't', name: 'password' }],
      identity_credentials: [{ id: 'c1', identity_id: JANE, identity_credential_type_id: 't', config: { use_password_migration_hook: true } }],
    });
    const out = exportOryTables(hook);
    expect(out.list('user')[0]!.password).toBeUndefined();
    expect(out.warnings.join('\n')).toMatch(/password-migration webhook/);
  });
});

const ORIGIN = 'https://kratos.example.com';
const API_JANE = {
  id: JANE,
  schema_id: 'default',
  state: 'active',
  traits: { email: 'jane@example.com', name: 'Jane Doe' },
  verifiable_addresses: [{ value: 'jane@example.com', via: 'email', verified: true, status: 'completed' }],
  metadata_public: { plan: 'pro' },
  credentials: {
    password: { type: 'password', identifiers: ['jane@example.com'] },
    totp: { type: 'totp', identifiers: ['x'] },
    webauthn: { type: 'webauthn', identifiers: ['jane@example.com'] },
    oidc: { type: 'oidc', identifiers: ['github:42'], config: { providers: [{ subject: '42', provider: 'github' }] } },
  },
  created_at: '2024-01-01T00:00:00Z',
  organization_id: 'org-1',
};
const API_SAM = { id: SAM, traits: { email: 'sam@example.com' }, verifiable_addresses: [], credentials: { oidc: { type: 'oidc', identifiers: ['google:777'] } } };

describe('exportOryApi (Admin API)', () => {
  const api = () =>
    fakeVendor(ORIGIN, {
      'GET /admin/identities?page_size=250&include_credential=oidc': {
        status: 200,
        body: [API_JANE],
        headers: { link: '</admin/identities?page_size=250&page_token=T2>; rel="next", </admin/identities?page_size=250&page_token=T1>; rel="first"' },
      },
      'GET /admin/identities?page_size=250&include_credential=oidc&page_token=T2': [API_SAM],
    });

  it('pages with the Link header and sends the API key as a bearer token', async () => {
    const v = api();
    const set = await exportOryApi({ adminUrl: ORIGIN, apiKey: 'ory_pat_x', fetchImpl: v.fetchImpl, sleep: noSleep });
    expect(v.calls.map((c) => new URL(c.url).search)).toEqual(['?page_size=250&include_credential=oidc', '?page_size=250&include_credential=oidc&page_token=T2']);
    expect(v.calls.every((c) => c.headers.get('authorization') === 'Bearer ory_pat_x')).toBe(true);
    expect(set.list('user').map((u) => u.id)).toEqual([JANE, SAM]);
    expect(set.list('user')[0]).toMatchObject({ name: 'Jane Doe', emails: [{ email: 'jane@example.com', verified: true, primary: true }], public_metadata: { plan: 'pro' } });
  });

  it('reads social links from the oidc config, or from <provider>:<subject> identifiers', async () => {
    const set = await exportOryApi({ adminUrl: ORIGIN, fetchImpl: api().fetchImpl, sleep: noSleep });
    expect(set.list('identity').map((i) => [i.provider, i.provider_user_id])).toEqual([
      ['github', '42'],
      ['google', '777'],
    ]);
  });

  it('exports no hashes, seeds or passkeys and says so', async () => {
    const set = await exportOryApi({ adminUrl: ORIGIN, fetchImpl: api().fetchImpl, sleep: noSleep });
    expect(set.list('user')[0]!.password).toBeUndefined();
    expect(set.list('mfa_factor')).toEqual([]);
    expect(set.omitted.passkey).toEqual({ count: 1, reason: 'The Ory Admin API never returns WebAuthn / passkey credentials (export from the database)' });
    const warnings = set.warnings.join('\n');
    expect(warnings).toMatch(/1 identity has a password: the Admin API never returns password hashes/);
    expect(warnings).toMatch(/Session tokens are not exported/);
    expect(warnings).toMatch(/Ory Network organizations/);
  });

  it('turns a refused call into a named error', async () => {
    const v = fakeVendor(ORIGIN, { 'GET /admin/identities?page_size=250&include_credential=oidc': { status: 401, body: { error: { message: 'Unauthorized' } } } });
    await expect(exportOryApi({ adminUrl: ORIGIN, fetchImpl: v.fetchImpl, sleep: noSleep })).rejects.toThrow(/Ory API 401/);
  });
});

describe('nextPageToken', () => {
  it('reads the token from a relative or absolute rel="next" link', () => {
    expect(nextPageToken('</admin/identities?page_size=250&page_token=abc%3D>; rel="next"')).toBe('abc=');
    expect(nextPageToken(`<${ORIGIN}/admin/identities?page_token=z>; rel="next"`)).toBe('z');
    expect(nextPageToken('</admin/identities?page_token=a>; rel="first"')).toBeNull();
    expect(nextPageToken(null)).toBeNull();
  });
});
