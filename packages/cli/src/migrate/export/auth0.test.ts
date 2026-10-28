import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { auth0CustomHash, exportAuth0, parseLines, roleKey } from './auth0';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';

/**
 * Auth0 Management API v2 responses and export formats as Auth0 produces
 * them: the users-export job's gzipped NDJSON (one user per line, the fields
 * requested), checkpoint (`next`) and page/total paging, and the support
 * team's password-hash export (one MongoDB-shaped row per database user).
 */
const ORIGIN = 'https://acme.us.auth0.com';
const DOWNLOAD = 'https://auth0-exports.example-bucket.s3.amazonaws.com/job_1/acme.json.gz';

const EXPORTED = [
  {
    user_id: 'auth0|60d1f0c0ffee',
    email: 'Ada@Example.com',
    email_verified: true,
    given_name: 'Ada',
    family_name: 'Lovelace',
    name: 'Ada Lovelace',
    picture: 'https://s.gravatar.com/ada.png',
    phone_number: '+447700900123',
    phone_verified: false,
    identities: [{ provider: 'auth0', user_id: '60d1f0c0ffee', connection: 'Username-Password-Authentication', isSocial: false }],
    app_metadata: { roles: ['beta'], stripe_customer: 'cus_1' },
    user_metadata: { theme: 'dark' },
    created_at: '2021-06-22T10:00:00.000Z',
    last_login: '2024-01-01T00:00:00.000Z',
  },
  {
    user_id: 'google-oauth2|1093849',
    email: 'grace@gmail.com',
    email_verified: true,
    name: 'grace@gmail.com',
    identities: [{ provider: 'google-oauth2', user_id: '1093849', connection: 'google-oauth2', isSocial: true }],
    created_at: '2022-01-01T00:00:00.000Z',
    blocked: true,
  },
  {
    user_id: 'samlp|corp|ada@corp.example',
    email: 'ada@corp.example',
    email_verified: true,
    identities: [{ provider: 'samlp', user_id: 'corp|ada@corp.example', connection: 'corp', isSocial: false }],
  },
  { user_id: 'sms|60d2', identities: [{ provider: 'sms', user_id: '60d2', connection: 'sms' }] },
];

const HASHES = [
  JSON.stringify({ _id: { $oid: '60d1f0c0ffee' }, email: 'ada@example.com', email_verified: true, passwordHash: '$2b$10$C9GbKs8bMf1ZPqEUoWm8VuYxZZmWZ0zOiG0r6lJfnF3c0cXy/Wb5e', password_set_date: { $date: '2021-06-22T10:00:00.000Z' }, tenant: 'acme', connection: 'Username-Password-Authentication', _tmp_is_unique: true }),
  JSON.stringify({ _id: { $oid: 'ffff' }, email: 'nobody@example.com', passwordHash: '$2b$10$x' }),
].join('\n');

