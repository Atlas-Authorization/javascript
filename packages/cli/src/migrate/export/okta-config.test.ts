import { describe, expect, it } from 'vitest';
import { fetchOktaConfig, translateOktaConfig, type OktaConfigSnapshot } from './okta-config';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';
import { VendorApiError, VendorHttp } from './vendor-http';

/**
 * Okta `/api/v1` responses as Okta returns them: bare arrays, paginated with
 * an RFC 8288 `Link: <…>; rel="next"` header; password / sign-on policies with
 * their rules, authenticators, identity providers (credentials included, which
 * must never be copied), authorization servers with scopes, apps and groups.
 */
const DOMAIN = 'acme.okta.com';
const ORIGIN = `https://${DOMAIN}`;
const BASE = `${ORIGIN}/api/v1`;

const PASSWORD_POLICIES = [
  {
    id: '00p1contractors',
    type: 'PASSWORD',
    name: 'Contractors',
    status: 'ACTIVE',
    priority: 1,
    system: false,
    conditions: { people: { groups: { include: ['00g2support'] } }, authProvider: { provider: 'OKTA' } },
    settings: { password: { complexity: { minLength: 14, minLowerCase: 0, minUpperCase: 0, minNumber: 0, minSymbol: 0 } } },
  },
  {
    id: '00p0default',
    type: 'PASSWORD',
    name: 'Default Policy',
    status: 'ACTIVE',
    priority: 2,
    system: true,
    conditions: { people: { groups: { include: ['00g0everyone'] } }, authProvider: { provider: 'OKTA' } },
    settings: {
      password: {
        complexity: { minLength: 6, minLowerCase: 1, minUpperCase: 1, minNumber: 1, minSymbol: 0, excludeUsername: true, dictionary: { common: { exclude: true } }, excludeAttributes: [] },
        age: { maxAgeDays: 90, expireWarnDays: 15, minAgeMinutes: 0, historyCount: 4 },
        lockout: { maxAttempts: 10, autoUnlockMinutes: 0, userLockoutNotificationChannels: [], showLockoutFailures: false },
      },
      recovery: { factors: { recovery_question: { status: 'ACTIVE' }, okta_email: { status: 'ACTIVE' } } },
      delegation: { options: { skipUnlock: false } },
    },
  },
];

const SIGN_ON_RULES = [
  {
    id: '0pr1mfa',
    name: 'MFA everywhere',
    status: 'ACTIVE',
    priority: 1,
    system: false,
    type: 'SIGN_ON',
    actions: { signon: { access: 'ALLOW', requireFactor: true, factorPromptMode: 'ALWAYS', rememberDeviceByDefault: false, session: { usePersistentCookie: false, maxSessionIdleMinutes: 120, maxSessionLifetimeMinutes: 720 } } },
  },
  {
    id: '0pr0default',
    name: 'Default Rule',
    status: 'ACTIVE',
    priority: 2,
    system: true,
    type: 'SIGN_ON',
    actions: { signon: { access: 'ALLOW', requireFactor: false, session: { usePersistentCookie: false, maxSessionIdleMinutes: 120, maxSessionLifetimeMinutes: 0 } } },
  },
];
const SIGN_ON_POLICY = { id: '00pS0default', type: 'OKTA_SIGN_ON', name: 'Default Policy', status: 'ACTIVE', priority: 2, system: true, conditions: { people: { groups: { include: ['00g0everyone'] } } } };
const CONTRACTOR_SIGN_ON = { id: '00pS1contractors', type: 'OKTA_SIGN_ON', name: 'Contractor sessions', status: 'ACTIVE', priority: 1, system: false };

