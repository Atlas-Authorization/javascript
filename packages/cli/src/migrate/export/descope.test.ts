import { describe, expect, it } from 'vitest';
import { exportDescope, mapDescopeUser, roleKey } from './descope';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';

/**
 * Descope Management API responses as Descope returns them: `POST
 * /v2/mgmt/user/search` (body `{ limit, page }`, 0-based pages, response
 * `{ users: [...] }`), `GET /v1/mgmt/tenant/all`, `GET /v1/mgmt/role/all`,
 * the per-tenant SSO settings and the access-key search. Users carry
 * `loginIds`, `verifiedEmail` / `verifiedPhone`, `userTenants` with their
 * role names, `createdTime` in seconds and the auth-method booleans
 * (`password`, `TOTP`, `OAuth: { google: true }`, `webauthn`, `SAML`).
 */
const ORIGIN = 'https://api.descope.com';
const PROJECT = 'P2abcDEFghiJKLmno';
const KEY = 'K2mgmtSecretKey';

const JANE = {
  userId: 'U2jane',
  loginIds: ['jane@acme.example'],
  name: 'Jane Doe',
  givenName: 'Jane',
  middleName: 'Q',
  familyName: 'Doe',
  email: 'Jane@Acme.example',
  verifiedEmail: true,
  phone: '+14155550101',
  verifiedPhone: false,
  picture: 'https://img.example/jane.png',
  roleNames: ['Viewer'],
  userTenants: [
    { tenantId: 'T1acme', tenantName: 'Acme Corp', roleNames: ['Tenant Admin', 'Viewer'] },
    { tenantId: 'T9gone', tenantName: 'Deleted tenant', roleNames: [] },
  ],
  status: 'enabled',
  test: false,
  createdTime: 1700000000,
  customAttributes: { plan: 'pro' },
  externalIds: ['ext-1'],
  password: true,
  TOTP: true,
  OAuth: { google: true },
  webauthn: false,
  SAML: false,
};
const SAM = {
  userId: 'U2sam',
  loginIds: ['sammy', '+14155550102'],
  name: 'Sam Ray',
  email: '',
  verifiedEmail: false,
  phone: '+14155550102',
  verifiedPhone: true,
  roleNames: [],
  userTenants: [{ tenantId: 'T2beta', tenantName: 'Beta', roleNames: [] }],
  status: 'enabled',
  test: false,
  createdTime: 1700000100,
  customAttributes: {},
  externalIds: [],
  password: false,
  TOTP: false,
  OAuth: {},
  webauthn: true,
  SAML: false,
};
const DISABLED = {
  userId: 'U2dis',
  loginIds: ['dis@acme.example'],
  email: 'dis@acme.example',
  verifiedEmail: true,
  roleNames: [],
  userTenants: [],
  status: 'disabled',
  test: false,
  createdTime: 1700000200,
  OAuth: { google: false },
};
const TEST_USER = { userId: 'U2test', loginIds: ['test@acme.example'], email: 'test@acme.example', verifiedEmail: true, status: 'enabled', test: true, userTenants: [] };
/** Nothing to sign in with: the only login id is not a usable phone number. */
const NO_LOGIN = { userId: 'U2none', loginIds: ['+12'], email: '', phone: '+12', status: 'invited', test: false, userTenants: [] };

function descopeApi(over: Record<string, unknown> = {}) {
  return fakeVendor(ORIGIN, {
    'GET /v1/mgmt/tenant/all': {
      tenants: [
        { id: 'T1acme', name: 'Acme Corp', selfProvisioningDomains: ['acme.example'], customAttributes: { tier: 'gold' } },
        { id: 'T2beta', name: 'Beta', selfProvisioningDomains: [], customAttributes: {} },
      ],
    },
    'GET /v1/mgmt/role/all': {
      roles: [
        { name: 'Tenant Admin', description: 'Admins', permissionNames: ['User Admin', 'SSO Admin'], tenantId: 'T1acme', createdTime: 1700000000 },
        { name: 'Viewer', description: '', permissionNames: [], createdTime: 1700000000 },
      ],
    },
    'POST /v2/mgmt/user/search': { users: [JANE, SAM, DISABLED, TEST_USER, NO_LOGIN] },
    'GET /v2/mgmt/sso/settings?tenantId=T1acme': {
      tenant: { id: 'T1acme', name: 'Acme Corp', domains: ['acme.example', 'corp.acme.example'] },
      saml: {
        idpEntityId: 'http://www.okta.com/exk1',
        idpSSOUrl: 'https://acme.okta.com/app/sso/saml',
        idpCertificate: 'MIIC...',
        idpMetadataUrl: '',
        spEntityId: 'https://api.descope.com/v1/auth/saml/P2abcDEFghiJKLmno',
        spACSUrl: 'https://api.descope.com/v1/auth/saml/acs',
        attributeMapping: { email: 'mail', givenName: 'first', familyName: '', group: '' },
      },
      oidc: {},
    },
    // T2beta: the v2 settings are not routed (404), the v1 fallback answers.
    'GET /v1/mgmt/sso/settings?tenantId=T2beta': {
      saml: {},
      oidc: { name: 'Beta Okta', clientId: 'beta-client', issuer: 'https://beta.okta.com', scope: ['openid', 'email'] },
    },
    'POST /v1/mgmt/accesskey/search': { keys: [{ id: 'K1', name: 'ci' }, { id: 'K2', name: 'cron' }] },
    ...over,
  });
}

