import { describe, expect, it } from 'vitest';
import {
  fetchDescopeConfig,
  fetchKindeConfig,
  translateDescopeConfig,
  translateKindeConfig,
  type DescopeConfigSnapshot,
  type KindeConfigSnapshot,
} from './kinde-descope-config';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';
import { VendorApiError, VendorHttp } from './vendor-http';

// ── Kinde ───────────────────────────────────────────────────────────────────

/**
 * Kinde Management API (`/api/v1`) responses: `{ code, message, <list>,
 * next_token }` envelopes for applications, roles, role permissions,
 * permissions, connections and APIs.
 */
const KINDE_DOMAIN = 'acme.kinde.com';
const KINDE_ORIGIN = `https://${KINDE_DOMAIN}`;
const KINDE_BASE = `${KINDE_ORIGIN}/api/v1`;

const KINDE_APPS = [
  { id: 'a1web', name: 'Acme Web', type: 'reg' },
  { id: 'a3m2m', name: 'Backend', type: 'm2m' },
];
const KINDE_ROLES = [{ id: 'r1admin', key: 'admin', name: 'Admin', description: 'Full access', is_default_role: false }];
const KINDE_ROLE_PERMS = [{ id: 'p1', key: 'read:invoices', name: 'Read invoices', description: 'View invoices' }];
const KINDE_APIS = [
  { id: 'api1', name: 'Kinde Management API', audience: `${KINDE_ORIGIN}/api`, is_management_api: true },
  { id: 'api2', name: 'Acme API', audience: 'https://api.acme.example', is_management_api: false },
];

const KINDE: KindeConfigSnapshot = {
  domain: KINDE_DOMAIN,
  applications: [
    { id: 'a1web', name: 'Acme Web', type: 'reg', redirects: ['https://app.acme.example/api/auth/kinde_callback', 'http://localhost:3000/api/auth/kinde_callback'] },
    { id: 'a2spa', name: 'Acme SPA', type: 'spa', redirects: ['https://app.acme.example/api/auth/kinde_callback'] },
    { id: 'a3m2m', name: 'Backend', type: 'm2m', redirects: [] },
  ],
  connections: [
    { id: 'conn_pw', name: 'email-password', display_name: 'Email + password', strategy: 'email:password' },
    { id: 'conn_un', name: 'username-password', display_name: 'Username + password', strategy: 'username:password' },
    { id: 'conn_otp', name: 'email-otp', display_name: 'Email code', strategy: 'email:otp' },
    { id: 'conn_sms', name: 'phone-otp', display_name: 'SMS', strategy: 'phone:otp' },
    { id: 'conn_g', name: 'google', display_name: 'Google', strategy: 'oauth2:google' },
    { id: 'conn_gh', name: 'github', display_name: 'GitHub', strategy: 'oauth2:github' },
    { id: 'conn_xero', name: 'xero', display_name: 'Xero', strategy: 'oauth2:xero' },
    { id: 'conn_saml', name: 'okta-saml', display_name: 'Corp SAML', strategy: 'saml:custom' },
    { id: 'conn_ws', name: 'adfs', display_name: 'ADFS', strategy: 'wsfed' },
    { id: 'conn_ldap', name: 'weird', strategy: 'ldap:custom' },
  ],
  roles: [
    { id: 'r1admin', key: 'admin', name: 'Admin', description: 'Full access', permissions: [{ id: 'p1', key: 'read:invoices' }, { id: 'p2', key: 'write:invoices' }] },
    { id: 'r2viewer', key: 'billing-viewer', name: 'Billing viewer', description: null, permissions: [{ id: 'p1', key: 'read:invoices' }] },
  ],
  permissions: [
    { id: 'p1', key: 'read:invoices', name: 'Read invoices', description: 'View invoices' },
    { id: 'p2', key: 'write:invoices', name: 'Write invoices', description: null },
  ],
  apis: KINDE_APIS,
};

