import { describe, expect, it } from 'vitest';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';
import { fusionAuthHttp } from './fusionauth';
import { fetchFusionAuthConfig, translateFusionAuthConfig, type FusionAuthConfigSnapshot } from './fusionauth-config';

const snap: FusionAuthConfigSnapshot = {
  baseUrl: 'https://auth.example.com',
  tenants: [
    {
      id: 't1',
      name: 'Default',
      issuer: 'acme.com',
      passwordValidationRules: { minLength: 10, maxLength: 128, requireMixedCase: true, requireNumber: true, requireNonAlpha: false, rememberPreviousPasswords: { enabled: true, count: 5 }, breachDetection: { enabled: true } },
      passwordEncryptionConfiguration: { encryptionScheme: 'salted-pbkdf2-hmac-sha256', encryptionSchemeFactor: 24000 },
      multiFactorConfiguration: { loginPolicy: 'Required', authenticator: { enabled: true }, email: { enabled: true }, sms: { enabled: true } },
      webAuthnConfiguration: { enabled: true, relyingPartyId: 'acme.com' },
      jwtConfiguration: { timeToLiveInSeconds: 3600, refreshTokenTimeToLiveInMinutes: 43200, refreshTokenExpirationPolicy: 'SlidingWindow' },
      failedAuthenticationConfiguration: { tooManyAttempts: 5 },
      emailConfiguration: { host: 'smtp.acme.com' },
    },
  ],
  applications: [
    {
      id: 'a1',
      name: 'Acme Web',
      registrationConfiguration: { enabled: false },
      verifyRegistration: true,
      oauthConfiguration: { authorizedRedirectURLs: ['https://app.acme.com/cb', 'https://*.acme.com/cb'], enabledGrants: ['authorization_code', 'client_credentials'] },
      roles: [{ name: 'admin' }, { name: 'Billing Manager' }],
    },
  ],
  identityProviders: [
    { id: 'i1', type: 'Google', name: 'Google', enabled: true, client_id: 'google-client' },
    { id: 'i2', type: 'SAMLv2', name: 'Partner', enabled: true },
    { id: 'i3', type: 'Steam', name: 'Steam', enabled: true },
  ],
  lambdas: [{ id: 'l1', name: 'populate', enabled: true }],
  webhooks: [{ id: 'w1', url: 'https://hooks.example.com', enabled: true }],
  themes: [],
};

describe('translateFusionAuthConfig', () => {
  const t = translateFusionAuthConfig(snap);
  const auth = (t.documents.instance as { auth_config: Record<string, any> }).auth_config;

  it('maps password rules, breach detection and history', () => {
    expect(auth.passwordPolicy).toMatchObject({ minLength: 10, maxLength: 128, requireUppercase: true, requireLowercase: true, requireNumber: true, historyCount: 5, checkBreaches: true });
    expect(auth.passwordPolicy.requireSymbol).toBeUndefined();
  });
  it('maps MFA policy, factors, passkeys and token lifetimes', () => {
    expect(auth.mfaPolicy).toBe('required');
    expect(auth.mfa.factors).toMatchObject({ totp: true, emailCode: true, sms: true, passkey: true });
    expect(auth.session).toMatchObject({ jwtTtlSeconds: 3600, absoluteMs: 43200 * 60_000, idleMs: 43200 * 60_000 });
  });
  it('closes sign-up, requires verification, keeps exact redirect URLs and flags wildcards', () => {
    expect(auth.signUpMode).toBe('restricted');
    expect(auth.requireEmailVerification).toBe(true);
    expect(t.documents.redirect_urls).toEqual([{ url: 'https://app.acme.com/cb' }]);
    expect(t.report.find((r) => r.setting.includes('*.acme.com'))?.status).toBe('differs');
  });
  it('creates roles, a Google provider without secrets, and notes for SSO and unsupported providers', () => {
    expect((t.documents.roles as Array<{ key: string }>).map((r) => r.key)).toEqual(['admin', 'billing_manager']);
    const google = (t.documents.oauth_providers as Array<Record<string, string>>)[0]!;
    expect(google).toMatchObject({ provider: 'google', client_id: 'google-client', client_secret: '${GOOGLE_CLIENT_SECRET}' });
    expect(t.report.find((r) => r.setting === 'Partner (SAMLv2)')?.atlas).toBe('sso_connections');
    expect(t.report.find((r) => r.setting === 'Steam (Steam)')?.status).toBe('manual');
  });
  it('reports lambdas, webhooks, mail, client credentials and SMS as manual or differs', () => {
    expect(t.report.filter((r) => r.status === 'manual').map((r) => r.area)).toEqual(expect.arrayContaining(['lambdas', 'webhooks', 'tenant Default']));
    expect(t.report.find((r) => r.setting.includes('client_credentials'))?.status).toBe('manual');
    expect(t.report.find((r) => r.setting === 'multiFactorConfiguration.sms')?.status).toBe('differs');
  });
  it('chooses the bridge preset by issuer shape and hands over the lazy base URL', () => {
    expect(t.bridge).toEqual({ preset: 'fusionauth', vars: { base_url: 'https://auth.example.com', issuer_name: 'acme.com' } });
    const url = translateFusionAuthConfig({ ...snap, tenants: [{ ...snap.tenants[0]!, issuer: 'https://auth.example.com' }] });
    expect(url.bridge?.preset).toBe('fusionauth_url_issuer');
    expect(t.lazy).toEqual({ preset: 'fusionauth', config: { base_url: 'https://auth.example.com' } });
  });
});

describe('fetchFusionAuthConfig', () => {
  it('reads each listing and skips the ones the key may not read', async () => {
    const origin = 'https://auth.example.com';
    const fake = fakeVendor(origin, {
      'GET /api/tenant': { tenants: [{ id: 't1', name: 'Default' }] },
      'GET /api/application': { applications: [] },
      'GET /api/identity-provider': { identityProviders: [] },
      'GET /api/lambda': { status: 403 },
    });
    const warnings: string[] = [];
    const s = await fetchFusionAuthConfig(fusionAuthHttp({ baseUrl: origin, apiKey: 'k', fetchImpl: fake.fetchImpl, sleep: noSleep }), origin, (m) => warnings.push(m));
    expect(s.tenants).toHaveLength(1);
    expect(s.lambdas).toEqual([]);
    expect(warnings.join('\n')).toMatch(/Lambdas could not be read/);
  });
});
