import { describe, expect, it } from 'vitest';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';
import { Tables } from './frameworks/tables';
import { exportLogto, mapLogtoPassword, mapLogtoUser, normalizeEndpoint, parseLegacyExpression, tenantOfEndpoint } from './logto';

/**
 * Logto as it stores and serves its data: `psql \copy` style rows (snake_case
 * columns, JSONB as text, timestamps as epoch ms) for a self-hosted database
 * dump, and Management API objects (camelCase) for a tenant export.
 */
const ARGON = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$RdescudvJCsgt3ub+b+dWRWJTmaaJObG';
const BCRYPT = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
const HEX = 'a'.repeat(64);

const MFA = JSON.stringify([
  { type: 'Totp', key: 'jbswy3dpehpk3pxp', id: 'mf1', createdAt: '2024-01-02T03:04:05.000Z', lastUsedAt: null },
  { type: 'WebAuthn', id: 'mf2', createdAt: '2024-01-03T00:00:00.000Z', credentialId: 'AQIDBA', publicKey: 'BQYHCAk', transports: ['internal'], counter: 7, agent: 'Chrome', name: 'MacBook' },
  { type: 'BackupCode', id: 'mf3', createdAt: '2024-01-04T00:00:00.000Z', codes: [{ code: 'abc123', usedAt: null }, { code: 'def456', usedAt: 1700000000000 }] },
  { type: 'EmailVerificationCode', id: 'mf4' },
]);

function dump(): Tables {
  return new Tables({
    users: [
      {
        id: 'u1ada',
        username: 'ada',
        primary_email: 'Ada@Acme.example',
        primary_phone: '+1 415 555 0101',
        password_encrypted: ARGON,
        password_encryption_method: 'Argon2id',
        name: 'Ada Lovelace',
        avatar: 'https://cdn.example/ada.png',
        profile: '{"givenName":"Ada","familyName":"Lovelace","locale":"en"}',
        identities: '{"google":{"userId":"1093","details":{"email":"ada@gmail.com","name":"Ada"}}}',
        custom_data: '{"plan":"pro"}',
        mfa_verifications: MFA,
        is_suspended: 'f',
        created_at: 1700000000000,
        last_sign_in_at: 1710000000000,
        tenant_id: 'default',
      },
      { id: 'u2bob', primary_email: 'bob@acme.example', password_encrypted: BCRYPT, password_encryption_method: 'Bcrypt', is_suspended: 't', mfa_verifications: '[]', identities: '{}', tenant_id: 'default' },
      { id: 'u3cy', primary_email: 'cy@acme.example', password_encrypted: `["sha256",["salt","@"],"${HEX}"]`, password_encryption_method: 'Legacy', tenant_id: 'default' },
      { id: 'u4di', primary_email: 'di@acme.example', password_encrypted: `["md5",["@","x","@"],"${'b'.repeat(32)}"]`, password_encryption_method: 'Legacy', tenant_id: 'default' },
      { id: 'u5eve', identities: '{"github":{"userId":"77","details":{"email":"Eve@Example.com"}}}', tenant_id: 'default' },
      { id: 'u6none', tenant_id: 'default' },
      { id: 'u7other', primary_email: 'x@other.example', tenant_id: 'another-tenant' },
    ],
    roles: [
      { id: 'r1', name: 'Admin', description: 'Everything', type: 'User', is_default: 'f', tenant_id: 'default' },
      { id: 'r2', name: 'Machine', type: 'MachineToMachine', tenant_id: 'default' },
      { id: 'r3', name: 'Reader', type: 'User', is_default: 't', tenant_id: 'default' },
    ],
    scopes: [{ id: 's1', name: 'read:docs', tenant_id: 'default' }],
    roles_scopes: [{ role_id: 'r1', scope_id: 's1', tenant_id: 'default' }],
    users_roles: [{ user_id: 'u1ada', role_id: 'r1', tenant_id: 'default' }, { user_id: 'u2bob', role_id: 'r2', tenant_id: 'default' }],
    organizations: [{ id: 'o1', name: 'Acme', description: 'The org', custom_data: '{"tier":1}', is_mfa_required: 't', branding: '{"logoUrl":"https://cdn.example/acme.png"}', created_at: 1690000000000, tenant_id: 'default' }],
    organization_scopes: [{ id: 'os1', name: 'invite:member', tenant_id: 'default' }],
    organization_roles: [{ id: 'or1', name: 'Owner', type: 'User', tenant_id: 'default' }, { id: 'or2', name: 'Guest', type: 'User', tenant_id: 'default' }],
    organization_role_scope_relations: [{ organization_role_id: 'or1', organization_scope_id: 'os1', tenant_id: 'default' }],
    organization_role_resource_scope_relations: [{ organization_role_id: 'or1', scope_id: 's1', tenant_id: 'default' }],
    organization_user_relations: [
      { organization_id: 'o1', user_id: 'u1ada', tenant_id: 'default' },
      { organization_id: 'o1', user_id: 'u2bob', tenant_id: 'default' },
    ],
    organization_role_user_relations: [
      { organization_id: 'o1', user_id: 'u1ada', organization_role_id: 'or1', tenant_id: 'default' },
      { organization_id: 'o1', user_id: 'u1ada', organization_role_id: 'or2', tenant_id: 'default' },
    ],
    organization_invitations: [{ id: 'inv1', inviter_id: 'u1ada', invitee: 'New@Acme.example', organization_id: 'o1', status: 'Pending', expires_at: 1900000000000, created_at: 1700000000000, tenant_id: 'default' }],
    organization_invitation_role_relations: [{ organization_invitation_id: 'inv1', organization_role_id: 'or1', tenant_id: 'default' }],
    organization_jit_email_domains: [{ organization_id: 'o1', email_domain: 'acme.example', tenant_id: 'default' }],
    sso_connectors: [
      {
        id: 'sso1',
        provider_name: 'OIDC',
        connector_name: 'Okta',
        domains: '["acme.example"]',
        config: '{"issuer":"https://acme.okta.com","clientId":"cid","clientSecret":"sec","scope":"openid profile email"}',
        tenant_id: 'default',
      },
      {
        id: 'sso2',
        provider_name: 'SAML',
        connector_name: 'Partner',
        domains: '[]',
        config: '{"entityId":"https://idp.partner.example","signInEndpoint":"https://idp.partner.example/sso","x509Certificate":"MIIB","attributeMapping":{"email":"mail"}}',
        tenant_id: 'default',
      },
    ],
    user_sso_identities: [{ id: 'si1', user_id: 'u1ada', issuer: 'https://acme.okta.com', identity_id: 'okta-1', detail: '{"email":"Ada@Acme.example"}', sso_connector_id: 'sso1', tenant_id: 'default' }],
    personal_access_tokens: [{ user_id: 'u1ada', name: 'ci', value: 'pat_abcdef1234', expires_at: 1900000000000, created_at: 1700000000000, tenant_id: 'default' }],
  });
}