const kindeHttp = (fetchImpl: typeof fetch) => new VendorHttp({ vendor: 'Kinde', baseUrl: KINDE_BASE, headers: { authorization: 'Bearer kinde_token' }, fetchImpl, sleep: noSleep });

describe('fetchKindeConfig', () => {
  it('reads applications with their callback URLs, roles with permissions and APIs, tolerating 400/403/404', async () => {
    const api = fakeVendor(KINDE_ORIGIN, {
      'GET /api/v1/applications?page_size=500': { code: 'OK', message: 'Success', applications: KINDE_APPS, next_token: null },
      'GET /api/v1/applications/a1web/auth_redirect_urls': {
        redirect_urls: ['https://app.acme.example/api/auth/kinde_callback', { url: 'http://localhost:3000/api/auth/kinde_callback' }, { redirect_url: '' }],
      },
      // a3m2m's callback URLs are unrouted → 404
      'GET /api/v1/roles?page_size=500': { code: 'OK', message: 'Success', roles: KINDE_ROLES, next_token: null },
      'GET /api/v1/roles/r1admin/permissions?page_size=500': { code: 'OK', message: 'Success', permissions: KINDE_ROLE_PERMS, next_token: null },
      'GET /api/v1/connections?page_size=500': { status: 403, body: { errors: [{ code: 'FORBIDDEN', message: 'Missing required scope: read:connections' }] } },
      'GET /api/v1/permissions?page_size=500': { status: 400, body: { errors: [{ code: 'INVALID_REQUEST', message: 'Invalid page_size' }] } },
      'GET /api/v1/apis': { code: 'OK', message: 'Success', apis: KINDE_APIS, next_token: null },
    });
    const snap = await fetchKindeConfig(kindeHttp(api.fetchImpl), KINDE_DOMAIN);
    expect(snap).toEqual({
      domain: KINDE_DOMAIN,
      applications: [
        { ...KINDE_APPS[0]!, redirects: ['https://app.acme.example/api/auth/kinde_callback', 'http://localhost:3000/api/auth/kinde_callback'] },
        { ...KINDE_APPS[1]!, redirects: [] },
      ],
      connections: [],
      roles: [{ ...KINDE_ROLES[0]!, permissions: KINDE_ROLE_PERMS }],
      permissions: [],
      apis: KINDE_APIS,
    });
    expect(api.calls.map((c) => c.url)).toEqual([
      `${KINDE_BASE}/applications?page_size=500`,
      `${KINDE_BASE}/applications/a1web/auth_redirect_urls`,
      `${KINDE_BASE}/applications/a3m2m/auth_redirect_urls`,
      `${KINDE_BASE}/roles?page_size=500`,
      `${KINDE_BASE}/roles/r1admin/permissions?page_size=500`,
      `${KINDE_BASE}/connections?page_size=500`,
      `${KINDE_BASE}/permissions?page_size=500`,
      `${KINDE_BASE}/apis`,
    ]);
    expect(api.calls.every((c) => c.headers.get('authorization') === 'Bearer kinde_token')).toBe(true);
  });

  it('rethrows other errors (an invalid token)', async () => {
    const api = fakeVendor(KINDE_ORIGIN, {
      'GET /api/v1/applications?page_size=500': { status: 401, body: { errors: [{ code: 'TOKEN_INVALID', message: 'Invalid or expired token' }] } },
    });
    const err = await fetchKindeConfig(kindeHttp(api.fetchImpl), KINDE_DOMAIN).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VendorApiError);
    expect((err as VendorApiError).status).toBe(401);
    expect((err as VendorApiError).message).toBe('Kinde API 401 on /applications: Invalid or expired token');
  });
});

