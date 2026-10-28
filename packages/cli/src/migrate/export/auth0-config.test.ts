import { describe, expect, it } from 'vitest';
import { fetchAuth0Config, translateAuth0Config, type Auth0ConfigSnapshot } from './auth0-config';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';
import { VendorApiError, VendorHttp } from './vendor-http';

/**
 * Auth0 Management API v2 responses as Auth0 returns them: bare arrays for
 * lists requested without `include_totals` (and `{ roles, start, limit, total }`
 * when a proxy / SDK asked for totals), `GET /tenants/settings`, guardian
 * factors / policies, attack protection, clients, resource servers, roles.
 */
const DOMAIN = 'acme.us.auth0.com';
const ORIGIN = `https://${DOMAIN}`;
const BASE = `${ORIGIN}/api/v2`;

const TENANT = {
  friendly_name: 'Acme',
  picture_url: 'https://acme.example/logo.png',
  support_email: 'support@acme.example',
  session_lifetime: 168,
  idle_session_lifetime: 72,
  sandbox_version: '18',
  default_audience: '',
  flags: { enable_client_connections: false, revoke_refresh_token_grant: false, disable_clickjack_protection_headers: false },
  enabled_locales: ['en'],
};

const CONNECTIONS = [
  {
    id: 'con_db1',
    name: 'Username-Password-Authentication',
    strategy: 'auth0',
    enabled_clients: ['cli_web', 'cli_ios'],
    is_domain_connection: false,
    realms: ['Username-Password-Authentication'],
    options: {
      mfa: { active: true, return_enroll_settings: true },
      passwordPolicy: 'good',
      password_complexity_options: { min_length: 6 },
      password_history: { size: 5, enable: true },
      password_no_personal_info: { enable: false },
      password_dictionary: { enable: true, dictionary: [] },
      requires_username: true,
      validation: { username: { min: 3, max: 20 } },
      brute_force_protection: true,
      disable_signup: true,
      authentication_methods: { password: { enabled: true }, passkey: { enabled: true } },
      enabledDatabaseCustomization: false,
      import_mode: false,
    },
  },
  {
    id: 'con_db2',
    name: 'legacy-db',
    strategy: 'auth0',
    enabled_clients: [],
    realms: ['legacy-db'],
    options: {
      passwordPolicy: 'low',
      enabledDatabaseCustomization: true,
      customScripts: { login: 'function login(email, password, callback) { /* … */ }', get_user: 'function getByEmail(email, callback) { /* … */ }' },
      brute_force_protection: true,
    },
  },
  {
    id: 'con_email',
    name: 'email',
    strategy: 'email',
    enabled_clients: ['cli_web'],
    realms: ['email'],
    options: {
      name: 'email',
      email: { from: '{{ application.name }} <root@auth0.com>', syntax: 'liquid', subject: 'Welcome to {{ application.name }}', body: '<html><body><a href="@@link@@">Sign in</a></body></html>' },
      totp: { length: 6, time_step: 180 },
      disable_signup: false,
      brute_force_protection: true,
    },
  },
  { id: 'con_sms', name: 'sms', strategy: 'sms', enabled_clients: [], realms: ['sms'], options: { name: 'sms', from: '+15550100', syntax: 'md_with_macros', totp: { length: 6, time_step: 300 }, provider: 'twilio' } },
  {
    id: 'con_g',
    name: 'google-oauth2',
    strategy: 'google-oauth2',
    enabled_clients: ['cli_web'],
    realms: ['google-oauth2'],
    options: { email: true, profile: true, scope: ['email', 'profile'], client_id: 'goog-123.apps.googleusercontent.com', client_secret: 'GOCSPX-never-copied' },
  },
  { id: 'con_gh', name: 'github', strategy: 'github', enabled_clients: ['cli_web'], realms: ['github'], options: { profile: true, follow: false } },
  { id: 'con_saml', name: 'acme-okta-saml', strategy: 'samlp', enabled_clients: ['cli_web'], realms: ['acme-okta-saml'], options: { signInEndpoint: 'https://acme.okta.com/app/abc/sso/saml', domain_aliases: ['corp.acme.example'] } },
  { id: 'con_ad', name: 'corp-ad', strategy: 'ad', enabled_clients: [], realms: ['corp-ad'], options: { ips: ['10.0.0.1'] } },
  {
    id: 'con_xero',
    name: 'custom-xero',
    strategy: 'oauth2',
    enabled_clients: ['cli_web'],
    realms: ['custom-xero'],
    options: {
      authorizationURL: 'https://login.xero.com/identity/connect/authorize',
      tokenURL: 'https://identity.xero.com/connect/token',
      scope: 'openid profile email',
      client_id: 'xero-client',
      scripts: { fetchUserProfile: 'function(accessToken, ctx, cb) { /* … */ }' },
    },
  },
  { id: 'con_ev', name: 'evernote', strategy: 'evernote', enabled_clients: [], realms: ['evernote'], options: { client_id: 'ev-key' } },
];

