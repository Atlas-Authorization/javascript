import { describe, expect, it } from 'vitest';
import { fetchFronteggConfig, translateFronteggConfig, type FronteggConfigSnapshot } from './frontegg-config';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';

const API = 'https://api.frontegg.com';
const EMPTY: FronteggConfigSnapshot = {
  clientId: 'cid',
  region: 'eu',
  configuration: null,
  password: null,
  mfaPolicy: null,
  lockout: null,
  sessions: null,
  roles: [],
  permissions: [],
  customProviders: [],
  applications: [],
  jwtTemplates: [],
  domainRestrictions: null,
};

describe('fetchFronteggConfig', () => {
  it('reads each configuration area the environment exposes and leaves the rest null', async () => {
    const api = fakeVendor(API, {
      'POST /auth/vendor': { token: 't', expiresIn: 3600 },
      'GET /identity/resources/configurations/v1': { authStrategy: 'EmailAndPassword', allowSignups: true },
      'GET /identity/resources/configurations/v1/mfa-policy': { enforceMFAType: 'Force' },
      'GET /identity/resources/roles/v2?_limit=200&_offset=0': { items: [{ id: 'r1', key: 'Admin' }], _metadata: { totalPages: 1 } },
      'GET /identity/resources/permissions/v1': [{ id: 'p1', key: 'billing.read' }],
      'GET /applications/resources/applications/v1': [{ id: 'a1', appURL: 'https://app.example' }],
      // A plan without the lockout policy answers 403: nothing there, not a failure.
      'GET /identity/resources/configurations/v1/lockout-policy': { status: 403, body: { message: 'forbidden' } },
    });
    const snap = await fetchFronteggConfig({ clientId: 'cid', apiKey: 'k', fetchImpl: api.fetchImpl, sleep: noSleep });
    expect(snap).toEqual({
      ...EMPTY,
      configuration: { authStrategy: 'EmailAndPassword', allowSignups: true },
      mfaPolicy: { enforceMFAType: 'Force' },
      roles: [{ id: 'r1', key: 'Admin' }],
      permissions: [{ id: 'p1', key: 'billing.read' }],
      applications: [{ id: 'a1', appURL: 'https://app.example' }],
    });
  });

  it('lets a refused management login through as an error', async () => {
    const api = fakeVendor(API, { 'POST /auth/vendor': { status: 401, body: { message: 'bad secret' } } });
    await expect(fetchFronteggConfig({ clientId: 'cid', apiKey: 'k', fetchImpl: api.fetchImpl, sleep: noSleep })).rejects.toThrow(/401/);
  });
});

