import { describe, expect, it } from 'vitest';
import { detectStytchProduct, exportStytch, mapStytchUser, parseStytchHashes, stytchAuthorization, stytchBaseUrl, stytchHttp, stytchPasswordHash, stytchRoleKey } from './stytch';

/**
 * Stytch API responses as the docs show them: `POST /v1/users/search`
 * (`results`, `results_metadata.next_cursor`), `POST /v1/b2b/organizations/search`
 * (`organizations`), `POST /v1/b2b/organizations/members/search` (`members`),
 * `GET /v1/b2b/sso/{organization_id}` (`saml_connections`, `oidc_connections`,
 * `external_connections`) and `GET /v1/b2b/rbac/policy`.
 */
const LIVE = 'project-live-11111111-2222-3333-4444-555555555555';
const SECRET = 'secret-live-abc';
const ORIGIN = 'https://api.stytch.com';
const noSleep = async () => undefined;

type Handler = unknown | ((req: { body: Record<string, unknown> }) => unknown);

/** Routes are `METHOD /path`; an unrouted call answers 404 like a vendor without the endpoint. */
function fake(routes: Record<string, Handler>) {
  const calls: Array<{ method: string; url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ method, url: url.toString(), headers: new Headers(init.headers), body });
    const route = routes[`${method} ${url.pathname}`];
    if (route === undefined) return new Response(JSON.stringify({ error_type: 'not_found' }), { status: 404 });
    const value = typeof route === 'function' ? (route as (r: { body: Record<string, unknown> }) => unknown)({ body }) : route;
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

// ── consumer ────────────────────────────────────────────────────────────────

const JANE = {
  user_id: 'user-live-jane',
  status: 'active',
  emails: [
    { email_id: 'email-1', email: 'Jane@Acme.example', verified: true },
    { email_id: 'email-2', email: 'jane.work@acme.example', verified: false },
  ],
  phone_numbers: [{ phone_id: 'phone-1', phone_number: '+1 415 555 0101', verified: true }],
  name: { first_name: 'Jane', middle_name: 'Q', last_name: 'Doe' },
  providers: [{ provider_type: 'Google', provider_subject: 'g-123', profile_picture_url: 'https://img.example/j.png', locale: 'en', oauth_user_registration_id: 'oauth-1' }],
  totps: [{ totp_id: 'totp-1', verified: true }],
  webauthn_registrations: [{ webauthn_registration_id: 'wa-1', domain: 'acme.example', verified: true }],
  biometric_registrations: [],
  password: { password_id: 'password-1', requires_reset: false },
  trusted_metadata: { plan: 'pro' },
  untrusted_metadata: { theme: 'dark' },
  external_id: 'ext-1',
  roles: ['editor'],
  created_at: '2024-01-02T03:04:05Z',
};
const SAM = { user_id: 'user-live-sam', status: 'active', emails: [], phone_numbers: [{ phone_number: '+14155550102', verified: true }], is_locked: true, created_at: '2024-01-03T00:00:00Z' };
const NOBODY = { user_id: 'user-live-none', status: 'pending', emails: [], phone_numbers: [] };

function consumerApi() {
  return fake({
    'POST /v1/users/search': ({ body }: { body: Record<string, any> }) =>
      body.cursor === 'cursor-2'
        ? { results: [SAM, NOBODY], results_metadata: { total: 3, next_cursor: null } }
        : { results: [JANE], results_metadata: { total: 3, next_cursor: 'cursor-2' } },
  });
}