const AUTHENTICATORS = [
  { id: 'aut1', key: 'okta_email', status: 'ACTIVE', type: 'email', name: 'Email' },
  { id: 'aut2', key: 'okta_password', status: 'ACTIVE', type: 'password', name: 'Password' },
  { id: 'aut3', key: 'okta_verify', status: 'ACTIVE', type: 'app', name: 'Okta Verify' },
  { id: 'aut4', key: 'google_otp', status: 'INACTIVE', type: 'app', name: 'Google Authenticator' },
  { id: 'aut5', key: 'webauthn', status: 'ACTIVE', type: 'security_key', name: 'Security Key or Biometric' },
  { id: 'aut6', key: 'phone_number', status: 'ACTIVE', type: 'phone', name: 'Phone' },
  { id: 'aut7', key: 'security_question', status: 'ACTIVE', type: 'security_question', name: 'Security Question' },
];

const IDPS = [
  {
    id: '0oa1google',
    type: 'GOOGLE',
    name: 'Google',
    status: 'ACTIVE',
    protocol: {
      type: 'OIDC',
      endpoints: { authorization: { url: 'https://accounts.google.com/o/oauth2/auth', binding: 'HTTP-REDIRECT' }, token: { url: 'https://www.googleapis.com/oauth2/v3/token', binding: 'HTTP-POST' } },
      scopes: ['profile', 'email', 'openid'],
      credentials: { client: { client_id: 'goog-123.apps.googleusercontent.com', client_secret: 'GOCSPX-never-copied' } },
    },
    policy: { provisioning: { action: 'AUTO' }, maxClockSkew: 0 },
  },
  { id: '0oa2fb', type: 'FACEBOOK', name: 'Facebook', status: 'INACTIVE', protocol: { type: 'OAUTH2', scopes: ['public_profile', 'email'], credentials: { client: { client_id: 'fb-1' } } } },
  { id: '0oa3saml', type: 'SAML2', name: 'Acme Corp ADFS', status: 'ACTIVE', protocol: { type: 'SAML2' } },
  { id: '0oa4li', type: 'LINKEDIN', name: 'LinkedIn', status: 'ACTIVE', protocol: { type: 'OAUTH2', scopes: ['r_emailaddress', 'r_liteprofile'], credentials: { client: { client_id: '86lnk', client_secret: 'li-secret' } } } },
  { id: '0oa5x509', type: 'X509', name: 'Smart card', status: 'ACTIVE', protocol: { type: 'MTLS' } },
];

const SERVER_SCOPES = [
  { id: 'scp1', name: 'openid', system: true, consent: 'IMPLICIT' },
  { id: 'scp2', name: 'invoices:read', system: false, consent: 'IMPLICIT', description: 'Read invoices' },
  { id: 'scp3', name: 'invoices:write', system: false, consent: 'REQUIRED', description: 'Write invoices' },
];
const SERVERS = [
  { id: 'aus1acme', name: 'Acme API', description: 'Acme', audiences: ['api://acme'], issuer: `${ORIGIN}/oauth2/aus1acme`, issuerMode: 'ORG_URL', status: 'ACTIVE' },
  { id: 'default', name: 'default', description: 'Default Authorization Server', audiences: ['api://default'], issuer: `${ORIGIN}/oauth2/default`, issuerMode: 'ORG_URL', status: 'ACTIVE' },
  { id: 'aus2old', name: 'Old', audiences: ['api://old'], status: 'INACTIVE' },
];

const APPS = [
  {
    id: '0oaWeb',
    name: 'oidc_client',
    label: 'Acme Web',
    status: 'ACTIVE',
    signOnMode: 'OPENID_CONNECT',
    settings: {
      app: {},
      oauthClient: {
        redirect_uris: ['https://app.acme.example/callback', 'https://*.acme.example/cb'],
        post_logout_redirect_uris: ['https://app.acme.example'],
        response_types: ['code'],
        grant_types: ['authorization_code', 'refresh_token'],
        application_type: 'browser',
      },
    },
  },
  { id: '0oaSvc', name: 'oidc_client', label: 'Billing Service', status: 'ACTIVE', signOnMode: 'OPENID_CONNECT', settings: { oauthClient: { response_types: ['token'], grant_types: ['client_credentials'], application_type: 'service' } } },
  { id: '0oaSf', name: 'salesforce', label: 'Salesforce', status: 'ACTIVE', signOnMode: 'SAML_2_0', settings: { app: { instanceType: 'PRODUCTION' } } },
];