describe('translateFronteggConfig', () => {
  const SNAP: FronteggConfigSnapshot = {
    ...EMPTY,
    configuration: {
      authStrategy: 'EmailAndPassword',
      allowSignups: false,
      defaultTokenExpiration: 3600,
      defaultRefreshTokenExpiration: 604800,
      jwtAlgorithm: 'HS256',
      rotateRefreshTokens: true,
      apiTokensEnabled: true,
    },
    password: { minLength: 6, blockPwnedPasswords: true, requiredTests: { upperCase: true } },
    lockout: { enabled: true, maxAttempts: 5 },
    mfaPolicy: { enforceMFAType: 'Force' },
    sessions: {
      sessionIdleTimeoutConfiguration: { isActive: true, timeout: 1800 },
      sessionTimeoutConfiguration: { isActive: true, timeout: 86400 },
      sessionConcurrentConfiguration: { isActive: true, maxSessions: 3 },
    },
    permissions: [{ id: 'p1', key: 'billing.read', name: 'Read billing' }],
    roles: [
      { id: 'r1', key: 'Admin', name: 'Admin', permissions: ['p1'] },
      { id: 'r2', key: 'Local', tenantId: 't1' },
    ],
    customProviders: [{ displayName: 'Acme IdP', clientId: 'abc', authorizationUrl: 'https://idp.example/auth', tokenUrl: 'https://idp.example/token', userInfoUrl: 'https://idp.example/me', scopes: ['openid'], active: true }],
    applications: [
      { appURL: 'https://app.example', loginURL: 'https://login.example/x' },
      { appURL: 'https://app.example' },
    ],
    jwtTemplates: [{ id: 'j1' }],
    domainRestrictions: { active: true },
  };
  const entry = (t: ReturnType<typeof translateFronteggConfig>, setting: string) => t.report.find((r) => r.setting === setting);

  it('maps the sign-in method, password, MFA and session settings into auth_config', () => {
    const t = translateFronteggConfig(SNAP);
    expect(t.origin).toBe('Frontegg environment (eu)');
    expect(t.documents.instance).toEqual({
      auth_config: {
        strategies: { password: true },
        passwordPolicy: { minLength: 8, checkBreaches: true },
        mfaPolicy: 'required',
        // The session lifetime wins over the refresh-token lifetime.
        session: { absoluteMs: 86_400_000, idleMs: 1_800_000 },
      },
    });
    expect(entry(t, 'authStrategy')).toMatchObject({ status: 'differs', atlas: 'auth_config.strategies.password' });
    expect(entry(t, 'minLength')).toMatchObject({ status: 'differs', atlas: 'auth_config.passwordPolicy.minLength' });
    expect(entry(t, 'enforceMFAType')).toMatchObject({ status: 'mapped', atlas: 'auth_config.mfaPolicy' });
    expect(entry(t, 'lockout-policy')).toMatchObject({ status: 'mapped' });
  });

  it('reports what has no Atlas equivalent as manual with where to act', () => {
    const t = translateFronteggConfig(SNAP);
    for (const setting of ['allowSignups', 'jwtAlgorithm', 'apiTokensEnabled', 'sessionConcurrentConfiguration', 'JWT templates', 'email domain restrictions']) {
      expect(entry(t, setting), setting).toMatchObject({ status: 'manual' });
    }
    expect(t.report.filter((r) => r.area === 'settings not in the API').map((r) => r.note).every((n) => /Frontegg portal/.test(n))).toBe(true);
  });

  it('translates roles, permissions, custom providers and application URLs', () => {
    const t = translateFronteggConfig(SNAP);
    expect(t.documents.permissions).toEqual([{ key: 'billing.read', name: 'Read billing', description: '' }]);
    expect(t.documents.roles).toEqual([{ key: 'admin', name: 'Admin', description: '', permissions: ['billing.read'] }]);
    expect(t.mappings.roles).toEqual({ Admin: 'admin' });
    expect(entry(t, 'account-specific roles')).toMatchObject({ status: 'differs' });
    expect(t.documents.custom_oauth_providers).toEqual([
      {
        key: 'acme_idp',
        name: 'Acme IdP',
        enabled: true,
        client_id: 'abc',
        client_secret: '${ACME_IDP_CLIENT_SECRET}',
        authorization_url: 'https://idp.example/auth',
        token_url: 'https://idp.example/token',
        userinfo_url: 'https://idp.example/me',
        scopes: ['openid'],
      },
    ]);
    expect(t.env).toEqual([{ name: 'ACME_IDP_CLIENT_SECRET', for: 'Acme IdP client secret' }]);
    expect(t.documents.redirect_urls).toEqual([{ url: 'https://app.example' }, { url: 'https://login.example/x' }]);
    expect(entry(t, 'multiple applications')).toMatchObject({ status: 'manual' });
  });

  it('offers the lazy preset always and the bridge once the Frontegg domain is known', () => {
    expect(translateFronteggConfig(SNAP).bridge).toBeUndefined();
    const t = translateFronteggConfig(SNAP, 'https://app-demo.frontegg.com');
    expect(t.bridge).toEqual({ preset: 'frontegg', vars: { base_url: 'https://app-demo.frontegg.com' } });
    expect(t.lazy).toEqual({ preset: 'frontegg', config: { client_id: 'cid', region: 'eu' } });
  });

  it('degrades to manual lines when nothing could be read', () => {
    const t = translateFronteggConfig(EMPTY);
    expect(t.documents).toEqual({});
    expect(entry(t, 'configurations/v1')).toMatchObject({ status: 'manual' });
    expect(t.report.some((r) => r.area === 'social login' && r.status === 'manual')).toBe(true);
  });
});