describe('exportLogto: database dump', () => {
  it('maps users, passwords, identities, MFA, passkeys and memberships of one tenant', async () => {
    const set = await exportLogto({ tables: dump(), rpId: 'auth.acme.example' });

    expect(set.list('user').map((u) => u.id)).toEqual(['u1ada', 'u2bob', 'u3cy', 'u4di', 'u5eve']);
    expect(set.omitted.user).toEqual({ count: 1, reason: 'no email, phone number or username' });
    const [ada, bob, cy, di, eve] = set.list('user');
    expect(ada).toMatchObject({
      id: 'u1ada',
      username: 'ada',
      emails: [{ email: 'ada@acme.example', verified: true, primary: true }],
      phones: [{ phone: '+14155550101', verified: true, primary: false }],
      first_name: 'Ada',
      last_name: 'Lovelace',
      name: 'Ada Lovelace',
      image_url: 'https://cdn.example/ada.png',
      password: { algorithm: 'argon2', hash: ARGON },
      roles: ['admin'],
      public_metadata: { plan: 'pro' },
      private_metadata: { logto_profile: { locale: 'en' } },
      created_at: 1700000000000,
      last_sign_in_at: 1710000000000,
    });
    expect(ada!.banned).toBeUndefined();
    expect(bob).toMatchObject({ password: { algorithm: 'bcrypt', hash: BCRYPT }, banned: true, ban_reason: 'Suspended in Logto' });
    // The machine-to-machine role is not carried.
    expect(bob!.roles).toBeUndefined();
    expect(cy!.password).toEqual({ algorithm: 'sha256_salted', hash: HEX, salt: 'salt', params: { salt_position: 'prefix', encoding: 'hex' } });
    expect(di!.password).toEqual({ algorithm: 'logto_legacy', hash: `["md5",["@","x","@"],"${'b'.repeat(32)}"]` });
    // A social-only account carries the provider's address, unverified.
    expect(eve!.emails).toEqual([{ email: 'eve@example.com', verified: false, primary: true }]);

    expect(set.list('role')).toEqual([
      { key: 'admin', name: 'Admin', description: 'Everything', scope: 'app', permissions: ['read:docs'] },
      { key: 'reader', name: 'Reader', scope: 'app' },
      { key: 'owner', name: 'Owner', scope: 'organization', permissions: ['invite:member', 'read:docs'] },
      { key: 'guest', name: 'Guest', scope: 'organization' },
      { key: 'member', name: 'Member', scope: 'organization' },
    ]);
    expect(set.warnings.some((w) => w.includes('default role(s) Reader'))).toBe(true);

    expect(set.list('identity').find((i) => i.provider === 'google')).toMatchObject({ user_id: 'u1ada', provider_user_id: '1093', kind: 'oauth', email: 'ada@gmail.com' });
    expect(set.list('identity').find((i) => i.sso_connection_id === 'sso1')).toMatchObject({ id: 'si1', user_id: 'u1ada', provider: 'Okta', provider_user_id: 'okta-1', kind: 'oidc', email: 'ada@acme.example' });

    expect(set.list('mfa_factor')).toEqual([
      { id: 'mf1', user_id: 'u1ada', type: 'totp', secret_base32: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, verified: true, created_at: '2024-01-02T03:04:05.000Z' },
      expect.objectContaining({ id: 'mf3', user_id: 'u1ada', type: 'backup_codes', backup_codes: ['abc123'], verified: true }),
    ]);
    expect(set.omitted.mfa_factor?.reason).toMatch(/EmailVerificationCode/);
    expect(set.list('passkey')).toEqual([
      expect.objectContaining({ id: 'mf2', user_id: 'u1ada', credential_id: 'AQIDBA', public_key: 'BQYHCAk', sign_count: 7, rp_id: 'auth.acme.example', transports: ['internal'], name: 'MacBook' }),
    ]);

    expect(set.list('organization')).toEqual([
      expect.objectContaining({ id: 'o1', name: 'Acme', image_url: 'https://cdn.example/acme.png', domains: ['acme.example'], public_metadata: { tier: 1, description: 'The org' }, private_metadata: { logto_mfa_required: true } }),
    ]);
    // A member with two organization roles keeps the first; a member with none gets "member".
    expect(set.list('membership')).toEqual([
      { organization_id: 'o1', user_id: 'u1ada', role: 'owner' },
      { organization_id: 'o1', user_id: 'u2bob', role: 'member' },
    ]);
    expect(set.warnings.some((w) => w.includes('1 membership(s) hold several organization roles'))).toBe(true);
    expect(set.list('invitation')).toEqual([expect.objectContaining({ id: 'inv1', organization_id: 'o1', email: 'new@acme.example', role: 'owner', status: 'pending', inviter_user_id: 'u1ada' })]);

    expect(set.list('sso_connection')).toEqual([
      expect.objectContaining({ id: 'sso1', name: 'Okta', protocol: 'oidc', domains: ['acme.example'], oidc: { issuer: 'https://acme.okta.com', client_id: 'cid', client_secret: 'sec', scopes: ['openid', 'profile', 'email'] } }),
      expect.objectContaining({ id: 'sso2', name: 'Partner', protocol: 'saml', saml: { idp_entity_id: 'https://idp.partner.example', idp_sso_url: 'https://idp.partner.example/sso', idp_certificate: 'MIIB', attribute_mapping: { email: 'mail' } } }),
    ]);
    const key = set.list('api_key')[0]!;
    expect(key).toMatchObject({ user_id: 'u1ada', name: 'ci', hash_algorithm: 'sha256', start: 'pat_abcd' });
    expect(key.hash).toMatch(/^[0-9a-f]{64}$/);

    expect(set.manifest.settings).toMatchObject({ tenant_id: 'default', read_from: 'database', password_algorithms: { argon2: 1, bcrypt: 1, sha256_salted: 1, logto_legacy: 1 } });
    expect(set.manifest.rpId).toBe('auth.acme.example');
    expect(set.manifest.providers).toEqual(['Okta', 'github', 'google']);
  });

  it('skips a TOTP key that is not base32 and a passkey with no relying-party id', async () => {
    const tables = new Tables({
      users: [{ id: 'u', primary_email: 'a@b.example', mfa_verifications: JSON.stringify([{ type: 'Totp', key: '!!!' }, { type: 'WebAuthn', credentialId: 'AQIDBA', publicKey: 'BQYHCAk' }]) }],
    });
    const set = await exportLogto({ tables });
    expect(set.count('mfa_factor')).toBe(0);
    expect(set.omitted.mfa_factor?.reason).toMatch(/not base32/);
    expect(set.omitted.passkey?.reason).toMatch(/relying-party id is unknown/);
  });

  it('reads the public signing keys when the endpoint is known', async () => {
    const api = fakeVendor('https://auth.acme.example', { 'GET /oidc/jwks': { keys: [{ kid: 'k1', kty: 'EC', crv: 'P-384', alg: 'ES384', x: 'x', y: 'y' }] } });
    const set = await exportLogto({ tables: dump(), endpoint: 'auth.acme.example', fetchImpl: api.fetchImpl, sleep: noSleep });
    expect(set.list('jwks').map((k) => k.kid)).toEqual(['k1']);
    expect(set.list('sso_connection')[1]!.saml).toMatchObject({ sp_entity_id: 'https://auth.acme.example/enterprise-sso/sso2', sp_acs_url: 'https://auth.acme.example/api/authn/single-sign-on/saml/sso2' });
    // The dump still exports when the keys cannot be read.
    const down = fakeVendor('https://auth.acme.example', {});
    expect((await exportLogto({ tables: dump(), endpoint: 'https://auth.acme.example', fetchImpl: down.fetchImpl, sleep: noSleep })).count('jwks')).toBe(0);
  });
});