describe('exportStytch (consumer)', () => {
  it('pages users with Basic auth and maps emails, phones, names, providers and metadata', async () => {
    const api = consumerApi();
    const progress: string[] = [];
    const set = await exportStytch({ projectId: LIVE, secret: SECRET, product: 'consumer', fetchImpl: api.fetchImpl, sleep: noSleep, onProgress: (m) => progress.push(m) });

    expect(progress).toEqual(['users']);
    expect(api.calls.every((c) => c.url.startsWith(ORIGIN) && c.headers.get('authorization') === `Basic ${Buffer.from(`${LIVE}:${SECRET}`).toString('base64')}`)).toBe(true);
    expect(api.calls.map((c) => c.body)).toEqual([{ limit: 1000 }, { limit: 1000, cursor: 'cursor-2' }]);

    const [jane, sam] = set.list('user');
    expect(set.count('user')).toBe(2);
    expect(jane).toEqual({
      id: 'user-live-jane',
      emails: [
        { email: 'jane@acme.example', verified: true, primary: true },
        { email: 'jane.work@acme.example', verified: false, primary: false },
      ],
      phones: [{ phone: '+14155550101', verified: true, primary: false }],
      first_name: 'Jane Q',
      last_name: 'Doe',
      roles: ['editor'],
      private_metadata: { plan: 'pro', stytch_external_id: 'ext-1' },
      unsafe_metadata: { theme: 'dark' },
      created_at: '2024-01-02T03:04:05Z',
    });
    expect(sam).toEqual({ id: 'user-live-sam', phones: [{ phone: '+14155550102', verified: true, primary: true }], locked: true, created_at: '2024-01-03T00:00:00Z' });
    expect(set.omitted.user).toEqual({ count: 1, reason: 'no email address or phone number' });

    expect(set.list('identity')).toEqual([
      { user_id: 'user-live-jane', provider: 'google', provider_user_id: 'g-123', kind: 'oauth', profile: { picture: 'https://img.example/j.png', locale: 'en' } },
    ]);
    expect(set.list('role')).toEqual([{ key: 'editor', scope: 'app' }]);
    expect(set.omitted.mfa_factor).toEqual({ count: 1, reason: 'Stytch does not export TOTP secrets; re-enrol in Atlas' });
    expect(set.omitted.passkey?.count).toBe(1);
    expect(set.warnings.some((w) => w.startsWith('No password hashes') && w.includes('lazy-migration'))).toBe(true);
    expect(set.manifest).toEqual({ origin: LIVE, providers: ['google'], settings: { product: 'consumer', project_id: LIVE } });
  });

  it('attaches hashes from a CSV support export by user id or email and counts the rest', async () => {
    const bcrypt = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
    const hashesText = [
      'user_id,email,hash,hash_type,salt,n_parameter,r_parameter,p_parameter,key_length',
      'user-live-jane,jane@acme.example,aGFzaA==,scrypt,c2FsdA==,32768,8,1,32',
      `user-live-sam,,${bcrypt},bcrypt,,,,,`,
      `,ghost@x.example,${bcrypt},bcrypt,,,,,`,
    ].join('\n');
    const set = await exportStytch({ projectId: LIVE, secret: SECRET, product: 'consumer', hashesText, fetchImpl: consumerApi().fetchImpl, sleep: noSleep });
    const [jane, sam] = set.list('user');
    expect(jane!.password).toEqual({ algorithm: 'scrypt', hash: 'aGFzaA==', salt: 'c2FsdA==', params: { n: 32768, r: 8, p: 1, key_length: 32, encoding: 'base64', salt_encoding: 'base64' } });
    expect(sam!.password).toEqual({ algorithm: 'bcrypt', hash: bcrypt });
    expect(set.warnings).toContain('1 row(s) of the Stytch password export matched no exported user and were left out.');
    expect(set.warnings.some((w) => w.startsWith('No password hashes'))).toBe(false);
  });

  it('detects the product: a consumer project refuses the B2B organization search', async () => {
    const api = consumerApi();
    const set = await exportStytch({ projectId: LIVE, secret: SECRET, fetchImpl: api.fetchImpl, sleep: noSleep });
    expect(api.calls[0]!.url).toBe(`${ORIGIN}/v1/b2b/organizations/search`);
    expect(set.manifest.settings).toMatchObject({ product: 'consumer' });
    expect(set.count('user')).toBe(2);
  });

  it('talks to test.stytch.com for a test project and honours a custom base URL', async () => {
    expect(stytchBaseUrl('project-test-aaaa')).toBe('https://test.stytch.com');
    expect(stytchBaseUrl(LIVE)).toBe(ORIGIN);
    expect(stytchAuthorization('p', 's')).toBe(`Basic ${Buffer.from('p:s').toString('base64')}`);
    const api = fake({ 'POST /v1/users/search': { results: [], results_metadata: { next_cursor: null } } });
    await exportStytch({ projectId: 'project-test-aaaa', secret: SECRET, product: 'consumer', fetchImpl: api.fetchImpl, sleep: noSleep });
    expect(api.calls[0]!.url).toBe('https://test.stytch.com/v1/users/search');
    const custom = fake({ 'POST /v1/users/search': { results: [], results_metadata: { next_cursor: null } } });
    await exportStytch({ projectId: LIVE, secret: SECRET, product: 'consumer', baseUrl: 'https://auth.acme.example/', fetchImpl: custom.fetchImpl, sleep: noSleep });
    expect(custom.calls[0]!.url).toBe('https://auth.acme.example/v1/users/search');
  });

  it('detectStytchProduct reads a B2B project from a successful organization search', async () => {
    const api = fake({ 'POST /v1/b2b/organizations/search': { organizations: [] } });
    expect(await detectStytchProduct(stytchHttp({ projectId: LIVE, secret: SECRET, fetchImpl: api.fetchImpl, sleep: noSleep }))).toBe('b2b');
  });

  it('mapStytchUser drops a user with nothing to sign in with and unusable phone numbers', () => {
    expect(mapStytchUser({ user_id: 'u', emails: [], phone_numbers: [{ phone_number: '12' }] })).toBeNull();
    expect(mapStytchUser({ emails: [{ email: 'a@b.co' }] })).toBeNull();
    expect(mapStytchUser({ user_id: 'u', emails: [{ email: 'A@B.co', verified: false }], roles: [{ role_id: 'admin' }] })).toEqual({ id: 'u', emails: [{ email: 'a@b.co', verified: false, primary: true }], roles: ['admin'] });
  });
});