const GROUP_EVERYONE = { id: '00g0everyone', type: 'BUILT_IN', profile: { name: 'Everyone', description: 'All users in your organization' } };
const GROUP_BILLING = { id: '00g1billing', type: 'OKTA_GROUP', profile: { name: 'Billing Admins', description: 'Can manage invoices' } };
const GROUP_SUPPORT = { id: '00g2support', type: 'APP_GROUP', profile: { name: 'Support', description: null } };

const HOOKS = [
  { id: 'cal1', name: 'Token enrichment', type: 'com.okta.oauth2.tokens.transform', status: 'ACTIVE', version: '1.0.0', channel: { type: 'HTTP', version: '1.0.0', config: { uri: 'https://hooks.acme.example/tokens' } } },
  { id: 'cal2', name: 'Old import hook', type: 'com.okta.import.transform', status: 'INACTIVE', version: '1.0.0' },
];

const FULL: OktaConfigSnapshot = {
  domain: DOMAIN,
  passwordPolicies: PASSWORD_POLICIES,
  signOnPolicies: [
    { ...CONTRACTOR_SIGN_ON, rules: [] },
    { ...SIGN_ON_POLICY, rules: SIGN_ON_RULES },
  ],
  authenticators: AUTHENTICATORS,
  idps: IDPS,
  authorizationServers: [
    { ...SERVERS[0]!, scopes: SERVER_SCOPES, claims: [{ id: 'ocl1', name: 'groups', claimType: 'RESOURCE', valueType: 'GROUPS', value: '.*' }] },
    { ...SERVERS[1]!, scopes: [SERVER_SCOPES[0]!] },
    { ...SERVERS[2]!, scopes: [] },
  ],
  apps: APPS,
  groups: [GROUP_BILLING, GROUP_SUPPORT],
  inlineHooks: HOOKS,
};

const EMPTY: OktaConfigSnapshot = { domain: DOMAIN, passwordPolicies: [], signOnPolicies: [], authenticators: [], idps: [], authorizationServers: [], apps: [], groups: [], inlineHooks: [] };

const http = (fetchImpl: typeof fetch, attempts?: number) =>
  new VendorHttp({ vendor: 'Okta', baseUrl: BASE, headers: { authorization: 'SSWS 00abcToken' }, fetchImpl, sleep: noSleep, attempts });