describe('translateKindeConfig', () => {
  it('maps connections to strategies, social providers and SSO connections', () => {
    const r = translateKindeConfig(KINDE);
    expect(r.origin).toBe(`Kinde business ${KINDE_DOMAIN}`);
    expect(r.documents.instance).toEqual({ auth_config: { strategies: { password: true, username: true, emailCode: true, phoneCode: true } } });
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'mapped', area: 'authentication', setting: 'connection Email + password', atlas: 'auth_config.strategies.password' }));
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'mapped', area: 'authentication', setting: 'connection Username + password', atlas: 'auth_config.strategies.password' }));
    expect(r.report).toContainEqual({ status: 'mapped', area: 'authentication', setting: 'connection Email code', note: 'Passwordless email code.', atlas: 'auth_config.strategies.emailCode' });
    expect(r.report).toContainEqual({ status: 'mapped', area: 'authentication', setting: 'connection SMS', note: 'SMS code.', atlas: 'auth_config.strategies.phoneCode' });
    expect(r.documents.oauth_providers).toEqual([
      { provider: 'google', enabled: true, allow_sign_in: true, allow_sign_up: true, client_id: '${GOOGLE_CLIENT_ID}', client_secret: '${GOOGLE_CLIENT_SECRET}' },
      { provider: 'github', enabled: true, allow_sign_in: true, allow_sign_up: true, client_id: '${GITHUB_CLIENT_ID}', client_secret: '${GITHUB_CLIENT_SECRET}' },
    ]);
    expect(r.env).toEqual([
      { name: 'GOOGLE_CLIENT_ID', for: 'Google client id' },
      { name: 'GOOGLE_CLIENT_SECRET', for: 'Google client secret' },
      { name: 'GITHUB_CLIENT_ID', for: 'GitHub client id' },
      { name: 'GITHUB_CLIENT_SECRET', for: 'GitHub client secret' },
    ]);
    expect(r.mappings.providers).toEqual({ Google: 'google', GitHub: 'github' });
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'manual', area: 'authentication', setting: 'connection Google (oauth2:google)', atlas: 'oauth_providers google' }));
    expect(r.report).toContainEqual({
      status: 'manual',
      area: 'authentication',
      setting: 'connection Xero (oauth2:xero)',
      note: 'No built-in Atlas provider: add it as a custom OAuth provider.',
      atlas: 'custom_oauth_providers',
    });
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'mapped', area: 'enterprise', setting: 'connection Corp SAML (saml:custom)', atlas: 'sso_connections' }));
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'mapped', area: 'enterprise', setting: 'connection ADFS (wsfed)', atlas: 'sso_connections' }));
    expect(r.report).toContainEqual({ status: 'manual', area: 'authentication', setting: 'connection weird (ldap:custom)', note: 'Review this connection by hand.' });
    expect(r.bridge).toEqual({ preset: 'kinde', vars: { domain: KINDE_DOMAIN } });
    expect(r.lazy).toBeUndefined();
  });

  it('maps callback URLs, M2M apps, permissions, organization roles and APIs', () => {
    const r = translateKindeConfig(KINDE);
    expect(r.documents.redirect_urls).toEqual([{ url: 'https://app.acme.example/api/auth/kinde_callback' }, { url: 'http://localhost:3000/api/auth/kinde_callback' }]);
    expect(r.report).toContainEqual({ status: 'mapped', area: 'applications', setting: 'allowed callback URLs', note: '2 callback URL(s).', atlas: 'redirect_urls' });
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'manual', area: 'applications Backend', setting: 'type m2m', atlas: 'oauth_clients' }));
    expect(r.documents.permissions).toEqual([
      { key: 'read:invoices', name: 'Read invoices', description: 'View invoices' },
      { key: 'write:invoices', name: 'Write invoices', description: '' },
    ]);
    expect(r.documents.roles).toEqual([
      { key: 'org:admin', name: 'Admin', description: 'Full access', permissions: ['read:invoices', 'write:invoices'] },
      { key: 'org:billing_viewer', name: 'Billing viewer', description: '', permissions: ['read:invoices'] },
    ]);
    expect(r.mappings.roles).toEqual({ admin: 'org:admin', 'billing-viewer': 'org:billing_viewer' });
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'mapped', area: 'roles', setting: 'roles', note: '2 organization role(s) with permissions (Kinde roles apply inside organizations).' }));
    expect(r.documents.resource_servers).toEqual([{ identifier: 'https://api.acme.example', name: 'Acme API', scopes: [] }]);
    expect(r.report).toContainEqual({ status: 'mapped', area: 'APIs', setting: 'apis Acme API', note: 'Access tokens keep "aud": "https://api.acme.example".', atlas: 'resource_servers https://api.acme.example' });
    expect(r.report.find((e) => e.setting === 'apis Kinde Management API')).toBeUndefined();
  });

  it('treats Azure AD / Entra ID connections as enterprise SSO, not the Microsoft social provider; no double org: prefix', () => {
    const r = translateKindeConfig({
      domain: KINDE_DOMAIN,
      applications: [],
      connections: [
        { id: 'conn_az', name: 'Contoso Entra', display_name: 'Contoso Entra', strategy: 'oauth2:azure_ad' },
        { id: 'conn_me', name: 'Fabrikam', display_name: 'Fabrikam', strategy: 'oauth2:microsoft_entra' },
      ],
      roles: [{ id: 'r1', key: 'org:owner', name: 'Owner' }],
      permissions: [],
      apis: [],
    });
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'mapped', area: 'enterprise', setting: 'connection Contoso Entra (oauth2:azure_ad)', atlas: 'sso_connections' }));
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'mapped', area: 'enterprise', setting: 'connection Fabrikam (oauth2:microsoft_entra)', atlas: 'sso_connections' }));
    expect(r.documents.oauth_providers).toBeUndefined();
    expect(r.mappings.roles).toEqual({ 'org:owner': 'org:owner' });
  });

  it('lists the settings Kinde does not expose as manual, even for an empty business', () => {
    const r = translateKindeConfig({ domain: KINDE_DOMAIN, applications: [], connections: [], roles: [], permissions: [], apis: [] });
    expect(r.documents).toEqual({});
    expect(r.report.map((e) => [e.status, e.area, e.setting])).toEqual([
      ['manual', 'settings not in the API', 'multi-factor authentication'],
      ['manual', 'settings not in the API', 'password rules and breached-password checks'],
      ['manual', 'settings not in the API', 'session and token lifetimes'],
      ['manual', 'settings not in the API', 'feature flags'],
    ]);
    expect(r.report[0]!.note).toBe('Kinde does not expose this by API; copy it from Kinde (Settings → Environment → Multi-factor auth).');
    expect(r.env).toEqual([]);
    expect(r.mappings).toEqual({ providers: {}, roles: {} });
  });
});