// ── B2B ─────────────────────────────────────────────────────────────────────

const ACME = 'organization-live-acme';
const BETA = 'organization-live-beta';
const member = (over: Record<string, unknown>) => ({ organization_id: ACME, email_address_verified: true, status: 'active', roles: [{ role_id: 'stytch_member', sources: [] }], oauth_registrations: [], sso_registrations: [], created_at: '2024-01-01T00:00:00Z', ...over });

const ADA = member({
  member_id: 'member-live-1',
  email_address: 'Ada@Acme.example',
  name: 'Ada Lovelace',
  roles: [{ role_id: 'stytch_admin', sources: [] }],
  oauth_registrations: [{ provider_type: 'Google', provider_subject: 'g-1', member_oauth_registration_id: 'oauth-m-1' }],
  sso_registrations: [
    { connection_id: 'saml-connection-live-1', external_id: 'okta-ada', registration_id: 'r1' },
    { connection_id: 'saml-connection-gone', external_id: 'x', registration_id: 'r2' },
  ],
  mfa_enrolled: true,
  mfa_phone_number: '+14155550111',
  mfa_phone_number_verified: true,
  totp_registration_id: 'totp-1',
  trusted_metadata: { dept: 'eng' },
});
const BOB = member({ member_id: 'member-live-2', email_address: 'bob@acme.example', email_address_verified: false, status: 'pending', roles: [{ role_id: 'editor' }, { role_id: 'billing' }], created_at: '2024-02-01T00:00:00Z' });
const INVITED = member({ member_id: 'member-live-3', email_address: 'new@acme.example', status: 'invited', created_at: '2024-02-02T00:00:00Z' });
const DELETED = member({ member_id: 'member-live-4', email_address: 'gone@acme.example', status: 'deleted', created_at: '2024-02-03T00:00:00Z' });
const ADA_BETA = member({ member_id: 'member-live-5', organization_id: BETA, email_address: 'ada@acme.example', created_at: '2024-03-01T00:00:00Z' });