describe('fetchOktaConfig', () => {
  it('reads policies, servers, apps and paginated groups with the SSWS token, tolerating 403/404', async () => {
    const api = fakeVendor(ORIGIN, {
      'GET /api/v1/policies?type=OKTA_SIGN_ON': [SIGN_ON_POLICY],
      [`GET /api/v1/policies/${SIGN_ON_POLICY.id}/rules`]: SIGN_ON_RULES,
      'GET /api/v1/authorizationServers': SERVERS.slice(0, 1),
      [`GET /api/v1/authorizationServers/${SERVERS[0]!.id}/scopes`]: SERVER_SCOPES,
      'GET /api/v1/policies?type=PASSWORD': PASSWORD_POLICIES,
      // authenticators unrouted → 404
      'GET /api/v1/idps': { status: 403, body: { errorCode: 'E0000006', errorSummary: 'You do not have permission to perform the requested action', errorLink: 'E0000006', errorId: 'oae1', errorCauses: [] } },
      'GET /api/v1/apps': APPS,
      'GET /api/v1/groups?limit=200': {
        status: 200,
        body: [GROUP_EVERYONE, GROUP_BILLING],
        headers: { link: `<${BASE}/groups?limit=200>; rel="self", <${BASE}/groups?after=00g1billing&limit=200>; rel="next"` },
      },
      'GET /api/v1/groups?after=00g1billing&limit=200': [GROUP_SUPPORT],
      'GET /api/v1/inlineHooks': { status: 403, body: { errorCode: 'E0000006', errorSummary: 'You do not have permission to perform the requested action', errorLink: 'E0000006', errorId: 'oae2', errorCauses: [] } },
    });
    const snap = await fetchOktaConfig(http(api.fetchImpl), DOMAIN);
    expect(snap).toEqual({
      domain: DOMAIN,
      passwordPolicies: PASSWORD_POLICIES,
      signOnPolicies: [{ ...SIGN_ON_POLICY, rules: SIGN_ON_RULES }],
      authenticators: [],
      idps: [],
      authorizationServers: [{ ...SERVERS[0]!, scopes: SERVER_SCOPES }],
      apps: APPS,
      groups: [GROUP_BILLING, GROUP_SUPPORT],
      inlineHooks: [],
    });
    expect(api.calls.map((c) => c.url)).toEqual([
      `${BASE}/policies?type=OKTA_SIGN_ON`,
      `${BASE}/policies/00pS0default/rules`,
      `${BASE}/authorizationServers`,
      `${BASE}/authorizationServers/aus1acme/scopes`,
      `${BASE}/policies?type=PASSWORD`,
      `${BASE}/authenticators`,
      `${BASE}/idps`,
      `${BASE}/apps?limit=200&filter=status%20eq%20%22ACTIVE%22`,
      `${BASE}/groups?limit=200`,
      `${BASE}/groups?after=00g1billing&limit=200`,
      `${BASE}/inlineHooks`,
    ]);
    expect(api.calls.every((c) => c.headers.get('authorization') === 'SSWS 00abcToken')).toBe(true);
  });

  it('keeps the pages read before a page is refused', async () => {
    const api = fakeVendor(ORIGIN, {
      'GET /api/v1/groups?limit=200': { status: 200, body: [GROUP_BILLING], headers: { link: `<${BASE}/groups?after=00g1billing&limit=200>; rel="next"` } },
      'GET /api/v1/groups?after=00g1billing&limit=200': { status: 403, body: { errorCode: 'E0000006', errorSummary: 'You do not have permission to perform the requested action' } },
    });
    const snap = await fetchOktaConfig(http(api.fetchImpl), DOMAIN);
    expect(snap.groups).toEqual([GROUP_BILLING]);
    expect(snap.signOnPolicies).toEqual([]);
    expect(snap.passwordPolicies).toEqual([]);
  });

  it('fails on an invalid token (401) instead of returning an empty config', async () => {
    const api = fakeVendor(ORIGIN, {
      'GET /api/v1/policies?type=OKTA_SIGN_ON': { status: 401, body: { errorCode: 'E0000011', errorSummary: 'Invalid token provided', errorLink: 'E0000011', errorId: 'oae1', errorCauses: [] } },
    });
    const err = await fetchOktaConfig(http(api.fetchImpl), DOMAIN).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VendorApiError);
    expect((err as VendorApiError).status).toBe(401);
  });

  it('rethrows other errors (a server error once retries are spent)', async () => {
    const api = fakeVendor(ORIGIN, {
      'GET /api/v1/policies?type=OKTA_SIGN_ON': { status: 500, body: { errorCode: 'E0000009', errorSummary: 'Internal Server Error', errorId: 'oae3', errorCauses: [] } },
    });
    const err = await fetchOktaConfig(http(api.fetchImpl, 1), DOMAIN).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VendorApiError);
    expect((err as VendorApiError).status).toBe(500);
    expect((err as VendorApiError).message).toBe('Okta API 500 on /policies: Internal Server Error');
    expect(api.calls).toHaveLength(1);
  });
});