const FACTORS = [
  { name: 'sms', enabled: false, trial_expired: false },
  { name: 'push-notification', enabled: true, trial_expired: false },
  { name: 'otp', enabled: true, trial_expired: false },
  { name: 'email', enabled: false, trial_expired: false },
  { name: 'duo', enabled: false, trial_expired: false },
  { name: 'webauthn-roaming', enabled: true, trial_expired: false },
  { name: 'webauthn-platform', enabled: false, trial_expired: false },
  { name: 'recovery-code', enabled: true, trial_expired: false },
];

const BREACHED = { enabled: true, shields: ['block', 'admin_notification'], admin_notification_frequency: ['immediately'], method: 'standard', stage: { 'pre-user-registration': { shields: ['block'] } } };

const CLIENTS = [
  {
    tenant: 'acme',
    global: false,
    is_first_party: true,
    name: 'Acme Web',
    client_id: 'cli_web',
    app_type: 'spa',
    callbacks: ['https://app.acme.example/callback', 'https://*.preview.acme.example/callback'],
    web_origins: ['https://app.acme.example'],
    allowed_origins: ['https://app.acme.example', 'https://*.acme.example'],
    allowed_logout_urls: ['https://app.acme.example'],
    grant_types: ['authorization_code', 'implicit', 'refresh_token'],
    token_endpoint_auth_method: 'none',
  },
  { tenant: 'acme', global: false, is_first_party: true, name: 'Acme iOS', client_id: 'cli_ios', app_type: 'native', callbacks: ['com.acme.app://acme.us.auth0.com/ios/com.acme.app/callback'] },
  { tenant: 'acme', global: false, is_first_party: true, name: 'Billing worker', client_id: 'cli_m2m', app_type: 'non_interactive', callbacks: ['https://should-not-appear.example/cb'], grant_types: ['client_credentials'] },
  { tenant: 'acme', global: false, is_first_party: false, name: 'Partner Portal', client_id: 'cli_partner', app_type: 'regular_web', callbacks: ['https://partner.example/cb'] },
];

const RESOURCE_SERVERS = [
  { id: 'rs_sys', name: 'Auth0 Management API', identifier: `${BASE}/`, is_system: true, allow_offline_access: false, signing_alg: 'RS256', token_lifetime: 86400, scopes: [{ value: 'read:users', description: 'Read Users' }] },
  {
    id: 'rs_acme',
    name: 'Acme API',
    identifier: 'https://api.acme.example',
    allow_offline_access: true,
    skip_consent_for_verifiable_first_party_clients: true,
    signing_alg: 'RS256',
    token_lifetime: 86400,
    scopes: [
      { value: 'read:invoices', description: 'Read invoices' },
      { value: 'write:invoices', description: 'Create invoices' },
    ],
  },
];

const ROLES = [
  { id: 'rol_2bD9xYz', name: 'Billing Admin', description: 'Manages billing' },
  { id: 'rol_3cE0aBc', name: 'Viewer', description: 'Read-only' },
];
const PERMS_ADMIN = [
  { permission_name: 'read:invoices', description: 'Read invoices', resource_server_name: 'Acme API', resource_server_identifier: 'https://api.acme.example' },
  { permission_name: 'write:invoices', description: 'Create invoices', resource_server_name: 'Acme API', resource_server_identifier: 'https://api.acme.example' },
];
const PERMS_VIEWER = [{ permission_name: 'read:invoices', description: 'Read invoices', resource_server_name: 'Acme API', resource_server_identifier: 'https://api.acme.example' }];