function b2bApi() {
  return fake({
    'GET /v1/b2b/rbac/policy': {
      policy: {
        roles: [
          { role_id: 'stytch_member', description: 'Default', permissions: [] },
          { role_id: 'stytch_admin', description: 'Default', permissions: [] },
          { role_id: 'editor', description: 'Editors', permissions: [{ resource_id: 'documents', actions: ['*'] }] },
        ],
        resources: [],
      },
    },
    'POST /v1/b2b/organizations/search': {
      organizations: [
        {
          organization_id: ACME,
          organization_name: 'Acme',
          organization_slug: 'acme',
          organization_logo_url: 'https://img.example/acme.png',
          organization_external_id: 'ext-org',
          email_allowed_domains: ['acme.example', 'extra.example'],
          claimed_email_domains: ['acme.example'],
          trusted_metadata: { tier: 'gold' },
          mfa_policy: 'REQUIRED_FOR_ALL',
          allowed_auth_methods: ['sso', 'password'],
          custom_roles: [{ role_id: 'billing', description: 'Billing', permissions: [{ resource_id: 'invoices', actions: ['read', 'write'] }] }],
          created_at: '2023-12-01T00:00:00Z',
        },
        { organization_id: BETA, organization_name: 'Beta', organization_slug: 'beta' },
      ],
      results_metadata: { total: 2, next_cursor: null },
    },
    [`GET /v1/b2b/sso/${ACME}`]: {
      saml_connections: [
        {
          organization_id: ACME,
          connection_id: 'saml-connection-live-1',
          status: 'active',
          display_name: 'Okta',
          idp_entity_id: 'http://www.okta.com/exk1',
          idp_sso_url: 'https://acme.okta.com/sso',
          verification_certificates: [{ certificate: 'MIIC-CERT' }],
          audience_uri: 'https://api.stytch.com/v1/b2b/sso/saml/saml-connection-live-1',
          acs_url: 'https://api.stytch.com/v1/b2b/sso/saml/acs/saml-connection-live-1',
          attribute_mapping: { email: 'NameID', first_name: 'firstName' },
        },
      ],
      oidc_connections: [{ organization_id: ACME, connection_id: 'oidc-connection-live-1', status: 'inactive', display_name: 'Entra', issuer: 'https://login.microsoftonline.com/t/v2.0', client_id: 'entra-client' }],
      external_connections: [{ connection_id: 'external-connection-1' }],
    },
    'POST /v1/b2b/organizations/members/search': ({ body }: { body: Record<string, any> }) => ({
      members: (body.organization_ids as string[])[0] === ACME ? [ADA, BOB, INVITED, DELETED] : [ADA_BETA],
      results_metadata: { total: 4, next_cursor: null },
    }),
  });
}