function auth0Api(over: Record<string, unknown> = {}) {
  return fakeVendor(ORIGIN, {
    'POST /oauth/token': ({ body }: { body: Record<string, string> }) =>
      body.client_secret === 'm2m-secret' && body.audience === `${ORIGIN}/api/v2/` ? { access_token: 'mgmt_token', token_type: 'Bearer' } : { status: 401, body: { error: 'access_denied' } },
    'GET /api/v2/connections': {
      connections: [
        {
          id: 'con_saml',
          name: 'corp',
          display_name: 'Corp SSO',
          strategy: 'samlp',
          options: { signInEndpoint: 'https://idp.corp.example/sso', signingCert: Buffer.from('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----').toString('base64'), domain_aliases: ['corp.example'], fieldsMap: { email: 'mail', given_name: 'gn', x: 1 } },
        },
        { id: 'con_oidc', name: 'partner', strategy: 'oidc', options: { discovery_url: 'https://partner.example/.well-known/openid-configuration', client_id: 'cid', issuer: 'https://partner.example', scope: 'openid email' } },
        { id: 'con_ad', name: 'onprem', strategy: 'ad', options: {} },
      ],
      total: 3,
    },
    'GET /api/v2/organizations': { organizations: [{ id: 'org_1', name: 'acme', display_name: 'Acme Inc', branding: { logo_url: 'https://acme.example/logo.png' }, metadata: { tier: 'gold' } }] },
    'GET /api/v2/roles': { roles: [{ id: 'rol_admin', name: 'Billing Admin', description: 'Pays bills' }], total: 1 },
    'GET /api/v2/roles/rol_admin/permissions': { permissions: [{ permission_name: 'invoices:read', resource_server_identifier: 'https://api.acme.example' }], total: 1 },
    'GET /api/v2/roles/rol_admin/users': { users: [{ user_id: 'auth0|60d1f0c0ffee', email: 'ada@example.com' }] },
    'POST /api/v2/jobs/users-exports': { id: 'job_1', type: 'users_export', status: 'pending' },
    'GET /api/v2/jobs/job_1': (() => {
      let polls = 0;
      return () => (++polls < 2 ? { id: 'job_1', status: 'processing', time_left_seconds: 3 } : { id: 'job_1', status: 'completed', location: DOWNLOAD });
    })(),
    [`GET ${DOWNLOAD}`]: gzipSync(EXPORTED.map((u) => JSON.stringify(u)).join('\n')),
    'GET /api/v2/organizations/org_1/members': ({ url }: { url: URL }) =>
      url.searchParams.get('from')
        ? { members: [{ user_id: 'google-oauth2|1093849', roles: [] }] }
        : { members: [{ user_id: 'auth0|60d1f0c0ffee', roles: [{ id: 'rol_admin', name: 'Billing Admin' }] }], next: 'cp_2' },
    'GET /api/v2/organizations/org_1/invitations': [
      { id: 'uinv_1', organization_id: 'org_1', invitee: { email: 'new@acme.example' }, inviter: { name: 'Ada' }, roles: ['rol_admin'], expires_at: '2030-01-01T00:00:00.000Z', created_at: '2024-01-01T00:00:00.000Z' },
    ],
    'GET /.well-known/jwks.json': { keys: [{ kid: 'k1', kty: 'RSA', n: 'x', e: 'AQAB', alg: 'RS256' }] },
    ...over,
  });
}