// ── Descope ─────────────────────────────────────────────────────────────────

/**
 * Descope management API responses: `GET /v1/mgmt/password/settings` (the
 * project's password policy), `GET /v1/mgmt/role/all` (`{ roles }`, project
 * roles with an empty `tenantId`) and `GET /v1/mgmt/permission/all`.
 */
const PROJECT = 'P2abcDEF123';
const DESCOPE_ORIGIN = 'https://api.descope.com';

const PASSWORD_SETTINGS = {
  enabled: true,
  minLength: 6,
  lowercase: true,
  uppercase: false,
  number: true,
  nonAlphanumeric: false,
  expiration: true,
  expirationWeeks: 26,
  reuse: true,
  reuseAmount: 3,
  lock: true,
  lockAttempts: 5,
  tempLock: false,
  tempLockAttempts: 0,
  tempLockDuration: 0,
  emailServiceProvider: '',
  emailSubject: '',
  emailBody: '',
  emailBodyPlainText: '',
  useEmailBodyPlainText: false,
};
const DESCOPE_PERMISSIONS = [
  { name: 'User Admin', description: 'Manage users', systemDefault: true },
  { name: 'Read Invoices', description: 'View invoices', systemDefault: false },
];
const DESCOPE_ROLES = [
  { name: 'Tenant Admin', description: 'Admin of a tenant', permissionNames: ['User Admin', 'Read Invoices'], createdTime: 1700000000, tenantId: '', default: false, private: false },
  { name: 'Billing Viewer', description: '', permissionNames: ['Read Invoices'], createdTime: 1700000000, tenantId: '', default: true, private: false },
  { name: 'tenant admin', description: 'duplicate by key', permissionNames: [], createdTime: 1700000000, tenantId: '', default: false, private: false },
  { name: 'Acme Auditor', description: 'Acme only', permissionNames: [], createdTime: 1700000000, tenantId: 'T2acme', default: false, private: false },
];