describe('exportStytch (B2B)', () => {
  it('maps organizations, roles, SSO, members and invitations', async () => {
    const api = b2bApi();
    const progress: string[] = [];
    const set = await exportStytch({ projectId: LIVE, secret: SECRET, fetchImpl: api.fetchImpl, sleep: noSleep, onProgress: (m) => progress.push(m) });
    expect(progress).toEqual(['roles', 'organizations', 'SSO connections', 'members']);
    expect(api.calls.filter((c) => c.url.endsWith('/members/search')).map((c) => c.body)).toEqual([
      { organization_ids: [ACME], limit: 1000 },
      { organization_ids: [BETA], limit: 1000 },
    ]);

    expect(set.list('organization')).toEqual([
      {
        id: ACME,
        name: 'Acme',
        slug: 'acme',
        image_url: 'https://img.example/acme.png',
        domains: ['acme.example'],
        private_metadata: { tier: 'gold', stytch_external_id: 'ext-org', stytch_mfa_policy: 'REQUIRED_FOR_ALL', stytch_allowed_auth_methods: ['sso', 'password'] },
        created_at: '2023-12-01T00:00:00Z',
      },
      { id: BETA, name: 'Beta', slug: 'beta' },
    ]);
    expect(set.warnings).toContain('Organization Acme: 1 allowed email domain(s) are not claimed (verified) in Stytch; add them in Atlas once verified.');
    expect(set.warnings).toContain('Organization Acme requires MFA for all members: set the matching MFA requirement in Atlas.');

    // Built-in Stytch roles are Atlas's admin/member; custom ones become roles.
    expect(set.list('role')).toEqual([
      { key: 'editor', description: 'Editors', scope: 'organization', permissions: ['documents:*'] },
      { key: 'billing', description: 'Billing', scope: 'organization', organization_id: ACME, permissions: ['invoices:read', 'invoices:write'] },
    ]);

    expect(set.list('sso_connection')).toEqual([
      {
        id: 'saml-connection-live-1',
        name: 'Okta',
        organization_id: ACME,
        protocol: 'saml',
        domains: ['acme.example', 'extra.example'],
        saml: {
          idp_entity_id: 'http://www.okta.com/exk1',
          idp_sso_url: 'https://acme.okta.com/sso',
          idp_certificate: 'MIIC-CERT',
          sp_entity_id: 'https://api.stytch.com/v1/b2b/sso/saml/saml-connection-live-1',
          sp_acs_url: 'https://api.stytch.com/v1/b2b/sso/saml/acs/saml-connection-live-1',
          attribute_mapping: { email: 'NameID', first_name: 'firstName' },
        },
        enabled: true,
      },
      {
        id: 'oidc-connection-live-1',
        name: 'Entra',
        organization_id: ACME,
        protocol: 'oidc',
        domains: ['acme.example', 'extra.example'],
        oidc: { issuer: 'https://login.microsoftonline.com/t/v2.0', client_id: 'entra-client' },
        enabled: false,
      },
    ]);
    expect(set.warnings).toContain('OIDC connection Entra: Stytch did not return its client secret; enter it in Atlas after the import.');
    expect(set.omitted.sso_connection?.count).toBe(1);

    // Members sharing an email become one user, keyed by the earliest member id.
    expect(set.list('user')).toEqual([
      {
        id: 'member-live-1',
        emails: [{ email: 'ada@acme.example', verified: true, primary: true }],
        name: 'Ada Lovelace',
        private_metadata: { dept: 'eng', stytch_member_ids: ['member-live-1', 'member-live-5'] },
        created_at: '2024-01-01T00:00:00Z',
      },
      { id: 'member-live-2', emails: [{ email: 'bob@acme.example', verified: false, primary: true }], created_at: '2024-02-01T00:00:00Z' },
    ]);
    expect(set.omitted.user).toEqual({ count: 1, reason: 'deleted member' });
    expect(set.warnings.some((w) => w.startsWith('1 Stytch members share an email'))).toBe(true);

    expect(set.list('membership')).toEqual([
      { organization_id: ACME, user_id: 'member-live-1', role: 'admin', created_at: '2024-01-01T00:00:00Z' },
      { organization_id: BETA, user_id: 'member-live-1', role: 'member', created_at: '2024-03-01T00:00:00Z' },
      { organization_id: ACME, user_id: 'member-live-2', role: 'editor', created_at: '2024-02-01T00:00:00Z' },
    ]);
    expect(set.warnings).toContain('Some members hold several Stytch roles; Atlas seats each member with one role (the first).');
    expect(set.list('invitation')).toEqual([{ id: 'member-live-3', organization_id: ACME, email: 'new@acme.example', role: 'member', status: 'pending', created_at: '2024-02-02T00:00:00Z' }]);

    expect(set.list('identity')).toEqual([
      { user_id: 'member-live-1', provider: 'google', provider_user_id: 'g-1', kind: 'oauth' },
      { user_id: 'member-live-1', provider: 'saml', provider_user_id: 'okta-ada', kind: 'saml', sso_connection_id: 'saml-connection-live-1', email: 'ada@acme.example', email_verified: true },
    ]);
    expect(set.omitted.identity?.count).toBe(1);
    expect(set.list('mfa_factor')).toEqual([{ user_id: 'member-live-1', type: 'phone', phone: '+14155550111', verified: true }]);
    expect(set.omitted.mfa_factor?.count).toBe(1);
    expect(set.manifest).toEqual({ origin: LIVE, providers: ['google', 'saml'], settings: { product: 'b2b', project_id: LIVE } });
  });

  it('attaches hashes from a JSON support export by member id (any organization) or email', async () => {
    const bcrypt = '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234';
    const hashesText = JSON.stringify([
      { member_id: 'member-live-5', hash: bcrypt, hash_type: 'bcrypt' },
      { email_address: 'bob@acme.example', hash: 'c2hhMQ==', hash_type: 'sha_1', prepend_salt: 'pre', append_salt: '' },
    ]);
    const set = await exportStytch({ projectId: LIVE, secret: SECRET, product: 'b2b', hashesText, fetchImpl: b2bApi().fetchImpl, sleep: noSleep });
    const [ada, bob] = set.list('user');
    expect(ada!.password).toEqual({ algorithm: 'bcrypt', hash: bcrypt });
    expect(bob!.password).toEqual({ algorithm: 'sha1_salted', hash: 'c2hhMQ==', salt: 'pre', params: { salt_position: 'prefix' } });
  });

  it('stytchRoleKey maps the built-in roles', () => {
    expect(stytchRoleKey('stytch_admin')).toBe('admin');
    expect(stytchRoleKey('stytch_member')).toBe('member');
    expect(stytchRoleKey('billing')).toBe('billing');
  });
});

// ── the support password export ─────────────────────────────────────────────