const filler = (i: number) => ({ userId: `U${i}`, loginIds: [`u${i}@x.example`], email: `u${i}@x.example`, verifiedEmail: true, status: 'enabled', test: false, userTenants: [] });

describe('exportDescope', () => {
  it('maps tenants, roles, users, memberships and SSO with the management key, and lists what it leaves out', async () => {
    const api = descopeApi();
    const progress: string[] = [];
    const set = await exportDescope({ projectId: PROJECT, managementKey: KEY, fetchImpl: api.fetchImpl, sleep: noSleep, onProgress: (m) => progress.push(m) });

    expect(api.calls.every((c) => c.headers.get('authorization') === `Bearer ${PROJECT}:${KEY}`)).toBe(true);
    expect(progress).toEqual(['tenants', 'roles', 'users', 'sso', 'access keys']);
    const search = api.calls.filter((c) => c.url === `${ORIGIN}/v2/mgmt/user/search`);
    expect(search).toHaveLength(1);
    expect(search[0]!.method).toBe('POST');
    expect(search[0]!.body).toEqual({ limit: 100, page: 0, withTestUser: false });

    expect(set.list('organization')).toEqual([
      { id: 'T1acme', name: 'Acme Corp', domains: ['acme.example'], public_metadata: { tier: 'gold' } },
      { id: 'T2beta', name: 'Beta' },
    ]);
    expect(set.list('role')).toEqual([
      { key: 'tenant_admin', name: 'Tenant Admin', description: 'Admins', scope: 'app', permissions: ['User Admin', 'SSO Admin'] },
      { key: 'tenant_admin', name: 'Tenant Admin', description: 'Admins', scope: 'organization', organization_id: 'T1acme', permissions: ['User Admin', 'SSO Admin'] },
      { key: 'viewer', name: 'Viewer', scope: 'app' },
      { key: 'viewer', name: 'Viewer', scope: 'organization' },
    ]);

    expect(set.list('user').map((u) => u.id)).toEqual(['U2jane', 'U2sam', 'U2dis']);
    const [jane, sam, disabled] = set.list('user');
    expect(jane).toEqual({
      id: 'U2jane',
      emails: [{ email: 'jane@acme.example', verified: true, primary: true }],
      phones: [{ phone: '+14155550101', verified: false, primary: false }],
      first_name: 'Jane',
      last_name: 'Doe',
      image_url: 'https://img.example/jane.png',
      roles: ['viewer'],
      private_metadata: { plan: 'pro', descope_external_ids: ['ext-1'] },
      created_at: 1700000000000,
    });
    // A login id that is neither the email nor the phone is the username; a phone-only user's phone is primary.
    expect(sam).toEqual({
      id: 'U2sam',
      phones: [{ phone: '+14155550102', verified: true, primary: true }],
      username: 'sammy',
      name: 'Sam Ray',
      created_at: 1700000100000,
    });
    expect(disabled).toMatchObject({ id: 'U2dis', banned: true });
    expect(set.list('user').every((u) => u.password === undefined)).toBe(true);

    // Test users and users with nothing to sign in with are counted, not exported (first reason kept).
    expect(set.omitted.user).toEqual({ count: 2, reason: 'test user' });

    // Tenant memberships with the first role; unknown tenants are skipped.
    expect(set.list('membership')).toEqual([
      { organization_id: 'T1acme', user_id: 'U2jane', role: 'tenant_admin' },
      { organization_id: 'T2beta', user_id: 'U2sam', role: 'member' },
    ]);
    expect(set.warnings).toContain('Some tenant members hold several Descope roles; Atlas seats each member with one role (the first).');

    // Social links, TOTP seeds, passkeys and access-key secrets cannot be exported.
    expect(set.list('identity')).toEqual([]);
    expect(set.omitted.identity?.count).toBe(1);
    expect(set.omitted.identity?.reason).toMatch(/social accounts/);
    expect(set.omitted.mfa_factor).toEqual({ count: 1, reason: 'Descope does not export TOTP seeds; re-enrol in Atlas' });
    expect(set.omitted.passkey).toEqual({ count: 1, reason: 'Descope does not export passkey public keys; register again in Atlas' });
    expect(set.omitted.api_key).toEqual({ count: 2, reason: 'Descope never reveals access-key secrets: reissue them as Atlas API keys' });
    expect(api.calls.find((c) => c.url === `${ORIGIN}/v1/mgmt/accesskey/search`)?.body).toEqual({ tenantIds: [] });

    // Tenant SSO: SAML from the v2 settings, OIDC through the v1 fallback (no client secret).
    expect(set.list('sso_connection')).toEqual([
      {
        id: 'T1acme:saml',
        name: 'T1acme SAML',
        organization_id: 'T1acme',
        protocol: 'saml',
        domains: ['acme.example', 'corp.acme.example'],
        saml: {
          idp_entity_id: 'http://www.okta.com/exk1',
          idp_sso_url: 'https://acme.okta.com/app/sso/saml',
          idp_certificate: 'MIIC...',
          sp_entity_id: 'https://api.descope.com/v1/auth/saml/P2abcDEFghiJKLmno',
          sp_acs_url: 'https://api.descope.com/v1/auth/saml/acs',
          attribute_mapping: { email: 'mail', givenName: 'first' },
        },
      },
      { id: 'T2beta:oidc', name: 'Beta Okta', organization_id: 'T2beta', protocol: 'oidc', oidc: { issuer: 'https://beta.okta.com', client_id: 'beta-client', scopes: ['openid', 'email'] } },
    ]);
    expect(api.calls.some((c) => c.url === `${ORIGIN}/v2/mgmt/sso/settings?tenantId=T2beta`)).toBe(true);
    expect(set.warnings).toContain('Tenant T2beta OIDC SSO: Descope does not return the client secret; enter it in Atlas after the import.');

    expect(set.warnings.some((w) => w.startsWith('No password hashes') && w.includes('descope lazy-migration preset'))).toBe(true);
    expect(set.manifest).toEqual({ origin: PROJECT, settings: { project_id: PROJECT } });
  });

  it('pages the user search until a short page, against a regional base URL', async () => {
    const base = 'https://api.euc1.descope.com';
    const api = fakeVendor(base, {
      'GET /v1/mgmt/tenant/all': { tenants: [] },
      'POST /v2/mgmt/user/search': ({ body }: { body: unknown }) => {
        const page = (body as { page: number }).page;
        return page === 0 ? { users: Array.from({ length: 100 }, (_, i) => filler(i)) } : { users: [filler(100)] };
      },
    });
    const set = await exportDescope({ projectId: PROJECT, managementKey: KEY, baseUrl: `${base}/`, fetchImpl: api.fetchImpl, sleep: noSleep });
    const pages = api.calls.filter((c) => c.url === `${base}/v2/mgmt/user/search`).map((c) => c.body);
    expect(pages).toEqual([
      { limit: 100, page: 0, withTestUser: false },
      { limit: 100, page: 1, withTestUser: false },
    ]);
    expect(set.count('user')).toBe(101);
    expect(set.list('user')[100]!.id).toBe('U100');
    // Roles and access keys are optional endpoints: a 404 leaves them out quietly.
    expect(set.list('role')).toEqual([]);
    expect(set.omitted.api_key).toBeUndefined();
  });

  it('stops paging when the reported total is reached', async () => {
    const api = descopeApi({
      'GET /v1/mgmt/tenant/all': { tenants: [] },
      'POST /v2/mgmt/user/search': { users: Array.from({ length: 100 }, (_, i) => filler(i)), total: 100 },
    });
    const set = await exportDescope({ projectId: PROJECT, managementKey: KEY, fetchImpl: api.fetchImpl, sleep: noSleep });
    expect(api.calls.filter((c) => c.url.endsWith('/v2/mgmt/user/search'))).toHaveLength(1);
    expect(set.count('user')).toBe(100);
  });

  it('attaches hashes from a CSV support export, by user id or login id', async () => {
    const argon = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaGhhc2g';
    const bcrypt = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
    const hashesText = ['user_id,login_id,password_hash,hash_algorithm', `U2jane,jane@acme.example,"${argon}",argon2id`, `,SAMMY,${bcrypt},bcrypt`, 'U2nobody,,,bcrypt'].join('\n');
    const set = await exportDescope({ projectId: PROJECT, managementKey: KEY, hashesText, fetchImpl: descopeApi().fetchImpl, sleep: noSleep });
    const byId = new Map(set.list('user').map((u) => [u.id, u]));
    expect(byId.get('U2jane')!.password).toEqual({ algorithm: 'auto', hash: argon });
    expect(byId.get('U2sam')!.password).toEqual({ algorithm: 'auto', hash: bcrypt });
    expect(byId.get('U2dis')!.password).toBeUndefined();
    expect(set.warnings.some((w) => w.startsWith('No password hashes'))).toBe(false);
    expect(set.warnings.some((w) => w.includes('matched no user'))).toBe(false);
  });

  it('attaches hashes from an NDJSON support export (loginIds as an array)', async () => {
    const hashesText = [
      JSON.stringify({ userId: 'U2dis', hash: '$2a$10$disdisdisdisdisdisdisdOe' }),
      JSON.stringify({ loginIds: ['SAMMY', '+14155550102'], passwordHash: '$2a$10$samsamsamsamsamsamsamsOe', hashAlgorithm: 'bcrypt' }),
    ].join('\n');
    const set = await exportDescope({ projectId: PROJECT, managementKey: KEY, hashesText, fetchImpl: descopeApi().fetchImpl, sleep: noSleep });
    const byId = new Map(set.list('user').map((u) => [u.id, u]));
    expect(byId.get('U2dis')!.password).toEqual({ algorithm: 'auto', hash: '$2a$10$disdisdisdisdisdisdisdOe' });
    expect(byId.get('U2sam')!.password).toEqual({ algorithm: 'auto', hash: '$2a$10$samsamsamsamsamsamsamsOe' });
    expect(byId.get('U2jane')!.password).toBeUndefined();
  });

  it('warns when the hash file matches no user', async () => {
    const set = await exportDescope({
      projectId: PROJECT,
      managementKey: KEY,
      hashesText: 'email,hash\nnobody@elsewhere.example,$2a$10$abc',
      fetchImpl: descopeApi().fetchImpl,
      sleep: noSleep,
    });
    expect(set.warnings).toContain('The hash file matched no user (by user id or login id): check its columns.');
    expect(set.list('user').every((u) => u.password === undefined)).toBe(true);
  });

  it('rejects an invalid project id or a missing management key before calling Descope', async () => {
    const api = descopeApi();
    await expect(exportDescope({ projectId: 'acme-project', managementKey: KEY, fetchImpl: api.fetchImpl })).rejects.toThrow(/Not a Descope project id: acme-project/);
    await expect(exportDescope({ projectId: 'P2short', managementKey: KEY, fetchImpl: api.fetchImpl })).rejects.toThrow(/Not a Descope project id/);
    await expect(exportDescope({ projectId: PROJECT, managementKey: '', fetchImpl: api.fetchImpl })).rejects.toThrow(/management key/);
    expect(api.calls).toHaveLength(0);
  });

  it('fails when the tenant listing is refused (it is not optional)', async () => {
    const api = descopeApi({ 'GET /v1/mgmt/tenant/all': { status: 401, body: { errorCode: 'E011003', errorDescription: 'Request is unauthorized' } } });
    await expect(exportDescope({ projectId: PROJECT, managementKey: KEY, fetchImpl: api.fetchImpl, sleep: noSleep })).rejects.toThrow(/Descope API 401 on \/v1\/mgmt\/tenant\/all: Request is unauthorized/);
  });
});