describe('exportLogto: Management API', () => {
  const ORIGIN = 'https://abc123.logto.app';
  function management(over: Record<string, unknown> = {}) {
    return fakeVendor(ORIGIN, {
      'POST /oidc/token': { access_token: 'm2m-at', expires_in: 3600, token_type: 'Bearer' },
      'GET /api/users': [
        { id: 'u1', username: 'ada', primaryEmail: 'ada@acme.example', name: 'Ada', hasPassword: true, passwordDigest: BCRYPT, passwordAlgorithm: 'Bcrypt', identities: {}, customData: { plan: 'pro' }, profile: {}, isSuspended: false, createdAt: 1700000000000, lastSignInAt: 1710000000000 },
        { id: 'u2', primaryEmail: 'bob@acme.example', hasPassword: true, identities: {}, customData: {}, profile: {}, isSuspended: false },
      ],
      'GET /api/roles': [{ id: 'r1', name: 'Admin', type: 'User', isDefault: false }, { id: 'r2', name: 'M2M', type: 'MachineToMachine' }],
      'GET /api/roles/r1/scopes': [{ id: 's1', name: 'read:docs' }],
      'GET /api/roles/r1/users': [{ id: 'u1' }],
      'GET /api/organizations': [{ id: 'o1', name: 'Acme', customData: {} }],
      'GET /api/organization-roles': [{ id: 'or1', name: 'Owner', type: 'User', scopes: [{ id: 'os1', name: 'invite:member' }], resourceScopes: [] }],
      'GET /api/organizations/o1/users': [{ id: 'u1', organizationRoles: [{ id: 'or1', name: 'Owner' }] }],
      'GET /api/organizations/o1/jit/email-domains': [{ emailDomain: 'acme.example' }],
      'GET /api/organization-invitations': [{ id: 'inv1', organizationId: 'o1', invitee: 'n@acme.example', status: 'Pending', organizationRoles: [{ id: 'or1' }] }],
      'GET /api/sso-connectors': [{ id: 'sso1', providerName: 'OIDC', connectorName: 'Okta', domains: ['acme.example'], config: { issuer: 'https://acme.okta.com', clientId: 'cid' } }],
      'GET /api/users/u1': { id: 'u1', ssoIdentities: [{ id: 'si1', ssoConnectorId: 'sso1', identityId: 'okta-1', issuer: 'https://acme.okta.com', detail: { email: 'ada@acme.example' } }] },
      'GET /api/users/u2': { id: 'u2', ssoIdentities: [] },
      'GET /oidc/jwks': { keys: [{ kid: 'k1', kty: 'EC' }] },
      ...over,
    });
  }

  it('reads users with their password hashes, roles, organizations, SSO and keys with an M2M app', async () => {
    const api = management();
    const set = await exportLogto({ endpoint: ORIGIN, m2m: { appId: 'app1', appSecret: 's3cret' }, fetchImpl: api.fetchImpl, sleep: noSleep });

    const token = api.calls[0]!;
    expect(token.headers.get('authorization')).toBe(`Basic ${Buffer.from('app1:s3cret').toString('base64')}`);
    expect(String(token.body)).toContain('resource=https%3A%2F%2Fabc123.logto.app%2Fapi');
    expect(api.calls.some((c) => c.url.includes('/api/users?includePasswordHash=true'))).toBe(true);
    expect(api.calls.filter((c) => c.url.includes('/api/')).every((c) => c.headers.get('authorization') === 'Bearer m2m-at')).toBe(true);

    expect(set.list('user')[0]).toMatchObject({ id: 'u1', password: { algorithm: 'bcrypt', hash: BCRYPT }, roles: ['admin'], public_metadata: { plan: 'pro' } });
    expect(set.list('user')[1]!.password).toBeUndefined();
    expect(set.warnings.some((w) => w.includes('1 user(s) have a password the Management API did not return'))).toBe(true);
    expect(set.warnings.some((w) => w.includes('never returns MFA secrets'))).toBe(true);
    expect(set.list('role').map((r) => `${r.scope}:${r.key}`)).toEqual(['app:admin', 'organization:owner']);
    expect(set.list('membership')).toEqual([{ organization_id: 'o1', user_id: 'u1', role: 'owner' }]);
    expect(set.list('organization')[0]!.domains).toEqual(['acme.example']);
    expect(set.list('invitation')[0]).toMatchObject({ email: 'n@acme.example', role: 'owner', status: 'pending' });
    expect(set.list('identity')).toEqual([expect.objectContaining({ user_id: 'u1', provider: 'Okta', provider_user_id: 'okta-1', sso_connection_id: 'sso1', kind: 'oidc' })]);
    expect(set.list('jwks').map((k) => k.kid)).toEqual(['k1']);
    expect(set.count('mfa_factor')).toBe(0);
    expect(set.manifest).toMatchObject({ origin: 'abc123.logto.app', settings: { tenant_id: 'abc123', read_from: 'api' } });
  });

  it('warns and goes on when a listing is not available on this Logto', async () => {
    const api = management({ 'GET /api/organizations': { status: 404, body: {} }, 'GET /api/sso-connectors': { status: 403, body: {} }, 'GET /oidc/jwks': { status: 404, body: {} } });
    const set = await exportLogto({ endpoint: ORIGIN, m2m: { appId: 'a', appSecret: 'b' }, fetchImpl: api.fetchImpl, sleep: noSleep });
    expect(set.count('user')).toBe(2);
    expect(set.count('organization')).toBe(0);
    expect(set.warnings).toEqual(expect.arrayContaining(['Organizations could not be read (404): skipped.', 'SSO connectors could not be read (403): skipped.']));
  });

  it('reads personal access tokens only when asked', async () => {
    const api = management({ 'GET /api/users/u1/personal-access-tokens': [{ name: 'ci', value: 'pat_zzzzzzzz', createdAt: 1700000000000 }], 'GET /api/users/u2/personal-access-tokens': [] });
    const set = await exportLogto({ endpoint: ORIGIN, m2m: { appId: 'a', appSecret: 'b' }, personalAccessTokens: true, fetchImpl: api.fetchImpl, sleep: noSleep });
    expect(set.list('api_key')).toEqual([expect.objectContaining({ user_id: 'u1', name: 'ci', start: 'pat_zzzz' })]);
  });

  it('refuses without credentials and says why a token request failed', async () => {
    await expect(exportLogto({})).rejects.toThrow(/database dump/);
    await expect(exportLogto({ endpoint: ORIGIN })).rejects.toThrow(/machine-to-machine app id and secret/);
    const api = management({ 'POST /oidc/token': { status: 400, body: { error: 'invalid_client', error_description: 'invalid client credentials' } } });
    await expect(exportLogto({ endpoint: ORIGIN, m2m: { appId: 'a', appSecret: 'bad' }, fetchImpl: api.fetchImpl, sleep: noSleep })).rejects.toThrow(/invalid client credentials/);
  });
});