const DESCOPE: DescopeConfigSnapshot = { projectId: PROJECT, passwordSettings: PASSWORD_SETTINGS, roles: DESCOPE_ROLES, permissions: DESCOPE_PERMISSIONS };

const descopeHttp = (fetchImpl: typeof fetch) =>
  new VendorHttp({ vendor: 'Descope', baseUrl: DESCOPE_ORIGIN, headers: { authorization: `Bearer ${PROJECT}:K2mgmtKey` }, fetchImpl, sleep: noSleep });

describe('fetchDescopeConfig', () => {
  it('reads password settings, roles and permissions with the project:key Bearer token', async () => {
    const api = fakeVendor(DESCOPE_ORIGIN, {
      'GET /v1/mgmt/password/settings': PASSWORD_SETTINGS,
      'GET /v1/mgmt/role/all': { roles: DESCOPE_ROLES },
      'GET /v1/mgmt/permission/all': { permissions: DESCOPE_PERMISSIONS },
    });
    const snap = await fetchDescopeConfig(descopeHttp(api.fetchImpl), PROJECT);
    expect(snap).toEqual(DESCOPE);
    expect(api.calls.map((c) => c.url)).toEqual([`${DESCOPE_ORIGIN}/v1/mgmt/password/settings`, `${DESCOPE_ORIGIN}/v1/mgmt/role/all`, `${DESCOPE_ORIGIN}/v1/mgmt/permission/all`]);
    expect(api.calls.every((c) => c.headers.get('authorization') === `Bearer ${PROJECT}:K2mgmtKey`)).toBe(true);
  });

  it('falls back on 403/404 endpoints and rethrows anything else', async () => {
    const partial = fakeVendor(DESCOPE_ORIGIN, {
      'GET /v1/mgmt/password/settings': { status: 403, body: { errorCode: 'E011003', errorDescription: 'Request not authorized', errorMessage: 'Management key lacks the password scope' } },
      'GET /v1/mgmt/role/all': { roles: DESCOPE_ROLES.slice(0, 1) },
      // permission/all unrouted → 404
    });
    expect(await fetchDescopeConfig(descopeHttp(partial.fetchImpl), PROJECT)).toEqual({ projectId: PROJECT, passwordSettings: null, roles: DESCOPE_ROLES.slice(0, 1), permissions: [] });

    const revoked = fakeVendor(DESCOPE_ORIGIN, {
      'GET /v1/mgmt/password/settings': { status: 401, body: { errorCode: 'E011003', errorDescription: 'Request not authorized' } },
    });
    const err = await fetchDescopeConfig(descopeHttp(revoked.fetchImpl), PROJECT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VendorApiError);
    expect((err as VendorApiError).status).toBe(401);
    expect((err as VendorApiError).message).toBe('Descope API 401 on /v1/mgmt/password/settings: Request not authorized');
  });
});

