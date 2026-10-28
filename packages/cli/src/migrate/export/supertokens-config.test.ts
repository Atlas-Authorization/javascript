import { describe, expect, it } from 'vitest';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';
import { fetchSupertokensConfig, translateSupertokensConfig } from './supertokens-config';
import { supertokensHttp } from './supertokens';

/** The core's `/recipe/multitenancy/tenant/list/v2` as a v6 core answers it. */
const ORIGIN = 'https://st-dev-1234.aws.supertokens.io';

const PUBLIC = {
  tenantId: 'public',
  emailPassword: { enabled: true },
  thirdParty: {
    enabled: true,
    providers: [
      { thirdPartyId: 'google', name: 'Google', clients: [{ clientId: 'gid', clientSecret: 'sup3rsecret', scope: ['email', 'profile'], forcePKCE: false }] },
      { thirdPartyId: 'okta', name: 'Okta', clients: [{ clientId: 'oid', clientSecret: 'sup3rsecret2' }] },
    ],
  },
  passwordless: { enabled: true },
  firstFactors: ['emailpassword', 'thirdparty', 'otp-email', 'link-email', 'otp-phone'],
  requiredSecondaryFactors: ['totp'],
  coreConfig: { access_token_validity: 3600, refresh_token_validity: 144000, passwordless_code_lifetime: 900000, passwordless_max_code_input_attempts: 5, password_reset_token_lifetime: 3600000, totp_max_attempts: 5 },
};
const ACME = { tenantId: 'acme', emailPassword: { enabled: false }, thirdParty: { enabled: true, providers: [] }, passwordless: { enabled: false }, firstFactors: ['thirdparty'], requiredSecondaryFactors: [], coreConfig: {} };

describe('translateSupertokensConfig', () => {
  const result = translateSupertokensConfig({ origin: ORIGIN, appId: 'public', tenants: [PUBLIC, ACME] });
  const auth = (result.documents.instance as { auth_config: Record<string, unknown> }).auth_config;
  const find = (status: string, area: string) => result.report.filter((e) => e.status === status && e.area.startsWith(area));

  it('maps the enabled recipes and first factors', () => {
    expect(auth).toMatchObject({ strategies: { password: true, emailCode: true, emailLink: true, phoneCode: true } });
    expect(result.report.find((e) => e.setting === 'emailPassword.enabled')!.note).toMatch(/never returns password hashes/);
  });

  it('maps the required secondary factors to the MFA policy', () => {
    expect(auth).toMatchObject({ mfa: { factors: { totp: true } }, mfaPolicy: 'required' });
    expect(find('differs', 'recipes multifactorauth')).toHaveLength(1);
  });

  it('maps the core configuration and clamps the session to 90 days', () => {
    expect(auth).toMatchObject({ session: { absoluteMs: 90 * 24 * 60 * 60_000 }, verification: { emailCode: { ttlMinutes: 15, maxAttempts: 5 } } });
    expect(result.report.some((e) => e.setting === 'access_token_validity' && e.status === 'differs')).toBe(true);
    expect(result.report.some((e) => e.setting === 'refresh_token_validity' && e.status === 'mapped')).toBe(true);
  });

  it('turns third-party providers into placeholders-only providers and sends unknown ones to manual', () => {
    const providers = result.documents.oauth_providers as Array<Record<string, unknown>>;
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({ provider: 'google', client_id: 'gid', client_secret: '${GOOGLE_CLIENT_SECRET}', scopes: ['email', 'profile'] });
    expect(JSON.stringify(result)).not.toContain('sup3rsecret');
    expect(find('manual', 'recipes thirdparty').map((e) => e.setting)).toEqual(['Okta (okta)']);
  });

  it('reports other tenants and the code the core never sees', () => {
    expect(find('differs', 'tenants acme')).toHaveLength(1);
    expect(find('manual', 'backend config').map((e) => e.setting)).toEqual(expect.arrayContaining(['supertokens.init override functions', 'EmailVerification mode (REQUIRED / OPTIONAL)']));
    for (const e of result.report) {
      expect(e.note.length).toBeGreaterThan(0);
      if (e.status === 'mapped') expect(e.atlas).toBeTruthy();
    }
  });

  it('hands the lazy step the core address, and leaves the bridge to the app\'s own api domain', () => {
    expect(result.lazy).toEqual({ preset: 'supertokens', config: { base_url: ORIGIN } });
    expect(result.bridge).toBeUndefined();
    expect(result.origin).toBe(`SuperTokens core ${ORIGIN} (app public)`);
  });

  it('reads an older core without first factors from the recipes\' enabled flags', () => {
    const legacy = translateSupertokensConfig({ origin: ORIGIN, appId: 'public', tenants: [{ tenantId: 'public', emailPassword: { enabled: true }, passwordless: { enabled: false }, thirdParty: { enabled: false } }] });
    const a = (legacy.documents.instance as { auth_config: Record<string, unknown> }).auth_config;
    expect(a).toMatchObject({ strategies: { password: true } });
    expect(a.mfaPolicy).toBeUndefined();
    expect((a.session as { absoluteMs: number }).absoluteMs).toBe(90 * 24 * 60 * 60_000);
  });

  it('says so when the core returned no tenants', () => {
    const none = translateSupertokensConfig({ origin: ORIGIN, appId: 'public', tenants: [] });
    expect(none.report.some((e) => e.status === 'manual' && e.area === 'core')).toBe(true);
  });
});

describe('fetchSupertokensConfig', () => {
  const client = (routes: Record<string, unknown>) => {
    const api = fakeVendor(ORIGIN, routes);
    return { api, http: supertokensHttp({ connectionUri: ORIGIN, apiKey: 'k', fetchImpl: api.fetchImpl, sleep: noSleep }) };
  };

  it('reads the v2 tenant list with the API key', async () => {
    const { api, http } = client({ 'GET /recipe/multitenancy/tenant/list/v2': { status: 'OK', tenants: [PUBLIC, ACME] } });
    const snap = await fetchSupertokensConfig(http, ORIGIN, 'public');
    expect(snap.tenants).toHaveLength(2);
    expect(api.calls[0]!.headers.get('api-key')).toBe('k');
  });

  it('falls back to the v1 list, then to the single public tenant', async () => {
    const v1 = client({ 'GET /recipe/multitenancy/tenant/list': { status: 'OK', tenants: [PUBLIC] } });
    expect((await fetchSupertokensConfig(v1.http, ORIGIN, 'public')).tenants).toHaveLength(1);
    const single = client({ 'GET /recipe/multitenancy/tenant': { status: 'OK', ...PUBLIC } });
    expect((await fetchSupertokensConfig(single.http, ORIGIN, 'public')).tenants).toEqual([expect.objectContaining({ tenantId: 'public' })]);
    const none = client({});
    expect((await fetchSupertokensConfig(none.http, ORIGIN, 'public')).tenants).toEqual([]);
  });
});