describe('exportAuth0', () => {
  it('runs the export job and maps users, hashes, identities, roles, orgs, members, invitations, connections and keys', async () => {
    const api = auth0Api();
    const set = await exportAuth0({ domain: 'acme.us.auth0.com', clientId: 'm2m', clientSecret: 'm2m-secret', hashesText: HASHES, fetchImpl: api.fetchImpl, sleep: noSleep });

    // The management token goes to the tenant only; the pre-signed download carries none.
    const mgmt = api.calls.filter((c) => c.url.startsWith(`${ORIGIN}/api/v2/`));
    expect(mgmt.every((c) => c.headers.get('authorization') === 'Bearer mgmt_token')).toBe(true);
    expect(api.calls.find((c) => c.url === DOWNLOAD)!.headers.get('authorization')).toBeNull();
    const job = api.calls.find((c) => c.url.endsWith('/jobs/users-exports'))!;
    expect((job.body as { format: string; fields: Array<{ name: string }> }).format).toBe('json');
    expect((job.body as { fields: Array<{ name: string }> }).fields.map((f) => f.name)).toContain('identities');

    expect(set.list('user')).toEqual([
      {
        id: 'auth0|60d1f0c0ffee',
        emails: [{ email: 'ada@example.com', verified: true, primary: true }],
        phones: [{ phone: '+447700900123', verified: false, primary: false }],
        first_name: 'Ada',
        last_name: 'Lovelace',
        image_url: 'https://s.gravatar.com/ada.png',
        roles: ['billing_admin'],
        private_metadata: { roles: ['beta'], stripe_customer: 'cus_1' },
        unsafe_metadata: { theme: 'dark' },
        created_at: '2021-06-22T10:00:00.000Z',
        last_sign_in_at: '2024-01-01T00:00:00.000Z',
        password: { algorithm: 'auto', hash: '$2b$10$C9GbKs8bMf1ZPqEUoWm8VuYxZZmWZ0zOiG0r6lJfnF3c0cXy/Wb5e' },
      },
      { id: 'google-oauth2|1093849', emails: [{ email: 'grace@gmail.com', verified: true, primary: true }], banned: true, created_at: '2022-01-01T00:00:00.000Z' },
      { id: 'samlp|corp|ada@corp.example', emails: [{ email: 'ada@corp.example', verified: true, primary: true }] },
    ]);
    expect(set.omitted.user).toEqual({ count: 1, reason: 'no email, phone number or username' });

    expect(set.list('identity')).toEqual([
      { user_id: 'google-oauth2|1093849', provider: 'google-oauth2', provider_user_id: '1093849', kind: 'oauth' },
      { user_id: 'samlp|corp|ada@corp.example', provider: 'corp', provider_user_id: 'corp|ada@corp.example', kind: 'saml', sso_connection_id: 'con_saml' },
    ]);
    expect(set.list('role')).toEqual([
      { key: 'billing_admin', name: 'Billing Admin', description: 'Pays bills', scope: 'app', permissions: ['invoices:read'] },
      { key: 'billing_admin', name: 'Billing Admin', description: 'Pays bills', scope: 'organization', permissions: ['invoices:read'] },
    ]);
    expect(set.list('organization')).toEqual([{ id: 'org_1', name: 'Acme Inc', slug: 'acme', image_url: 'https://acme.example/logo.png', public_metadata: { tier: 'gold' } }]);
    expect(set.list('membership')).toEqual([
      { organization_id: 'org_1', user_id: 'auth0|60d1f0c0ffee', role: 'billing_admin' },
      { organization_id: 'org_1', user_id: 'google-oauth2|1093849', role: 'member' },
    ]);
    expect(set.list('invitation')).toEqual([
      { id: 'uinv_1', organization_id: 'org_1', email: 'new@acme.example', role: 'billing_admin', status: 'pending', expires_at: '2030-01-01T00:00:00.000Z', created_at: '2024-01-01T00:00:00.000Z' },
    ]);
    const [saml, oidc] = set.list('sso_connection');
    expect(saml).toEqual({
      id: 'con_saml',
      name: 'Corp SSO',
      protocol: 'saml',
      domains: ['corp.example'],
      saml: {
        idp_sso_url: 'https://idp.corp.example/sso',
        idp_certificate: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
        sp_entity_id: 'urn:auth0:acme:corp',
        sp_acs_url: 'https://acme.us.auth0.com/login/callback?connection=corp',
        attribute_mapping: { email: 'mail', given_name: 'gn' },
      },
    });
    expect(oidc).toEqual({
      id: 'con_oidc',
      name: 'partner',
      protocol: 'oidc',
      oidc: { issuer: 'https://partner.example', discovery_url: 'https://partner.example/.well-known/openid-configuration', client_id: 'cid', scopes: ['openid', 'email'] },
    });
    expect(set.warnings.some((w) => w.includes('onprem (ad)'))).toBe(true);
    expect(set.warnings.some((w) => w.includes('partner: Auth0 does not return its client secret'))).toBe(true);
    expect(set.list('jwks')).toEqual([{ kid: 'k1', jwk: { kid: 'k1', kty: 'RSA', n: 'x', e: 'AQAB', alg: 'RS256' } }]);
    expect(set.manifest.origin).toBe('acme.us.auth0.com');
  });

  it('reads passkeys and phone factors from authentication methods when asked', async () => {
    const api = auth0Api({
      'GET /api/v2/users/auth0%7C60d1f0c0ffee/authentication-methods': {
        authenticators: [
          { id: 'phone|dev_1', type: 'phone', confirmed: true, phone_number: '+14155550123', created_at: '2024-01-01T00:00:00.000Z' },
          { id: 'totp|dev_2', type: 'totp', confirmed: true },
          { id: 'passkey|dev_3', type: 'passkey', confirmed: true, key_id: 'AbC+/dE=', public_key: 'pQECAyYg+/==', aaguid: 'adce0002-35bc-c60a-648b-0b25f1f05503', name: 'iCloud Keychain', credential_backed_up: true },
        ],
        total: 3,
      },
    });
    const set = await exportAuth0({ domain: 'https://acme.us.auth0.com/', token: 'pasted', authenticationMethods: true, rpId: 'acme.example', fetchImpl: api.fetchImpl, sleep: noSleep });
    expect(api.calls.some((c) => c.url.endsWith('/oauth/token'))).toBe(false);
    expect(set.list('mfa_factor')).toEqual([{ user_id: 'auth0|60d1f0c0ffee', type: 'phone', phone: '+14155550123', verified: true, created_at: '2024-01-01T00:00:00.000Z' }]);
    expect(set.list('passkey')).toEqual([
      {
        id: 'passkey|dev_3',
        user_id: 'auth0|60d1f0c0ffee',
        credential_id: 'AbC-_dE',
        public_key: 'pQECAyYg-_',
        rp_id: 'acme.example',
        aaguid: 'adce0002-35bc-c60a-648b-0b25f1f05503',
        name: 'iCloud Keychain',
        backed_up: true,
      },
    ]);
    expect(set.omitted.mfa_factor?.reason).toMatch(/totp secrets/);
    // No hash file: the warning points at the support ticket and the lazy preset.
    expect(set.warnings.some((w) => w.includes('support ticket') && w.includes('lazy-migration'))).toBe(true);
  });

  it('works offline from export files and explains a refused export job', async () => {
    const set = await exportAuth0({ domain: 'acme.us.auth0.com', usersText: EXPORTED.map((u) => JSON.stringify(u)).join('\n'), hashesText: HASHES });
    expect(set.count('user')).toBe(3);
    expect(set.list('user')[0]!.password?.hash).toMatch(/^\$2b\$10\$/);
    expect(set.count('organization')).toBe(0);

    const api = auth0Api({ 'POST /api/v2/jobs/users-exports': { status: 403, body: { message: 'Insufficient scope' } } });
    await expect(exportAuth0({ domain: 'acme.us.auth0.com', token: 't', fetchImpl: api.fetchImpl, sleep: noSleep })).rejects.toThrow(/--auth0-users-file/);
    await expect(exportAuth0({ domain: 'acme.us.auth0.com' })).rejects.toThrow(/Management API token/);
  });
});