describe('Logto password shapes', () => {
  it('maps the stored methods onto registry algorithms', () => {
    expect(mapLogtoPassword(ARGON, 'Argon2id')).toEqual({ algorithm: 'argon2', hash: ARGON });
    expect(mapLogtoPassword('$argon2i$v=19$m=1,t=1,p=1$c2FsdA$aGFzaA', 'Argon2i')?.algorithm).toBe('argon2');
    expect(mapLogtoPassword(ARGON, 'Bcrypt')).toEqual({ algorithm: 'bcrypt', hash: ARGON });
    expect(mapLogtoPassword('5d41402abc4b2a76b9719d911017c592', 'MD5')).toEqual({ algorithm: 'md5', hash: '5d41402abc4b2a76b9719d911017c592', params: { encoding: 'hex' } });
    expect(mapLogtoPassword(HEX, 'SHA256')?.algorithm).toBe('sha256');
    expect(mapLogtoPassword(`["sha1",["@"],"${'c'.repeat(40)}"]`, 'Legacy')).toEqual({ algorithm: 'sha1', hash: 'c'.repeat(40), params: { encoding: 'hex' } });
    expect(mapLogtoPassword(`["sha256",["@","pepper"],"${HEX}"]`, 'Legacy')).toMatchObject({ algorithm: 'sha256_salted', salt: 'pepper', params: { salt_position: 'suffix' } });
  });

  it('maps PBKDF2 and Firebase scrypt Legacy expressions and keeps odd ones for the legacy verifier', () => {
    const hash = 'd'.repeat(64);
    expect(mapLogtoPassword(`["pbkdf2",["somesalt","10000","32","sha256","@"],"${hash}"]`, 'Legacy')).toEqual({
      algorithm: 'pbkdf2',
      hash,
      salt: 'somesalt',
      params: { digest: 'sha256', iterations: 10000, key_length: 32, encoding: 'hex', salt_encoding: 'utf8' },
    });
    expect(mapLogtoPassword(`["pbkdf2",["hex:0a0b","1000","32","sha512","@"],"${hash}"]`, 'Legacy')).toMatchObject({ salt: '0a0b', params: { salt_encoding: 'hex', digest: 'sha512' } });
    // The hash length must match the key length, or the verifier would never match.
    expect(mapLogtoPassword(`["pbkdf2",["s","1000","16","sha256","@"],"${hash}"]`, 'Legacy')?.algorithm).toBe('logto_legacy');
    expect(mapLogtoPassword('["firebase-scrypt",["salt","signer","sep","8","14","@"],"aGFzaA=="]', 'Legacy')).toEqual({
      algorithm: 'scrypt_firebase',
      hash: 'aGFzaA==',
      salt: 'salt',
      params: { signer_key: 'signer', salt_separator: 'sep', rounds: 8, mem_cost: 14 },
    });
  });

  it('returns null for nothing, an unknown method or a malformed expression', () => {
    expect(mapLogtoPassword('', 'Bcrypt')).toBeNull();
    expect(mapLogtoPassword(undefined, undefined)).toBeNull();
    expect(mapLogtoPassword('x', 'Whirlpool')).toBeNull();
    expect(mapLogtoPassword('not json', 'Legacy')).toBeNull();
    expect(mapLogtoPassword('["sha256",["salt"],"abc"]', 'Legacy')).toBeNull();
    expect(mapLogtoPassword('plain', 'Argon2id')).toBeNull();
    expect(parseLegacyExpression('["md5",["@"],"x"]')).toEqual({ algorithm: 'md5', args: ['@'], hash: 'x' });
  });

  it('flags a hash Logto itself cannot verify and drops users with nothing to sign in with', () => {
    expect(mapLogtoUser({ id: 'u', primaryEmail: 'a@b.example', passwordEncrypted: 'zzz', passwordEncryptionMethod: 'Whirlpool' })).toMatchObject({ passwordUnsupported: true });
    expect(mapLogtoUser({ id: 'u' }).user).toBeNull();
    expect(mapLogtoUser({}).user).toBeNull();
  });
});

describe('endpoints', () => {
  it('normalises the endpoint and finds the Cloud tenant', () => {
    expect(normalizeEndpoint('abc123.logto.app/')).toBe('https://abc123.logto.app');
    expect(normalizeEndpoint('https://auth.acme.example/oidc')).toBe('https://auth.acme.example');
    expect(() => normalizeEndpoint('http://auth.acme.example')).toThrow(/https/);
    expect(tenantOfEndpoint('https://abc123.logto.app')).toBe('abc123');
    expect(tenantOfEndpoint('https://auth.acme.example')).toBeNull();
  });
});