describe('translateDescopeConfig', () => {
  it('maps the password policy and the bridge / lazy presets', () => {
    const r = translateDescopeConfig(DESCOPE);
    expect(r.origin).toBe(`Descope project ${PROJECT}`);
    expect(r.documents.instance).toEqual({ auth_config: { strategies: { password: true }, passwordPolicy: { minLength: 8 } } });
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'mapped', area: 'password', setting: 'enabled', note: expect.stringContaining('Password sign-in. Descope keeps hashes'), atlas: 'auth_config.strategies.password' }));
    expect(r.report).toContainEqual({ status: 'differs', area: 'password', setting: 'minLength', note: '6 (Atlas requires at least 8).', atlas: 'auth_config.passwordPolicy.minLength' });
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'differs', area: 'password', setting: 'character classes', atlas: 'auth_config.passwordPolicy' }));
    expect(r.report).toContainEqual({ status: 'manual', area: 'password', setting: 'expiration', note: 'Atlas does not expire passwords.' });
    expect(r.report).toContainEqual({ status: 'manual', area: 'password', setting: 'reuse', note: 'Atlas does not keep a password history.' });
    expect(r.report).toContainEqual({
      status: 'mapped',
      area: 'password',
      setting: 'lock',
      note: 'Descope locks after 5 attempts; Atlas throttles failed sign-ins per account and IP.',
      atlas: 'auth_config.rateLimit',
    });
    expect(r.bridge).toEqual({ preset: 'descope', vars: { project_id: PROJECT } });
    expect(r.lazy).toEqual({ preset: 'descope', config: { project_id: PROJECT } });
    expect(r.env).toEqual([]);
  });

  it('maps permissions and project roles by key, skipping duplicates and counting tenant roles', () => {
    const r = translateDescopeConfig(DESCOPE);
    expect(r.documents.permissions).toEqual([
      { key: 'user_admin', name: 'User Admin', description: 'Manage users' },
      { key: 'read_invoices', name: 'Read Invoices', description: 'View invoices' },
    ]);
    expect(r.documents.roles).toEqual([
      { key: 'tenant_admin', name: 'Tenant Admin', description: 'Admin of a tenant', permissions: ['user_admin', 'read_invoices'] },
      { key: 'billing_viewer', name: 'Billing Viewer', description: '', permissions: ['read_invoices'] },
    ]);
    expect(r.mappings.roles).toEqual({ 'Tenant Admin': 'tenant_admin', 'Billing Viewer': 'billing_viewer' });
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'mapped', area: 'authorization', setting: 'roles', note: '2 role(s) (project roles become app roles; the same keys seat tenant members).', atlas: 'roles' }));
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'differs', area: 'authorization', setting: 'tenant-scoped roles', note: expect.stringContaining('1 role(s) defined inside one tenant'), atlas: 'roles' }));
  });

  it('without password settings or roles, only reports flows and authentication methods as manual', () => {
    const r = translateDescopeConfig({ projectId: PROJECT, passwordSettings: null, roles: [], permissions: [] });
    expect(r.documents).toEqual({});
    expect(r.report).toEqual([
      expect.objectContaining({ status: 'manual', area: 'flows', setting: 'flows and screens', atlas: 'actions' }),
      expect.objectContaining({ status: 'manual', area: 'authentication methods', setting: 'magic link / OTP / social / passkeys', atlas: 'auth_config.strategies' }),
    ]);
    expect(r.mappings).toEqual({ providers: {}, roles: {} });
    expect(r.lazy).toEqual({ preset: 'descope', config: { project_id: PROJECT } });
  });

  it('reports disabled passwords and a long-enough minimum', () => {
    const r = translateDescopeConfig({ projectId: PROJECT, passwordSettings: { enabled: false, minLength: 10, lock: false }, roles: [], permissions: [] });
    expect(r.documents.instance).toEqual({ auth_config: { strategies: { password: false }, passwordPolicy: { minLength: 10 } } });
    expect(r.report).toContainEqual(expect.objectContaining({ setting: 'enabled', note: 'Password sign-in off.' }));
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'mapped', setting: 'minLength', note: '10.' }));
    expect(r.report.find((e) => e.setting === 'character classes')).toBeUndefined();
    expect(r.report.find((e) => e.setting === 'lock')).toBeUndefined();
  });
});
