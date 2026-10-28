import { describe, expect, it } from 'vitest';
import { fetchFirebaseConfig, translateFirebaseConfig, type FirebaseConfigSnapshot } from './firebase-config';
import { firebaseHttp } from './firebase';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';

/** An Identity Toolkit admin v2 project config as GET …/config returns it. */
const CONFIG = {
  name: 'projects/demo-proj/config',
  signIn: {
    email: { enabled: true, passwordRequired: true },
    phoneNumber: { enabled: true, testPhoneNumbers: { '+15555550100': '123456' } },
    anonymous: { enabled: true },
    allowDuplicateEmails: false,
    hashConfig: { algorithm: 'SCRYPT', signerKey: 'c2s=', saltSeparator: 'Bw==', rounds: 8, memoryCost: 14 },
  },
  mfa: { state: 'ENABLED', enabledProviders: ['PHONE_SMS'], providerConfigs: [{ state: 'ENABLED', totpProviderConfig: { adjacentIntervals: 5 } }] },
  passwordPolicyConfig: {
    passwordPolicyEnforcementState: 'ENFORCE',
    forceUpgradeOnSignin: true,
    passwordPolicyVersions: [{ customStrengthOptions: { minPasswordLength: 10, maxPasswordLength: 64, containsUppercaseCharacter: true, containsNumericCharacter: true } }],
  },
  authorizedDomains: ['localhost', 'demo-proj.firebaseapp.com', 'demo-proj.web.app', 'app.example.com'],
  blockingFunctions: { triggers: { beforeCreate: { functionUri: 'https://us-central1-demo.cloudfunctions.net/beforeCreate' }, beforeSignIn: { functionUri: 'https://x' } } },
  emailPrivacyConfig: { enableImprovedEmailPrivacy: true },
  multiTenant: { allowTenants: true },
};

const SNAP: FirebaseConfigSnapshot = {
  projectId: 'demo-proj',
  config: CONFIG,
  defaultIdps: [
    { name: 'projects/demo-proj/defaultSupportedIdpConfigs/google.com', enabled: true, clientId: '123.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret' },
    { name: 'projects/demo-proj/defaultSupportedIdpConfigs/playgames.google.com', enabled: true, clientId: 'x' },
  ],
  oidcIdps: [{ name: 'projects/demo-proj/oauthIdpConfigs/oidc.corp-login', clientId: 'corp-client', issuer: 'https://login.corp.example', displayName: 'Corp', enabled: true, clientSecret: 'shh', responseType: { code: true } }],
  samlIdps: [{ name: 'projects/demo-proj/inboundSamlConfigs/saml.acme', displayName: 'Acme', enabled: true }],
  tenants: [{ name: 'projects/demo-proj/tenants/t-1', displayName: 'T1' }],
};

