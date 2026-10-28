import { describe, expect, it } from 'vitest';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';
import { fetchLogtoConfig, translateLogtoConfig, type LogtoConfigSnapshot } from './logto-config';
import { VendorHttp } from './vendor-http';

/** Logto Management API objects as the tenant returns them (camelCase). */
const ENDPOINT = 'https://auth.acme.example';

const SIGN_IN_EXP = {
  tenantId: 'default',
  id: 'default',
  signIn: {
    methods: [
      { identifier: 'username', password: true, verificationCode: false, isPasswordPrimary: true },
      { identifier: 'email', password: true, verificationCode: true, isPasswordPrimary: true },
      { identifier: 'phone', password: false, verificationCode: true, isPasswordPrimary: true },
    ],
  },
  signUp: { identifiers: ['username', 'email'], password: true, verify: true },
  signInMode: 'SignIn',
  socialSignInConnectorTargets: ['google', 'github'],
  singleSignOnEnabled: true,
  agreeToTermsPolicy: 'Manual',
  forgotPasswordMethods: ['EmailVerificationCode'],
  customCss: '.logto { color: red }',
  passkeySignIn: { enabled: true, allowAutofill: true, showPasskeyButton: true },
  passwordPolicy: {
    length: { min: 6, max: 64 },
    characterTypes: { min: 2 },
    rejects: { pwned: true, repeatedIdentical: true, sequential: false, userInfo: true, words: ['acme'] },
  },
  mfa: { factors: ['Totp', 'WebAuthn', 'BackupCode'], policy: 'Mandatory' },
};

const SNAPSHOT: LogtoConfigSnapshot = {
  endpoint: ENDPOINT,
  tenantId: 'default',
  signInExp: SIGN_IN_EXP,
  connectors: [
    { id: 'c1', target: 'google', connectorId: 'google-universal', type: 'Social', config: { clientId: 'gid', clientSecret: 'sup3rsecret', scope: 'openid email profile' }, metadata: { name: { en: 'Google' } } },
    { id: 'c2', target: 'github', connectorId: 'github', type: 'Social', config: { clientId: 'ghid', clientSecret: 'sup3rsecret2' } },
    { id: 'c3', target: 'sendgrid-mail', connectorId: 'sendgrid-mail', type: 'Email', config: { apiKey: 'SG.key' } },
    { id: 'c4', target: 'wechat', connectorId: 'wechat-web', type: 'Social', config: {} },
  ],
  applications: [
    {
      id: 'a1',
      name: 'Web',
      type: 'SPA',
      oidcClientMetadata: { redirectUris: ['https://app.acme.example/callback', 'https://*.acme.example/cb', 'io.acme.app://cb'], postLogoutRedirectUris: ['https://app.acme.example'] },
      customClientMetadata: { corsAllowedOrigins: ['https://app.acme.example'], idTokenTtl: 3600 },
    },
    { id: 'a2', name: 'Worker', type: 'MachineToMachine' },
    { id: 'a3', name: 'Docs proxy', type: 'Protected' },
  ],
  resources: [{ id: 'res1', name: 'Billing API', indicator: 'https://api.acme.example/billing', accessTokenTtl: 7200, scopes: [{ name: 'read:invoices' }, { name: 'write:invoices' }] }],
  roles: [{ id: 'r1', name: 'Billing Admin', description: 'Manages billing', type: 'User' }],
  hooks: [{ id: 'h1', name: 'Sync', events: ['PostRegister'], enabled: true, config: { url: 'https://hooks.acme.example' } }],
  jwtCustomizers: [{ key: 'access-token' }],
};

