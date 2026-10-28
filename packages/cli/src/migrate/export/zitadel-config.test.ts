import { describe, expect, it } from 'vitest';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';
import { configSnapshotFromExport, fetchZitadelConfig, fetchZitadelPolicies, translateZitadelConfig } from './zitadel-config';
import { zitadelHttp } from './zitadel';

/** ZITADEL's per-organization policies, projects, applications and identity providers as the export writes them. */
const ORG = {
  orgId: '1001',
  org: { name: 'Acme' },
  loginPolicy: {
    allowUsernamePassword: true,
    allowRegister: false,
    allowExternalIdp: true,
    forceMfa: true,
    passwordlessType: 'PASSWORDLESS_TYPE_ALLOWED',
    hidePasswordReset: true,
    ignoreUnknownUsernames: true,
    defaultRedirectUri: 'https://app.acme.com/welcome',
    passwordCheckLifetime: '864000s',
  },
  secondFactors: ['SECOND_FACTOR_TYPE_OTP', 'SECOND_FACTOR_TYPE_U2F', 'SECOND_FACTOR_TYPE_OTP_SMS', 'SECOND_FACTOR_TYPE_UNSPECIFIED'],
  multiFactors: ['MULTI_FACTOR_TYPE_U2F_WITH_VERIFICATION'],
  passwordComplexityPolicy: { minLength: '10', hasUppercase: true, hasLowercase: true, hasNumber: true, hasSymbol: false },
  lockoutPolicy: { maxPasswordAttempts: '5', maxOtpAttempts: '3' },
  domainPolicy: { userLoginMustBeDomain: true },
  privacyPolicy: { tosLink: 'https://acme.com/tos', privacyLink: 'https://acme.com/privacy' },
  labelPolicy: { primaryColor: '#5469d4' },
  projects: [{ projectId: 'p1', project: { name: 'Portal', projectRoleAssertion: true } }],
  projectRoles: [
    { projectId: 'p1', roleKey: 'Billing Admin', displayName: 'Billing admin', group: 'finance' },
    { projectId: 'p1', roleKey: 'viewer', displayName: 'Viewer' },
  ],
  oidcApps: [
    {
      appId: 'a1',
      app: {
        name: 'Web',
        redirectUris: ['https://app.acme.com/callback', 'https://*.acme.com/cb'],
        postLogoutRedirectUris: ['https://app.acme.com/'],
        additionalOrigins: ['https://app.acme.com'],
        appType: 'OIDC_APP_TYPE_WEB',
        grantTypes: ['OIDC_GRANT_TYPE_AUTHORIZATION_CODE'],
      },
    },
    { appId: 'a2', app: { name: 'Mobile', appType: 'OIDC_APP_TYPE_NATIVE', redirectUris: ['com.acme.app://callback'] } },
    { appId: 'a3', app: { name: 'Worker', grantTypes: ['OIDC_GRANT_TYPE_CLIENT_CREDENTIALS'], authMethodType: 'OIDC_AUTH_METHOD_TYPE_PRIVATE_KEY_JWT' } },
  ],
  apiApps: [{ appId: 'a4', app: { name: 'Backend API' } }],
  actions: [{ actionId: 'x1', action: { name: 'addClaims', script: 'function addClaims(ctx, api) {}' } }],
  googleIdps: [{ idpId: 'i1', idp: { name: 'Google', clientId: '123.apps.googleusercontent.com', scopes: ['openid', 'profile'] } }],
  oidcIdps: [{ idpId: 'i2', idp: { name: 'Acme SSO', issuer: 'https://sso.acme.com', clientId: 'abc' } }],
  samlIdps: [{ idpId: 'i3', idp: { name: 'Partner' } }],
  ldapIdps: [{ idpId: 'i4', idp: { name: 'Corp AD' } }],
};

const INSTANCE = 'https://acme-abc123.zitadel.cloud';