const ACTIONS = [
  { id: 'act_1', name: 'Add roles to token', supported_triggers: [{ id: 'post-login', version: 'v3' }], status: 'built', runtime: 'node18', code: 'exports.onExecutePostLogin = async () => {};' },
];
const RULES = [
  { id: 'rul_1', name: 'Enrich profile', enabled: true, order: 1, stage: 'login_success', script: 'function (user, context, callback) { callback(null, user, context); }' },
  { id: 'rul_2', name: 'Old rule', enabled: false, order: 2, stage: 'login_success', script: 'function (user, context, callback) {}' },
];

const FULL: Auth0ConfigSnapshot = {
  domain: DOMAIN,
  tenant: TENANT,
  connections: CONNECTIONS,
  guardianFactors: FACTORS,
  guardianPolicies: ['all-applications'],
  breachedPassword: BREACHED,
  clients: CLIENTS,
  resourceServers: RESOURCE_SERVERS,
  roles: [
    { ...ROLES[0]!, permissions: PERMS_ADMIN },
    { ...ROLES[1]!, permissions: PERMS_VIEWER },
  ],
  actions: ACTIONS,
  rules: RULES,
};

const EMPTY: Auth0ConfigSnapshot = { domain: DOMAIN, tenant: {}, connections: [], guardianFactors: [], guardianPolicies: [], breachedPassword: null, clients: [], resourceServers: [], roles: [], actions: [], rules: [] };

const http = (fetchImpl: typeof fetch) => new VendorHttp({ vendor: 'Auth0', baseUrl: BASE, headers: { authorization: 'Bearer mgmt_token' }, fetchImpl, sleep: noSleep });

describe('fetchAuth0Config', () => {
  it('reads every Management API endpoint with the Bearer token, tolerating 403/404', async () => {
    const api = fakeVendor(ORIGIN, {
      'GET /api/v2/roles?per_page=100': ROLES,
      [`GET /api/v2/roles/${ROLES[0]!.id}/permissions?per_page=100`]: PERMS_ADMIN,
      [`GET /api/v2/roles/${ROLES[1]!.id}/permissions?per_page=100`]: PERMS_VIEWER,
      'GET /api/v2/tenants/settings': TENANT,
      'GET /api/v2/connections?per_page=100': CONNECTIONS,
      'GET /api/v2/guardian/factors': FACTORS,
      'GET /api/v2/guardian/policies': ['all-applications'],
      'GET /api/v2/attack-protection/breached-password-detection': {
        status: 403,
        body: { statusCode: 403, error: 'Forbidden', message: 'Insufficient scope, expected any of: read:attack_protection', errorCode: 'insufficient_scope' },
      },
      'GET /api/v2/clients?per_page=100&is_global=false': CLIENTS,
      'GET /api/v2/resource-servers?per_page=100': RESOURCE_SERVERS,
      'GET /api/v2/actions/actions?per_page=100': { status: 403, body: { statusCode: 403, error: 'Forbidden', message: 'Insufficient scope, expected any of: read:actions', errorCode: 'insufficient_scope' } },
      // rules is unrouted → 404 (tenants created after Rules were retired)
    });
    const snap = await fetchAuth0Config(http(api.fetchImpl), DOMAIN);
    expect(snap).toEqual({
      domain: DOMAIN,
      tenant: TENANT,
      connections: CONNECTIONS,
      guardianFactors: FACTORS,
      guardianPolicies: ['all-applications'],
      breachedPassword: null,
      clients: CLIENTS,
      resourceServers: RESOURCE_SERVERS,
      roles: [
        { ...ROLES[0]!, permissions: PERMS_ADMIN },
        { ...ROLES[1]!, permissions: PERMS_VIEWER },
      ],
      actions: [],
      rules: [],
    });
    expect(api.calls.map((c) => c.url)).toEqual([
      `${BASE}/roles?per_page=100`,
      `${BASE}/roles/rol_2bD9xYz/permissions?per_page=100`,
      `${BASE}/roles/rol_3cE0aBc/permissions?per_page=100`,
      `${BASE}/tenants/settings`,
      `${BASE}/connections?per_page=100`,
      `${BASE}/guardian/factors`,
      `${BASE}/guardian/policies`,
      `${BASE}/attack-protection/breached-password-detection`,
      `${BASE}/clients?per_page=100&is_global=false`,
      `${BASE}/resource-servers?per_page=100`,
      `${BASE}/actions/actions?per_page=100`,
      `${BASE}/rules?per_page=100`,
    ]);
    for (const c of api.calls) {
      expect(c.method).toBe('GET');
      expect(c.headers.get('authorization')).toBe('Bearer mgmt_token');
    }
  });

  it('unwraps include_totals envelopes and falls back on every missing endpoint', async () => {
    const api = fakeVendor(ORIGIN, {
      'GET /api/v2/roles?per_page=100': { roles: [ROLES[0]], start: 0, limit: 100, total: 1 },
      [`GET /api/v2/roles/${ROLES[0]!.id}/permissions?per_page=100`]: { permissions: PERMS_ADMIN, start: 0, limit: 100, total: 2 },
      'GET /api/v2/connections?per_page=100': { connections: CONNECTIONS.slice(0, 1), start: 0, limit: 100, total: 1 },
      'GET /api/v2/guardian/factors': { status: 404, body: { statusCode: 404, error: 'Not Found', message: 'Not Found' } },
      'GET /api/v2/clients?per_page=100&is_global=false': { clients: CLIENTS.slice(0, 1), start: 0, limit: 100, total: 1 },
    });
    const snap = await fetchAuth0Config(http(api.fetchImpl), DOMAIN);
    expect(snap.roles).toEqual([{ ...ROLES[0]!, permissions: PERMS_ADMIN }]);
    expect(snap.connections).toEqual(CONNECTIONS.slice(0, 1));
    expect(snap.clients).toEqual(CLIENTS.slice(0, 1));
    expect(snap.tenant).toEqual({});
    expect(snap.guardianFactors).toEqual([]);
    expect(snap.guardianPolicies).toEqual([]);
    expect(snap.breachedPassword).toBeNull();
    expect(snap.resourceServers).toEqual([]);
  });

  it('rethrows other Management API errors (an expired token)', async () => {
    const api = fakeVendor(ORIGIN, {
      'GET /api/v2/tenants/settings': { status: 401, body: { statusCode: 401, error: 'Unauthorized', message: 'Expired token received for JSON Web Token validation', attributes: { error: 'Expired token' } } },
    });
    const err = await fetchAuth0Config(http(api.fetchImpl), DOMAIN).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VendorApiError);
    expect((err as VendorApiError).status).toBe(401);
    expect((err as VendorApiError).message).toBe('Auth0 API 401 on /tenants/settings: Expired token received for JSON Web Token validation');
  });
});