describe('translateFirebaseConfig', () => {
  const r = translateFirebaseConfig(SNAP);
  const auth = (r.documents.instance as { auth_config: Record<string, unknown> }).auth_config;

  it('maps sign-in methods, MFA and the password policy', () => {
    expect(auth.strategies).toMatchObject({ password: true, emailLink: false, phoneCode: true, anonymous: true });
    expect(auth.mfaPolicy).toBe('optional');
    expect(auth.mfa).toEqual({ factors: { sms: true, totp: true } });
    expect(auth.passwordPolicy).toEqual({ minLength: 10, maxLength: 64, requireUppercase: true, requireNumber: true });
  });

  it('turns providers into Atlas providers without copying secrets', () => {
    expect(r.documents.oauth_providers).toEqual([expect.objectContaining({ provider: 'google', client_id: '123.apps.googleusercontent.com', client_secret: '${GOOGLE_CLIENT_SECRET}' })]);
    expect(r.documents.custom_oauth_providers).toEqual([
      expect.objectContaining({ provider_key: 'corp_login', protocol: 'oidc', issuer: 'https://login.corp.example', discovery_url: 'https://login.corp.example/.well-known/openid-configuration', client_id: 'corp-client', client_secret: '${CORP_LOGIN_CLIENT_SECRET}' }),
    ]);
    expect(JSON.stringify(r.documents)).not.toMatch(/GOCSPX-secret|shh/);
    expect(r.mappings.providers).toMatchObject({ 'google.com': 'google', 'oidc.corp-login': 'corp_login' });
    expect(r.env.map((e) => e.name)).toEqual(expect.arrayContaining(['GOOGLE_CLIENT_SECRET', 'CORP_LOGIN_CLIENT_SECRET']));
  });

  it('reports every setting with its API path', () => {
    const line = (setting: string) => r.report.find((e) => e.setting === setting);
    expect(line('defaultSupportedIdpConfigs/playgames.google.com')?.status).toBe('manual');
    expect(line('inboundSamlConfigs/saml.acme')).toMatchObject({ status: 'mapped', atlas: 'sso_connections' });
    expect(line('mfa.providerConfigs.totpProviderConfig')?.status).toBe('differs');
    expect(line('mfa.providerConfigs.totpProviderConfig.adjacentIntervals')?.status).toBe('differs');
    expect(line('blockingFunctions.triggers.beforeCreate')?.status).toBe('manual');
    expect(line('signIn.phoneNumber.testPhoneNumbers')?.status).toBe('manual');
    expect(line('multiTenant.allowTenants')?.note).toMatch(/1 Identity Platform tenant/);
    expect(line('passwordPolicyConfig.forceUpgradeOnSignin')?.status).toBe('differs');
    expect(r.report.every((e) => !e.file)).toBe(true);
  });

  it('keeps custom authorized domains as allowed origins and names the bridge preset', () => {
    expect((r.documents.instance as { allowed_origins: string[] }).allowed_origins).toEqual(['http://localhost', 'https://app.example.com']);
    expect(r.bridge).toEqual({ preset: 'firebase', vars: { project_id: 'demo-proj' } });
    expect(r.origin).toBe('firebase project demo-proj');
  });

  it('treats a passwordless email project as email-link sign-in', () => {
    const out = translateFirebaseConfig({ ...SNAP, config: { signIn: { email: { enabled: true, passwordRequired: false } } }, defaultIdps: [], oidcIdps: [], samlIdps: [], tenants: [] });
    const a = (out.documents.instance as { auth_config: { strategies: Record<string, boolean> } }).auth_config;
    expect(a.strategies).toMatchObject({ password: false, emailLink: true });
    expect(out.report.find((e) => e.setting === 'passwordPolicyConfig')?.status).toBe('differs');
  });
});

describe('fetchFirebaseConfig', () => {
  it('reads the config and the provider lists, tolerating Identity Platform-only lists', async () => {
    const v = fakeVendor('https://identitytoolkit.googleapis.com', {
      'GET /v2/projects/demo-proj/config': CONFIG,
      'GET /v2/projects/demo-proj/defaultSupportedIdpConfigs?pageSize=100': { defaultSupportedIdpConfigs: SNAP.defaultIdps, nextPageToken: 'n2' },
      'GET /v2/projects/demo-proj/defaultSupportedIdpConfigs?pageSize=100&nextPageToken=n2': { defaultSupportedIdpConfigs: [] },
      'GET /v2/projects/demo-proj/oauthIdpConfigs?pageSize=100': { oauthIdpConfigs: SNAP.oidcIdps },
      'GET /v2/projects/demo-proj/inboundSamlConfigs?pageSize=100': { status: 403, body: { error: { message: 'Identity Platform required' } } },
    });
    const http = firebaseHttp({ accessToken: 'ya29.t', projectId: 'demo-proj', fetchImpl: v.fetchImpl, sleep: noSleep });
    const snap = await fetchFirebaseConfig(http, 'demo-proj');
    expect(snap.defaultIdps).toHaveLength(2);
    expect(snap.oidcIdps).toHaveLength(1);
    expect(snap.samlIdps).toEqual([]);
    expect(snap.tenants).toEqual([]);
    expect(v.calls[0]!.headers.get('x-goog-user-project')).toBe('demo-proj');
  });
});