describe('translateZitadelConfig', () => {
  const t = translateZitadelConfig(configSnapshotFromExport({ orgs: [ORG] }, 'ZITADEL export file', INSTANCE));
  const auth = (t.documents.instance as { auth_config: Record<string, unknown> }).auth_config;
  const entry = (setting: string) => t.report.find((r) => r.setting === setting)!;

  it('maps the login policy onto sign-up mode, strategies and the MFA policy', () => {
    expect(auth).toMatchObject({
      signUpMode: 'restricted',
      strategies: { password: true, passkey: true },
      mfaPolicy: 'required',
      mfa: { factors: { totp: true, passkey: true, sms: true } },
    });
    expect(entry('secondFactors SECOND_FACTOR_TYPE_UNSPECIFIED').status).toBe('manual');
    expect(entry('loginPolicy.hidePasswordReset').status).toBe('differs');
    expect(entry('loginPolicy.passwordCheckLifetime')).toMatchObject({ status: 'differs', atlas: 'auth_config.stepUp' });
  });

  it('maps the password policy, reading ZITADEL\'s string numbers', () => {
    expect(auth).toMatchObject({ passwordPolicy: { minLength: 10, requireUppercase: true, requireLowercase: true, requireNumber: true } });
    expect((auth.passwordPolicy as Record<string, unknown>).requireSymbol).toBeUndefined();
    expect(entry('lockoutPolicy.maxPasswordAttempts').status).toBe('differs');
    expect(entry('domainPolicy.userLoginMustBeDomain').status).toBe('differs');
  });

  it('turns application URLs into redirect URLs and origins, refusing wildcards', () => {
    expect(t.documents.redirect_urls).toEqual([
      { url: 'https://app.acme.com/welcome' },
      { url: 'https://app.acme.com/callback' },
      { url: 'https://app.acme.com/' },
      { url: 'com.acme.app://callback' },
    ]);
    expect(entry('redirectUris https://*.acme.com/cb').status).toBe('differs');
    expect((t.documents.instance as { allowed_origins: string[] }).allowed_origins).toEqual(['https://app.acme.com']);
    expect(entry('appType NATIVE').status).toBe('manual');
    expect(entry('grantTypes client_credentials').atlas).toBe('oauth_clients');
    expect(entry('authMethodType private_key_jwt').status).toBe('manual');
    expect(entry('API application').atlas).toBe('resource_servers');
  });

  it('turns project roles into app roles and flags the roles claim and actions', () => {
    expect(t.documents.roles).toEqual([
      { key: 'billing_admin', name: 'Billing admin', description: 'finance', permissions: [] },
      { key: 'viewer', name: 'Viewer', description: '', permissions: [] },
    ]);
    expect(t.mappings.roles).toEqual({ 'Billing Admin': 'billing_admin' });
    expect(entry('projectRoleAssertion')).toMatchObject({ status: 'manual', atlas: 'jwt_templates' });
    expect(entry('action addClaims').status).toBe('manual');
  });

  it('maps identity providers: social, generic OIDC, SAML and the ones without a counterpart', () => {
    expect(t.documents.oauth_providers).toEqual([
      expect.objectContaining({ provider: 'google', client_id: '123.apps.googleusercontent.com', client_secret: '${GOOGLE_CLIENT_SECRET}', scopes: ['openid', 'profile'] }),
    ]);
    expect(t.documents.custom_oauth_providers).toEqual([
      expect.objectContaining({ provider_key: 'acme_sso', protocol: 'oidc', issuer: 'https://sso.acme.com', client_id: 'abc', client_secret: '${ACME_SSO_CLIENT_SECRET}' }),
    ]);
    expect(entry('identity provider Partner').atlas).toBe('sso_connections');
    expect(entry('identity provider Corp AD').status).toBe('manual');
    expect(t.env.map((e) => e.name).sort()).toEqual(['ACME_SSO_CLIENT_SECRET', 'GOOGLE_CLIENT_SECRET']);
  });

  it('flags branding and the privacy links as manual, and learns the bridge and lazy settings from the instance', () => {
    expect(entry('labelPolicy').status).toBe('manual');
    expect(entry('privacyPolicy').note).toContain('https://acme.com/tos');
    expect(t.bridge).toEqual({ preset: 'zitadel', vars: { issuer: INSTANCE } });
    expect(t.lazy).toEqual({ preset: 'zitadel', config: { base_url: INSTANCE } });
  });
});

describe('instance defaults', () => {
  it('prefers the live instance policies and counts the organizations that override them', () => {
    const snap = { ...configSnapshotFromExport({ orgs: [ORG] }, 'x'), defaults: { login: { allowRegister: true, allowUsernamePassword: true }, secondFactors: ['SECOND_FACTOR_TYPE_OTP_EMAIL'] } };
    const t = translateZitadelConfig(snap);
    const auth = (t.documents.instance as { auth_config: Record<string, unknown> }).auth_config;
    expect(auth).toMatchObject({ signUpMode: 'public', mfa: { factors: { emailCode: true } } });
    expect(auth.mfaPolicy).toBeUndefined();
    expect(t.report.find((r) => r.setting === 'loginPolicy')?.note).toMatch(/1 organization\(s\) override the instance login policy/);
    expect(t.bridge?.vars).toEqual({});
    expect(t.lazy).toBeUndefined();
  });

  it('reads the policies through the Admin API, tolerating the ones a role cannot see', async () => {
    const v = fakeVendor(INSTANCE, {
      'POST /admin/v1/export': { orgs: [{ orgId: '1', org: { name: 'Acme' }, humanUsers: [] }] },
      'POST /admin/v1/idps/templates/_search': { result: [] },
      'GET /admin/v1/policies/login': { policy: { allowRegister: false, forceMfa: false } },
      'GET /admin/v1/policies/password/complexity': { policy: { minLength: '8', hasNumber: true } },
      'GET /admin/v1/policies/lockout': { status: 403, body: { message: 'forbidden' } },
      'GET /admin/v1/policies/login/second_factors': { result: ['SECOND_FACTOR_TYPE_OTP'] },
    });
    const snap = await fetchZitadelConfig({ instance: INSTANCE, token: 'pat', fetchImpl: v.fetchImpl, sleep: noSleep });
    expect(v.calls[0]!.body).toEqual({ withPasswords: false, withOtp: false, responseOutput: true });
    expect(snap.defaults).toEqual({
      login: { allowRegister: false, forceMfa: false },
      passwordComplexity: { minLength: '8', hasNumber: true },
      lockout: undefined,
      secondFactors: ['SECOND_FACTOR_TYPE_OTP'],
      multiFactors: undefined,
    });
    const t = translateZitadelConfig(snap);
    expect((t.documents.instance as { auth_config: Record<string, unknown> }).auth_config).toMatchObject({ signUpMode: 'restricted', passwordPolicy: { minLength: 8, requireNumber: true }, mfa: { factors: { totp: true } } });
    const http = zitadelHttp({ instance: INSTANCE, token: 'pat', fetchImpl: v.fetchImpl, sleep: noSleep });
    expect((await fetchZitadelPolicies(http)).lockout).toBeUndefined();
  });
});