describe('translateLogtoConfig', () => {
  const result = translateLogtoConfig(SNAPSHOT);
  const auth = (result.documents.instance as { auth_config: Record<string, unknown> }).auth_config;
  const find = (status: string, area: string) => result.report.filter((e) => e.status === status && e.area.startsWith(area));

  it('maps sign-in methods, sign-up and the password policy', () => {
    expect(auth).toMatchObject({
      strategies: { password: true, username: true, emailCode: true, phoneCode: true, passkey: true },
      requireEmailVerification: true,
      signUpMode: 'restricted',
      passwordPolicy: { minLength: 8, maxLength: 64, checkBreaches: true, rejectIdentifierSubstring: true },
    });
    const min = result.report.find((e) => e.setting === 'length.min')!;
    expect(min.status).toBe('differs');
    expect(min.note).toMatch(/at least 8/);
    expect(result.report.some((e) => e.setting.startsWith('rejects.repeatedIdentical') && e.status === 'differs')).toBe(true);
    expect(result.report.some((e) => e.setting === 'characterTypes.min' && e.status === 'differs')).toBe(true);
    expect(find('manual', 'sign-in experience').map((e) => e.setting)).toEqual(expect.arrayContaining(['agreeToTermsPolicy', 'customCss / customContent']));
  });

  it('maps multi-factor, with the mandatory policy as required MFA', () => {
    expect(auth).toMatchObject({ mfa: { factors: { totp: true, passkey: true } }, mfaPolicy: 'required' });
    const optional = translateLogtoConfig({ ...SNAPSHOT, signInExp: { ...SIGN_IN_EXP, mfa: { factors: ['Totp'], policy: 'UserControlled' } } });
    expect((optional.documents.instance as { auth_config: { mfaPolicy: string } }).auth_config.mfaPolicy).toBe('optional');
    expect(optional.report.some((e) => e.setting.startsWith('policy UserControlled') && e.status === 'differs')).toBe(true);
  });

  it('turns social connectors into providers with placeholder secrets and sends the rest to manual', () => {
    const providers = result.documents.oauth_providers as Array<Record<string, unknown>>;
    expect(providers.map((p) => p.provider)).toEqual(['google', 'github']);
    expect(providers[0]).toMatchObject({ client_id: 'gid', client_secret: '${GOOGLE_CLIENT_SECRET}', scopes: ['openid', 'email', 'profile'] });
    expect(providers[1]).toMatchObject({ client_id: 'ghid', client_secret: '${GITHUB_CLIENT_SECRET}' });
    expect(JSON.stringify(result)).not.toContain('sup3rsecret');
    expect(JSON.stringify(result)).not.toContain('SG.key');
    expect(result.env.map((e) => e.name)).toEqual(expect.arrayContaining(['GOOGLE_CLIENT_SECRET', 'GITHUB_CLIENT_SECRET']));
    expect(result.mappings.providers).toMatchObject({ Google: 'google' });
    expect(find('manual', 'connectors').map((e) => e.setting)).toEqual(['sendgrid-mail (Email)', 'wechat-web (wechat)']);
  });

  it('collects redirect URLs and origins from applications and flags M2M, SAML and protected apps', () => {
    expect(result.documents.redirect_urls).toEqual([{ url: 'https://app.acme.example/callback' }, { url: 'https://app.acme.example' }]);
    expect((result.documents.instance as { allowed_origins: string[] }).allowed_origins).toEqual(['https://app.acme.example']);
    expect(result.report.some((e) => e.setting === 'redirectUris https://*.acme.example/cb' && e.status === 'differs')).toBe(true);
    expect(result.report.some((e) => e.setting === 'redirectUris io.acme.app://cb' && e.note.includes('native'))).toBe(true);
    expect(find('manual', 'applications Worker')).toHaveLength(1);
    expect(find('manual', 'applications Docs proxy')).toHaveLength(1);
    expect(result.report.some((e) => e.setting.includes('idTokenTtl') && e.status === 'differs')).toBe(true);
  });

  it('maps API resources and roles, and reports webhooks and custom claims as manual', () => {
    expect(result.documents.resource_servers).toEqual([{ identifier: 'https://api.acme.example/billing', name: 'Billing API', scopes: ['read:invoices', 'write:invoices'] }]);
    expect(result.documents.roles).toEqual([{ key: 'billing_admin', name: 'Billing Admin', description: 'Manages billing', permissions: [] }]);
    expect(result.mappings.roles).toEqual({ 'Billing Admin': 'billing_admin' });
    expect(find('manual', 'webhooks')).toHaveLength(1);
    expect(find('manual', 'custom token claims')).toHaveLength(1);
    expect(find('differs', 'api resources')).toHaveLength(1);
  });

  it('hands the bridge and lazy steps the endpoint', () => {
    expect(result.origin).toBe(`Logto tenant default (${ENDPOINT})`);
    expect(result.bridge).toEqual({ preset: 'logto', vars: { base_url: ENDPOINT } });
    expect(result.lazy).toEqual({ preset: 'logto', config: { base_url: ENDPOINT } });
  });

  it('never gives a report entry without a note, and every mapped one names where it lands', () => {
    for (const e of result.report) {
      expect(e.note.length).toBeGreaterThan(0);
      if (e.status === 'mapped') expect(e.atlas).toBeTruthy();
    }
  });

  it('is quiet for a tenant with nothing configured', () => {
    const empty = translateLogtoConfig({ endpoint: ENDPOINT, tenantId: 'default', signInExp: {}, connectors: [], applications: [], resources: [], roles: [], hooks: [], jwtCustomizers: [] });
    expect(empty.documents).toEqual({});
    expect(empty.report.map((e) => e.area)).toEqual(['sessions']);
  });
});

describe('fetchLogtoConfig', () => {
  function http(routes: Record<string, unknown>) {
    const api = fakeVendor(ENDPOINT, routes);
    return { api, http: new VendorHttp({ vendor: 'Logto', baseUrl: ENDPOINT, headers: { authorization: 'Bearer t' }, fetchImpl: api.fetchImpl, sleep: noSleep }) };
  }

  it('reads the sign-in experience, connectors, applications, resources with scopes, user roles and hooks', async () => {
    const { api, http: client } = http({
      'GET /api/sign-in-exp': SIGN_IN_EXP,
      'GET /api/connectors': SNAPSHOT.connectors,
      'GET /api/applications': SNAPSHOT.applications,
      'GET /api/resources': [{ id: 'res1', name: 'Billing API', indicator: 'https://api.acme.example/billing' }],
      'GET /api/resources/res1/scopes': [{ name: 'read:invoices' }],
      'GET /api/roles': [{ id: 'r1', name: 'Billing Admin', type: 'User' }, { id: 'r2', name: 'M2M', type: 'MachineToMachine' }],
      'GET /api/hooks': SNAPSHOT.hooks,
      'GET /api/configs/jwt-customizer': [{ key: 'access-token' }],
    });
    const snap = await fetchLogtoConfig(client, ENDPOINT, 'default');
    expect(snap.signInExp.signInMode).toBe('SignIn');
    expect(snap.connectors).toHaveLength(4);
    expect(snap.resources[0]!.scopes).toEqual([{ name: 'read:invoices' }]);
    expect(snap.roles.map((r) => r.id)).toEqual(['r1']);
    expect(snap.jwtCustomizers).toHaveLength(1);
    expect(api.calls.some((c) => c.url.endsWith('/api/applications?page=1&page_size=100'))).toBe(true);
  });

  it('degrades to an empty snapshot when the token may not read anything', async () => {
    const { http: client } = http({});
    const snap = await fetchLogtoConfig(client, ENDPOINT, 'default');
    expect(snap).toMatchObject({ signInExp: {}, connectors: [], applications: [], resources: [], roles: [], hooks: [], jwtCustomizers: [] });
  });
});