describe('translateOktaConfig', () => {
  it('builds auth_config from the default password and sign-on policies and the authenticators', () => {
    const r = translateOktaConfig(FULL);
    expect(r.origin).toBe(`Okta org ${DOMAIN}`);
    expect(r.documents.instance).toEqual({
      auth_config: {
        strategies: { password: true, passkey: true },
        passwordPolicy: { minLength: 8, checkBreaches: true },
        session: { absoluteMs: 720 * 60_000, idleMs: 120 * 60_000 },
        mfaPolicy: 'required',
        mfa: { factors: { emailCode: true, totp: true, passkey: true } },
      },
    });
    expect(r.bridge).toEqual({ preset: 'okta', vars: { domain: DOMAIN } });
    expect(r.lazy).toEqual({ preset: 'okta', config: { domain: DOMAIN } });
  });

  it('reports the password policy, sessions and authenticators with their statuses', () => {
    const { report } = translateOktaConfig(FULL);
    const pw = 'policies Default Policy';
    expect(report[0]).toEqual(expect.objectContaining({ status: 'differs', area: 'authentication', setting: 'password', atlas: 'auth_config.strategies.password' }));
    expect(report).toContainEqual({
      status: 'differs',
      area: pw,
      setting: 'settings.password.complexity.minLength',
      note: '6 (Atlas requires at least 8; existing passwords still sign in).',
      atlas: 'auth_config.passwordPolicy.minLength',
    });
    expect(report).toContainEqual(expect.objectContaining({ status: 'differs', area: pw, setting: 'settings.password.complexity (character classes)', atlas: 'auth_config.passwordPolicy' }));
    expect(report).toContainEqual(expect.objectContaining({ status: 'mapped', area: pw, setting: 'settings.password.complexity.dictionary.common.exclude', atlas: 'auth_config.passwordPolicy.checkBreaches' }));
    expect(report).toContainEqual({ status: 'manual', area: pw, setting: 'settings.password.age.maxAgeDays', note: 'Atlas does not expire passwords (NIST 800-63B).' });
    expect(report).toContainEqual({ status: 'manual', area: pw, setting: 'settings.password.age.historyCount', note: 'Atlas does not keep a password history.' });
    expect(report).toContainEqual(expect.objectContaining({ status: 'mapped', area: pw, setting: 'settings.password.lockout.maxAttempts', note: expect.stringContaining('Okta locks after 10 attempts'), atlas: 'auth_config.rateLimit' }));
    expect(report).toContainEqual(expect.objectContaining({ status: 'differs', area: 'policies', setting: 'password policies', note: expect.stringContaining('2 password policies by group') }));
    expect(report.find((e) => e.area === 'policies Contractors')).toBeUndefined();
    expect(report).toContainEqual({ status: 'mapped', area: pw, setting: 'actions.signon.session.maxSessionLifetimeMinutes', note: '720 minutes.', atlas: 'auth_config.session.absoluteMs' });
    expect(report).toContainEqual({ status: 'mapped', area: pw, setting: 'actions.signon.session.maxSessionIdleMinutes', note: '120 minutes idle.', atlas: 'auth_config.session.idleMs' });
    expect(report).toContainEqual(expect.objectContaining({ status: 'mapped', area: pw, setting: 'actions.signon.requireFactor', atlas: 'auth_config.mfaPolicy' }));
    expect(report).toContainEqual(expect.objectContaining({ status: 'manual', area: 'policies', setting: 'sign-on policies by group / network zone', atlas: 'auth_config.stepUp' }));
    expect(report).toContainEqual(expect.objectContaining({ status: 'mapped', area: 'authenticators', setting: 'Email (okta_email)', atlas: 'auth_config.mfa.factors.emailCode' }));
    expect(report).toContainEqual(expect.objectContaining({ status: 'differs', area: 'authenticators', setting: 'Okta Verify (okta_verify)', atlas: 'auth_config.mfa.factors.totp' }));
    expect(report).toContainEqual(expect.objectContaining({ status: 'differs', area: 'authenticators', setting: 'Security Key or Biometric (webauthn)', atlas: 'auth_config.mfa.factors.passkey' }));
    expect(report).toContainEqual(expect.objectContaining({ status: 'differs', area: 'authenticators', setting: 'Phone (phone_number)', atlas: 'auth_config.mfa' }));
    expect(report).toContainEqual(expect.objectContaining({ status: 'manual', area: 'authenticators', setting: 'Security Question (security_question)' }));
    expect(report.find((e) => e.setting.includes('okta_password'))).toBeUndefined();
    expect(report.find((e) => e.setting.includes('google_otp'))).toBeUndefined();
  });

  it('turns active social IdPs into oauth_providers without copying their secrets', () => {
    const r = translateOktaConfig(FULL);
    expect(r.documents.oauth_providers).toEqual([
      { provider: 'google', enabled: true, allow_sign_in: true, allow_sign_up: true, client_id: 'goog-123.apps.googleusercontent.com', client_secret: '${GOOGLE_CLIENT_SECRET}', scopes: ['profile', 'email', 'openid'] },
      { provider: 'linkedin', enabled: true, allow_sign_in: true, allow_sign_up: true, client_id: '86lnk', client_secret: '${LINKEDIN_CLIENT_SECRET}', scopes: ['r_emailaddress', 'r_liteprofile'] },
    ]);
    expect(r.env).toEqual([
      { name: 'GOOGLE_CLIENT_SECRET', for: 'Google client secret' },
      { name: 'LINKEDIN_CLIENT_SECRET', for: 'LinkedIn client secret' },
    ]);
    expect(r.mappings.providers).toEqual({ Google: 'google', LinkedIn: 'linkedin' });
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'differs', area: 'identity providers', setting: 'Google (GOOGLE)', atlas: 'oauth_providers google' }));
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'mapped', area: 'identity providers', setting: 'Acme Corp ADFS (SAML2)', atlas: 'sso_connections' }));
    expect(r.report).toContainEqual({
      status: 'manual',
      area: 'identity providers',
      setting: 'Smart card (X509)',
      note: 'No built-in Atlas provider: add it as a custom OAuth provider.',
      atlas: 'custom_oauth_providers',
    });
    expect(r.report.find((e) => e.setting.startsWith('Facebook'))).toBeUndefined();
    const docs = JSON.stringify(r.documents);
    expect(docs).not.toContain('GOCSPX-never-copied');
    expect(docs).not.toContain('li-secret');
  });

  it('maps authorization servers to resource servers and OIDC apps to redirect URLs', () => {
    const r = translateOktaConfig(FULL);
    expect(r.documents.resource_servers).toEqual([
      { identifier: 'api://acme', name: 'Acme API', scopes: ['invoices:read', 'invoices:write'] },
      { identifier: 'api://default', name: 'default', scopes: [] },
    ]);
    expect(r.report).toContainEqual({
      status: 'mapped',
      area: 'authorization servers Acme API',
      setting: 'audiences api://acme',
      note: 'An API with 2 custom scope(s); Atlas access tokens for it keep "aud": "api://acme".',
      atlas: 'resource_servers api://acme',
    });
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'manual', area: 'authorization servers Acme API', setting: 'claims', atlas: 'jwt_templates' }));
    expect(r.report.find((e) => e.setting === 'audiences api://old')).toBeUndefined();
    expect(r.documents.redirect_urls).toEqual([{ url: 'https://app.acme.example/callback' }]);
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'differs', area: 'apps', setting: 'redirect_uris https://*.acme.example/cb', atlas: 'redirect_urls' }));
    expect(r.report).toContainEqual({ status: 'mapped', area: 'apps', setting: 'redirect_uris', note: '1 redirect URI(s).', atlas: 'redirect_urls' });
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'manual', area: 'apps Billing Service', setting: 'grant_types client_credentials', atlas: 'oauth_clients' }));
    expect(r.report.find((e) => e.area === 'apps Salesforce')).toBeUndefined();
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'manual', area: 'inline hooks', setting: 'Token enrichment (com.okta.oauth2.tokens.transform)', atlas: 'actions' }));
    expect(r.report.find((e) => e.setting.startsWith('Old import hook'))).toBeUndefined();
  });

  it('turns groups into app roles by default', () => {
    const r = translateOktaConfig(FULL);
    expect(r.documents.roles).toEqual([
      { key: 'billing_admins', name: 'Billing Admins', description: 'Can manage invoices', permissions: [] },
      { key: 'support', name: 'Support', description: '', permissions: [] },
    ]);
    expect(r.mappings.roles).toEqual({ 'Billing Admins': 'billing_admins', Support: 'support' });
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'differs', area: 'groups', setting: 'groups', note: expect.stringContaining('2 group(s) become Atlas app roles'), atlas: 'roles' }));
    expect(translateOktaConfig(FULL, { groupsAs: 'roles' }).documents.roles).toEqual(r.documents.roles);
  });

  it('with groupsAs organizations or skip, writes no roles', () => {
    const orgs = translateOktaConfig(FULL, { groupsAs: 'organizations' });
    expect(orgs.documents.roles).toBeUndefined();
    expect(orgs.mappings.roles).toEqual({});
    expect(orgs.report).toContainEqual({
      status: 'differs',
      area: 'groups',
      setting: 'groups',
      note: 'Groups become organizations with the data export (--groups-as organizations).',
      atlas: 'organizations',
    });
    const skip = translateOktaConfig(FULL, { groupsAs: 'skip' });
    expect(skip.documents.roles).toBeUndefined();
    expect(skip.mappings.roles).toEqual({});
    expect(skip.report.find((e) => e.area === 'groups')).toBeUndefined();
    expect(translateOktaConfig({ ...FULL, groups: [] }, { groupsAs: 'organizations' }).report.find((e) => e.area === 'groups')).toBeUndefined();
  });

  it('handles an empty org: password only, and falls back to the last sign-on policy and its first rule', () => {
    const empty = translateOktaConfig(EMPTY);
    expect(empty.documents).toEqual({ instance: { auth_config: { strategies: { password: true } } } });
    expect(empty.report).toEqual([expect.objectContaining({ status: 'differs', area: 'authentication', setting: 'password' })]);
    expect(empty.env).toEqual([]);
    expect(empty.mappings).toEqual({ providers: {}, roles: {} });
    expect(empty.lazy).toEqual({ preset: 'okta', config: { domain: DOMAIN } });

    const r = translateOktaConfig({
      ...EMPTY,
      passwordPolicies: [{ id: '00p0', name: 'Default Policy', priority: 1, settings: { password: { complexity: { minLength: 12 } } } }],
      signOnPolicies: [
        {
          id: '00pS0',
          name: 'Global',
          rules: [{ id: '0pr0', name: 'Default Rule', status: 'ACTIVE', system: true, actions: { signon: { access: 'ALLOW', session: { maxSessionLifetimeMinutes: 0, maxSessionIdleMinutes: 200000 } } } }],
        },
      ],
    });
    expect(r.documents.instance).toEqual({ auth_config: { strategies: { password: true }, passwordPolicy: { minLength: 12 }, session: { idleMs: 90 * 24 * 3600_000 } } });
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'mapped', area: 'policies Default Policy', setting: 'settings.password.complexity.minLength', note: '12.' }));
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'mapped', area: 'policies Global', setting: 'actions.signon.session.maxSessionIdleMinutes', note: '200000 minutes idle.' }));
    expect(r.report.find((e) => e.setting === 'actions.signon.session.maxSessionLifetimeMinutes')).toBeUndefined();
    expect(r.report.find((e) => e.setting === 'actions.signon.requireFactor')).toBeUndefined();
    expect(r.report.find((e) => e.setting === 'password policies')).toBeUndefined();
  });
});