describe('mapDescopeUser', () => {
  it('skips test users and users without a login, and bans disabled ones', () => {
    expect(mapDescopeUser(TEST_USER)).toBeNull();
    expect(mapDescopeUser(NO_LOGIN)).toBeNull();
    expect(mapDescopeUser({ loginIds: ['x@y.example'], email: 'x@y.example' })).toBeNull();
    expect(mapDescopeUser(DISABLED)).toEqual({
      id: 'U2dis',
      emails: [{ email: 'dis@acme.example', verified: true, primary: true }],
      banned: true,
      created_at: 1700000200000,
    });
  });

  it('keeps the display name only when there is no given / family name', () => {
    expect(mapDescopeUser({ userId: 'U1', loginIds: ['a@b.example'], email: 'a@b.example', name: 'Full Name' })!.name).toBe('Full Name');
    expect(mapDescopeUser({ userId: 'U1', loginIds: ['a@b.example'], email: 'a@b.example', name: 'Full Name', familyName: 'Name' })!.name).toBeUndefined();
  });
});

describe('roleKey', () => {
  it('turns free-text role names into keys', () => {
    expect(roleKey('Tenant Admin')).toBe('tenant_admin');
    expect(roleKey('  Super-User (EU) ')).toBe('super_user_eu');
    expect(roleKey('viewer')).toBe('viewer');
    expect(roleKey('!!!')).toBe('role');
  });
});