describe('stytchPasswordHash', () => {
  it('maps every hash type Stytch imports', () => {
    expect(stytchPasswordHash({ hash: '$2a$10$x', hash_type: 'bcrypt' })).toEqual({ algorithm: 'bcrypt', hash: '$2a$10$x' });
    expect(stytchPasswordHash({ hash: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA', hash_type: 'argon_2id' })).toEqual({ algorithm: 'auto', hash: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA' });
    expect(stytchPasswordHash({ hash: 'aGFzaA==', hash_type: 'argon_2i' })).toHaveProperty('reason');
    expect(stytchPasswordHash({ hash: 'aGFzaA==', hash_type: 'scrypt', salt: 'c2FsdA==', n_parameter: 16384 })).toEqual({
      algorithm: 'scrypt',
      hash: 'aGFzaA==',
      salt: 'c2FsdA==',
      params: { n: 16384, r: 8, p: 1, encoding: 'base64', salt_encoding: 'base64' },
    });
    expect(stytchPasswordHash({ hash: 'aGFzaA==', hash_type: 'scrypt' })).toHaveProperty('reason', 'Stytch scrypt hash without salt or N parameter');
    expect(stytchPasswordHash({ hash: 'aGFzaA==', hash_type: 'pbkdf_2', salt: 'c2FsdA==', iteration_amount: 100000, key_length: 32, digest: 'sha512' })).toEqual({
      algorithm: 'pbkdf2',
      hash: 'aGFzaA==',
      salt: 'c2FsdA==',
      params: { digest: 'sha512', iterations: 100000, key_length: 32, encoding: 'base64', salt_encoding: 'base64' },
    });
    expect(stytchPasswordHash({ hash: 'abc123', hash_type: 'md_5' })).toEqual({ algorithm: 'md5', hash: 'abc123' });
    expect(stytchPasswordHash({ hash: 'abc123', hash_type: 'sha_512', append_salt: 'tail' })).toEqual({ algorithm: 'sha512_salted', hash: 'abc123', salt: 'tail', params: { salt_position: 'suffix' } });
    expect(stytchPasswordHash({ hash: 'abc123', hash_type: 'md_5', prepend_salt: 'a', append_salt: 'b' })).toHaveProperty('reason');
    expect(stytchPasswordHash({ hash: '$P$Bxyz', hash_type: 'phpass' })).toEqual({ algorithm: 'auto', hash: '$P$Bxyz' });
    expect(stytchPasswordHash({ hash: '$2b$10$x' })).toEqual({ algorithm: 'auto', hash: '$2b$10$x' });
    expect(stytchPasswordHash({ hash: 'abc' })).toHaveProperty('reason');
    expect(stytchPasswordHash({ hash: 'abc', hash_type: 'rot13' })).toEqual({ reason: 'Stytch password hash type "rot13" is not supported' });
    expect(stytchPasswordHash({})).toEqual({ reason: 'empty Stytch password hash' });
  });
});

describe('parseStytchHashes', () => {
  it('reads a JSON array and flattens the nested config objects', () => {
    const rows = parseStytchHashes(
      JSON.stringify([{ member_id: 'm', email_address: 'A@B.co', hash: 'aGFzaA==', hash_type: 'scrypt', scrypt_config: { salt: 'c2FsdA==', n_parameter: 16384, r_parameter: 8, p_parameter: 1, key_length: 64 } }]),
    );
    expect(stytchPasswordHash(rows[0]!)).toEqual({
      algorithm: 'scrypt',
      hash: 'aGFzaA==',
      salt: 'c2FsdA==',
      params: { n: 16384, r: 8, p: 1, key_length: 64, encoding: 'base64', salt_encoding: 'base64' },
    });
  });

  it('reads an object wrapper, NDJSON and CSV; empty text is no rows', () => {
    expect(parseStytchHashes(JSON.stringify({ users: [{ user_id: 'u', hash: 'h' }] }))).toEqual([{ user_id: 'u', hash: 'h' }]);
    expect(parseStytchHashes('{"user_id":"a","hash":"1"}\n{"user_id":"b","hash":"2"}')).toEqual([
      { user_id: 'a', hash: '1' },
      { user_id: 'b', hash: '2' },
    ]);
    expect(parseStytchHashes('User_ID,Hash\r\nu1,"h,1"\r\n')).toEqual([{ user_id: 'u1', hash: 'h,1' }]);
    expect(parseStytchHashes('  \n')).toEqual([]);
  });
});