describe('auth0 helpers', () => {
  it('parses NDJSON, a JSON array and { users }', () => {
    expect(parseLines('{"a":1}\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(parseLines('[{"a":1}]')).toEqual([{ a: 1 }]);
    expect(parseLines('{"users":[{"a":1}]}')).toEqual([{ a: 1 }]);
    expect(roleKey('Billing Admin!')).toBe('billing_admin');
  });

  it('maps custom_password_hash onto the hash registry', () => {
    expect(auth0CustomHash({ algorithm: 'sha256', hash: { value: 'abcd', encoding: 'hex' }, salt: { value: 'NaCl', position: 'suffix' } })).toEqual({
      algorithm: 'sha256_salted',
      hash: 'abcd',
      salt: 'NaCl',
      params: { encoding: 'hex', salt_position: 'suffix', salt_encoding: 'utf8' },
    });
    expect(auth0CustomHash({ algorithm: 'md5', hash: { value: 'abcd' } })).toEqual({ algorithm: 'md5', hash: 'abcd', params: { encoding: 'hex' } });
    expect(auth0CustomHash({ algorithm: 'pbkdf2', hash: { value: '$pbkdf2-sha512$i=100000,l=64$c2FsdA$aGFzaA' } })).toEqual({ algorithm: 'auto', hash: '$pbkdf2-sha512$i=100000,l=64$c2FsdA$aGFzaA' });
    expect(auth0CustomHash({ algorithm: 'hmac', hash: { value: 'ff', digest: 'sha256', key: { value: 'k' } } })).toEqual({
      algorithm: 'hmac_sha256',
      hash: 'ff',
      params: { key: 'k', key_encoding: 'utf8', encoding: 'hex' },
    });
    expect(auth0CustomHash({ algorithm: 'scrypt', hash: { value: 'ff' }, salt: { value: 's' }, keylen: 64, cost: 1024 })).toEqual({
      algorithm: 'scrypt',
      hash: 'ff',
      salt: 's',
      params: { n: 1024, r: 8, p: 1, key_length: 64, encoding: 'hex', salt_encoding: 'utf8' },
    });
    expect(auth0CustomHash({ algorithm: 'md4', hash: { value: 'ff' } })).toHaveProperty('reason');
    expect(auth0CustomHash({ algorithm: 'hmac', hash: { value: 'ff', digest: 'whirlpool', key: { value: 'k' } } })).toHaveProperty('reason');
    expect(auth0CustomHash({ algorithm: 'sha1', hash: { value: 'ff' }, password: { encoding: 'utf16le' } })).toHaveProperty('reason');
  });
});