describe('translateAuth0Config', () => {
  it('builds auth_config, allowed origins and the bridge / lazy presets', () => {
    const r = translateAuth0Config(FULL);
    expect(r.origin).toBe(`Auth0 tenant ${DOMAIN}`);
    expect(r.documents.instance).toEqual({
      allowed_origins: ['https://app.acme.example'],
      auth_config: {
        session: { absoluteMs: 168 * 3600_000, idleMs: 72 * 3600_000 },
        strategies: { password: true, username: true, passkey: true, emailLink: true, phoneCode: true },
        passwordPolicy: { minLength: 8, checkBreaches: true },
        accountUx: { username: { minLength: 3, maxLength: 20 } },
        signUpMode: 'restricted',
        mfa: { factors: { totp: true, passkey: true } },
        mfaPolicy: 'required',
      },
    });
    expect(r.bridge).toEqual({ preset: 'auth0', vars: { domain: DOMAIN } });
    expect(r.lazy).toEqual({ preset: 'auth0', config: { domain: DOMAIN, connection: 'Username-Password-Authentication' } });
  });

  it('reports sessions and the default database connection settings with their statuses', () => {
    const { report } = translateAuth0Config(FULL);
    const area = 'connections Username-Password-Authentication';
    expect(report).toContainEqual({ status: 'mapped', area: 'tenant settings', setting: 'session_lifetime', note: '168 hour(s).', atlas: 'auth_config.session.absoluteMs' });
    expect(report).toContainEqual({ status: 'mapped', area: 'tenant settings', setting: 'idle_session_lifetime', note: '72 hour(s) of inactivity.', atlas: 'auth_config.session.idleMs' });
    expect(report).toContainEqual(expect.objectContaining({ status: 'differs', area: 'connections', setting: 'database connections', note: expect.stringContaining('2 database connections'), atlas: 'users' }));
    expect(report).toContainEqual(expect.objectContaining({ status: 'mapped', area, setting: 'strategy auth0', atlas: 'auth_config.strategies.password' }));
    expect(report).toContainEqual({
      status: 'differs',
      area,
      setting: 'options.password_complexity_options.min_length',
      note: 'Auth0 allows 6; Atlas requires at least 8 (existing passwords still sign in).',
      atlas: 'auth_config.passwordPolicy.minLength',
    });
    expect(report).toContainEqual(expect.objectContaining({ status: 'differs', area, setting: 'options.passwordPolicy "good"', atlas: 'auth_config.passwordPolicy' }));
    expect(report).toContainEqual({ status: 'manual', area, setting: 'options.password_history', note: 'Atlas does not keep a password history.' });
    expect(report).toContainEqual(expect.objectContaining({ status: 'differs', area, setting: 'options.password_dictionary', atlas: 'auth_config.passwordPolicy.checkBreaches' }));
    expect(report).toContainEqual(expect.objectContaining({ status: 'mapped', area, setting: 'options.requires_username', atlas: 'auth_config.strategies.username' }));
    expect(report).toContainEqual(expect.objectContaining({ status: 'mapped', area, setting: 'options.disable_signup', atlas: 'auth_config.signUpMode' }));
    expect(report).toContainEqual(expect.objectContaining({ status: 'mapped', area, setting: 'options.brute_force_protection', atlas: 'auth_config.rateLimit' }));
    expect(report).toContainEqual(expect.objectContaining({ status: 'mapped', area, setting: 'options.authentication_methods.passkey', atlas: 'auth_config.strategies.passkey' }));
    // only the chosen (default) database connection is translated in detail
    expect(report.find((e) => e.area === 'connections legacy-db')).toBeUndefined();
  });

  it('maps passwordless, social, enterprise and custom connections', () => {
    const r = translateAuth0Config(FULL);
    expect(r.report).toContainEqual({ status: 'mapped', area: 'connections email', setting: 'strategy email', note: 'Passwordless magic link.', atlas: 'auth_config.strategies.emailLink' });
    expect(r.report).toContainEqual({
      status: 'differs',
      area: 'connections email',
      setting: 'options.totp.time_step',
      note: "Auth0 codes live 180s; set Atlas's verification.emailCode.ttlMinutes.",
      atlas: 'auth_config.verification.emailCode.ttlMinutes',
    });
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'mapped', area: 'connections sms', setting: 'strategy sms', atlas: 'auth_config.strategies.phoneCode' }));
    expect(r.documents.oauth_providers).toEqual([
      { provider: 'google', enabled: true, allow_sign_in: true, allow_sign_up: true, client_id: 'goog-123.apps.googleusercontent.com', client_secret: '${GOOGLE_CLIENT_SECRET}', scopes: ['email', 'profile'] },
      { provider: 'github', enabled: true, allow_sign_in: true, allow_sign_up: true, client_id: '${GITHUB_CLIENT_ID}', client_secret: '${GITHUB_CLIENT_SECRET}' },
    ]);
    expect(r.env).toEqual([
      { name: 'GOOGLE_CLIENT_SECRET', for: 'google-oauth2 client secret' },
      { name: 'GITHUB_CLIENT_ID', for: 'github client id' },
      { name: 'GITHUB_CLIENT_SECRET', for: 'github client secret' },
    ]);
    expect(r.mappings.providers).toEqual({ 'google-oauth2': 'google', github: 'github' });
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'differs', area: 'connections google-oauth2', setting: 'strategy google-oauth2', atlas: 'oauth_providers google' }));
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'manual', area: 'connections github', setting: 'strategy github', atlas: 'oauth_providers github' }));
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'manual', area: 'connections github', setting: 'options.client_id', atlas: 'oauth_providers github' }));
    expect(r.report.find((e) => e.area === 'connections google-oauth2' && e.setting === 'options.client_id')).toBeUndefined();
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'mapped', area: 'connections acme-okta-saml', setting: 'strategy samlp', atlas: 'sso_connections' }));
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'manual', area: 'connections corp-ad', setting: 'strategy ad', atlas: 'sso_connections' }));
    expect(r.report).toContainEqual({
      status: 'manual',
      area: 'connections custom-xero',
      setting: 'strategy oauth2',
      note: 'Custom social connection "custom-xero": recreate it as an Atlas custom OAuth provider (authorization https://login.xero.com/identity/connect/authorize, token https://identity.xero.com/connect/token); its fetchUserProfile script becomes a claim mapping.',
      atlas: 'custom_oauth_providers',
    });
    expect(r.report).toContainEqual({
      status: 'manual',
      area: 'connections evernote',
      setting: 'strategy evernote',
      note: '"evernote" is not a built-in Atlas provider; add it as a custom OAuth provider.',
      atlas: 'custom_oauth_providers',
    });
    // secrets never leave the vendor
    expect(JSON.stringify(r.documents)).not.toContain('GOCSPX-never-copied');
  });

  it('maps guardian factors, the MFA policy and breached-password detection', () => {
    const { report } = translateAuth0Config(FULL);
    expect(report).toContainEqual(expect.objectContaining({ status: 'mapped', area: 'multi-factor', setting: 'guardian factor otp', atlas: 'auth_config.mfa.factors.totp' }));
    expect(report).toContainEqual(expect.objectContaining({ status: 'mapped', area: 'multi-factor', setting: 'guardian factor webauthn', atlas: 'auth_config.mfa.factors.passkey' }));
    expect(report).toContainEqual(expect.objectContaining({ status: 'manual', area: 'multi-factor', setting: 'guardian factor push-notification' }));
    expect(report).toContainEqual(expect.objectContaining({ status: 'mapped', area: 'multi-factor', setting: 'guardian factor recovery-code', atlas: 'auth_config.mfa.backupCodes' }));
    expect(report.find((e) => e.setting === 'guardian factor sms')).toBeUndefined();
    expect(report.find((e) => e.setting === 'guardian factor email')).toBeUndefined();
    expect(report).toContainEqual({ status: 'mapped', area: 'multi-factor', setting: 'guardian policies all-applications', note: 'MFA always required.', atlas: 'auth_config.mfaPolicy' });
    expect(report).toContainEqual({
      status: 'mapped',
      area: 'attack protection',
      setting: 'breached-password-detection.enabled',
      note: 'Breached passwords are refused.',
      atlas: 'auth_config.passwordPolicy.checkBreaches',
    });
  });

  it('turns applications into redirect URLs and flags M2M / third-party apps and wildcards', () => {
    const r = translateAuth0Config(FULL);
    expect(r.documents.redirect_urls).toEqual([
      { url: 'https://app.acme.example/callback' },
      { url: 'com.acme.app://acme.us.auth0.com/ios/com.acme.app/callback' },
      { url: 'https://partner.example/cb' },
    ]);
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'differs', area: 'applications', setting: 'callbacks https://*.preview.acme.example/callback', atlas: 'redirect_urls' }));
    expect(r.report).toContainEqual({ status: 'mapped', area: 'applications', setting: 'callbacks', note: '3 callback URL(s) become redirect URLs.', atlas: 'redirect_urls' });
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'mapped', area: 'applications', setting: 'web_origins / allowed_origins', atlas: 'instance.allowed_origins' }));
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'manual', area: 'applications Billing worker', setting: 'app_type non_interactive', atlas: 'oauth_clients' }));
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'manual', area: 'applications Partner Portal', setting: 'is_first_party false', atlas: 'oauth_clients' }));
    expect(JSON.stringify(r.documents)).not.toContain('should-not-appear');
  });

  it('maps APIs, roles and permissions, and reports actions and enabled rules as manual', () => {
    const r = translateAuth0Config(FULL);
    expect(r.documents.resource_servers).toEqual([{ identifier: 'https://api.acme.example', name: 'Acme API', scopes: ['read:invoices', 'write:invoices'] }]);
    expect(r.report).toContainEqual({
      status: 'mapped',
      area: 'APIs',
      setting: 'resource-servers https://api.acme.example',
      note: 'API with 2 scope(s); access tokens for it keep "aud": "https://api.acme.example".',
      atlas: 'resource_servers https://api.acme.example',
    });
    expect(r.report.find((e) => e.setting === `resource-servers ${BASE}/`)).toBeUndefined();
    expect(r.documents.roles).toEqual([
      { key: 'billing_admin', name: 'Billing Admin', description: 'Manages billing', permissions: ['read:invoices', 'write:invoices'] },
      { key: 'viewer', name: 'Viewer', description: 'Read-only', permissions: ['read:invoices'] },
    ]);
    expect(r.documents.permissions).toEqual([
      { key: 'read:invoices', name: 'read:invoices', description: 'Read invoices' },
      { key: 'write:invoices', name: 'write:invoices', description: 'Create invoices' },
    ]);
    expect(r.mappings.roles).toEqual({ 'Billing Admin': 'billing_admin', Viewer: 'viewer' });
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'mapped', area: 'roles', setting: 'roles', note: '2 role(s) with their permissions; assignments move with the data export.' }));
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'manual', area: 'actions', setting: 'actions Add roles to token', note: expect.stringContaining('Auth0 Action (post-login)'), atlas: 'actions' }));
    expect(r.report).toContainEqual({ status: 'manual', area: 'rules', setting: 'rules Enrich profile', note: 'Auth0 Rule: port it to an Atlas action.', atlas: 'actions' });
    expect(r.report.find((e) => e.setting === 'rules Old rule')).toBeUndefined();
  });

  it('clamps a long session, picks a code email connection, and has no lazy preset without a database', () => {
    const r = translateAuth0Config({
      ...EMPTY,
      tenant: { session_lifetime: 8760 },
      connections: [{ id: 'con_email', name: 'email', strategy: 'email', options: { authParams: { response_type: 'code' }, email: { body: '<a href="@@link@@">x</a>' } } }],
      guardianFactors: [{ name: 'sms', enabled: true, trial_expired: false }],
      guardianPolicies: ['confidence-score'],
      breachedPassword: { enabled: false, shields: [], method: 'standard' },
    });
    expect(r.documents).toEqual({
      instance: { auth_config: { session: { absoluteMs: 90 * 24 * 3600_000 }, strategies: { password: false, emailCode: true }, passwordPolicy: { checkBreaches: false } } },
    });
    expect(r.report).toContainEqual({
      status: 'differs',
      area: 'tenant settings',
      setting: 'session_lifetime',
      note: "8760 hour(s) (clamped to Atlas's 90-day maximum).",
      atlas: 'auth_config.session.absoluteMs',
    });
    expect(r.report).toContainEqual(expect.objectContaining({ setting: 'strategy email', note: 'Passwordless email code.', atlas: 'auth_config.strategies.emailCode' }));
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'differs', setting: 'guardian factor sms', atlas: 'auth_config.mfa' }));
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'differs', setting: 'guardian policies confidence-score', atlas: 'auth_config.stepUp' }));
    expect(r.report).toContainEqual(expect.objectContaining({ setting: 'breached-password-detection.enabled', note: 'Breached-password check off.' }));
    expect(r.lazy).toBeUndefined();
    expect(r.bridge).toEqual({ preset: 'auth0', vars: { domain: DOMAIN } });
    expect(r.env).toEqual([]);
    expect(r.mappings).toEqual({ providers: {}, roles: {} });
  });

  it('uses the only database connection: a policy-derived length, a custom database, brute force off', () => {
    const r = translateAuth0Config({
      ...EMPTY,
      connections: [
        {
          id: 'con_db',
          name: 'users-db',
          strategy: 'auth0',
          options: { passwordPolicy: 'excellent', brute_force_protection: false, enabledDatabaseCustomization: true, customScripts: { login: 'function login(e, p, cb) {}' } },
        },
      ],
    });
    expect(r.documents.instance).toEqual({ auth_config: { strategies: { password: true }, passwordPolicy: { minLength: 10 } } });
    const area = 'connections users-db';
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'mapped', area, setting: 'options.password_complexity_options.min_length', note: '10.' }));
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'differs', area, setting: 'options.passwordPolicy "excellent"' }));
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'manual', area, setting: 'options.customScripts', atlas: 'legacy_auth_connection' }));
    expect(r.report.find((e) => e.setting === 'options.brute_force_protection')).toBeUndefined();
    expect(r.report.find((e) => e.setting === 'database connections')).toBeUndefined();
    expect(r.lazy).toEqual({ preset: 'auth0', config: { domain: DOMAIN, connection: 'users-db' } });
  });
});
