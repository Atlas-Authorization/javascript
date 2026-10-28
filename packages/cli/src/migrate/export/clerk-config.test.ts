import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { fetchClerkConfig, translateClerkConfig, type ClerkConfigSnapshot } from './clerk-config';
import { fakeVendor } from './fake-vendor.test-helper';
import { VendorApiError } from './vendor-http';

/**
 * Clerk responses as Clerk returns them: the Frontend API's public
 * `/v1/environment` document (what clerk-js loads with the publishable key)
 * and the Backend API's lists (bare arrays for JWT templates and redirect
 * URLs, `{ data, total_count }` for organization roles / permissions).
 */
const FAPI = 'clean-mole-12.clerk.accounts.dev';
const PK = `pk_test_${Buffer.from(`${FAPI}$`).toString('base64').replace(/=+$/, '')}`;
const FAPI_ENV = `GET https://${FAPI}/v1/environment`;

const ENV = {
  object: 'environment',
  id: 'env_2abcDEF',
  auth_config: { object: 'auth_config', id: 'aac_2abcDEF', single_session_mode: true, claimed_at: null, reverification: true },
  display_config: {
    object: 'display_config',
    id: 'display_config_2abcDEF',
    instance_environment_type: 'development',
    application_name: 'Acme',
    home_url: 'https://acme.example',
    sign_in_url: 'https://accounts.acme.example/sign-in',
    sign_up_url: 'https://accounts.acme.example/sign-up',
    user_profile_url: 'https://accounts.acme.example/user',
    after_sign_in_url: 'https://acme.example',
    branded: true,
  },
  user_settings: {
    attributes: {
      email_address: { enabled: true, required: true, used_for_first_factor: true, first_factors: ['email_code', 'email_link'], used_for_second_factor: false, second_factors: [], verifications: ['email_code'], verify_at_sign_up: true },
      phone_number: { enabled: true, required: false, used_for_first_factor: true, first_factors: ['phone_code'], used_for_second_factor: true, second_factors: ['phone_code'], verifications: ['phone_code'], verify_at_sign_up: true },
      username: { enabled: true, required: false, used_for_first_factor: true, first_factors: [], used_for_second_factor: false, second_factors: [], verifications: [], verify_at_sign_up: false },
      web3_wallet: { enabled: false, required: false, used_for_first_factor: false, first_factors: [], used_for_second_factor: false, second_factors: [], verifications: [], verify_at_sign_up: false },
      first_name: { enabled: true, required: true, used_for_first_factor: false, first_factors: [], used_for_second_factor: false, second_factors: [], verifications: [], verify_at_sign_up: false },
      last_name: { enabled: true, required: false, used_for_first_factor: false, first_factors: [], used_for_second_factor: false, second_factors: [], verifications: [], verify_at_sign_up: false },
      password: { enabled: true, required: true, used_for_first_factor: false, first_factors: [], used_for_second_factor: false, second_factors: [], verifications: [], verify_at_sign_up: false },
      authenticator_app: { enabled: true, required: false, used_for_first_factor: false, first_factors: [], used_for_second_factor: true, second_factors: ['totp'], verifications: ['totp'], verify_at_sign_up: false },
      backup_code: { enabled: true, required: false, used_for_first_factor: false, first_factors: [], used_for_second_factor: true, second_factors: ['backup_code'], verifications: [], verify_at_sign_up: false },
      passkey: { enabled: true, required: false, used_for_first_factor: true, first_factors: ['passkey'], used_for_second_factor: false, second_factors: [], verifications: ['passkey'], verify_at_sign_up: false },
    },
    sign_in: { second_factor: { required: false } },
    sign_up: { captcha_enabled: true, captcha_widget_type: 'smart', progressive: true, mode: 'waitlist', legal_consent_enabled: false },
    social: {
      oauth_google: { enabled: true, required: false, authenticatable: true, block_email_subaddresses: true, strategy: 'oauth_google', not_selectable: false, deprecated: false, name: 'Google', logo_url: 'https://img.clerk.com/static/google.png' },
      oauth_github: { enabled: true, required: false, authenticatable: false, block_email_subaddresses: false, strategy: 'oauth_github', not_selectable: false, deprecated: false, name: 'GitHub', logo_url: 'https://img.clerk.com/static/github.png' },
      oauth_apple: { enabled: false, required: false, authenticatable: true, block_email_subaddresses: false, strategy: 'oauth_apple', not_selectable: false, deprecated: false, name: 'Apple', logo_url: 'https://img.clerk.com/static/apple.png' },
      oauth_custom_acme: { enabled: true, required: false, authenticatable: true, block_email_subaddresses: false, strategy: 'oauth_custom_acme', not_selectable: false, deprecated: false, name: 'Acme SSO', logo_url: null },
      oauth_xero: { enabled: true, required: false, authenticatable: true, block_email_subaddresses: false, strategy: 'oauth_xero', not_selectable: false, deprecated: false, name: 'Xero', logo_url: 'https://img.clerk.com/static/xero.png' },
    },
    enterprise_sso: { enabled: true },
    password_settings: {
      disable_hibp: false,
      min_length: 6,
      max_length: 72,
      show_zxcvbn: false,
      min_zxcvbn_strength: 0,
      require_special_char: true,
      require_numbers: false,
      require_uppercase: false,
      require_lowercase: false,
      enforce_hibp_on_sign_in: false,
      allowed_special_characters: '!"#$%&\'()*+,-./:;<=>?@[]^_`{|}~',
    },
    username_settings: { min_length: 4, max_length: 64 },
    passkey_settings: { allow_autofill: true, show_sign_in_button: true },
  },
  organization_settings: {
    enabled: true,
    max_allowed_memberships: 5,
    force_organization_selection: false,
    actions: { admin_delete: true },
    domains: { enabled: true, enrollment_modes: ['manual_invitation', 'automatic_invitation'], default_role: 'org:member' },
    creator_role: 'org:admin',
  },
  maintenance_mode: false,
};

const PERMISSIONS = [
  { object: 'permission', id: 'perm_2a', name: 'Read invoices', key: 'org:invoices:read', description: 'View invoices', type: 'user', created_at: 1700000000000, updated_at: 1700000000000 },
  { object: 'permission', id: 'perm_2s', name: 'Manage members', key: 'org:sys_memberships:manage', description: 'Add and remove members', type: 'system', created_at: 1700000000000, updated_at: 1700000000000 },
];
const ROLES = [
  {
    object: 'role',
    id: 'role_2a',
    name: 'Admin',
    key: 'org:admin',
    description: 'Full access',
    is_creator_eligible: true,
    permissions: [
      { object: 'permission', id: 'perm_2a', key: 'org:invoices:read', name: 'Read invoices' },
      { object: 'permission', id: 'perm_2s', key: 'org:sys_memberships:manage', name: 'Manage members' },
    ],
    created_at: 1700000000000,
    updated_at: 1700000000000,
  },
  { object: 'role', id: 'role_2b', name: 'Billing Admin', key: 'org:billing_admin', description: null, is_creator_eligible: false, permissions: [{ object: 'permission', id: 'perm_2a', key: 'org:invoices:read', name: 'Read invoices' }], created_at: 1700000000000, updated_at: 1700000000000 },
];
const JWT_TEMPLATES = [
  {
    object: 'jwt_template',
    id: 'jtmp_2a',
    name: 'supabase',
    claims: { aud: 'authenticated', role: 'authenticated', email: '{{user.primary_email_address}}' },
    lifetime: 3600,
    allowed_clock_skew: 5,
    custom_signing_key: true,
    signing_algorithm: 'HS256',
    created_at: 1700000000000,
    updated_at: 1700000000000,
  },
  { object: 'jwt_template', id: 'jtmp_2b', name: 'hasura', claims: { 'https://hasura.io/jwt/claims': { 'x-hasura-user-id': '{{user.id}}' } }, lifetime: 60, allowed_clock_skew: 5, custom_signing_key: false, signing_algorithm: 'RS256', created_at: 1700000000000, updated_at: 1700000000000 },
];
const REDIRECT_URLS = [{ object: 'redirect_url', id: 'ru_2a', url: 'myapp://oauth-callback', created_at: 1700000000000, updated_at: 1700000000000 }];

const FULL: ClerkConfigSnapshot = { frontendApi: FAPI, environment: ENV, jwtTemplates: JWT_TEMPLATES, redirectUrls: REDIRECT_URLS, roles: ROLES, permissions: PERMISSIONS };

describe('fetchClerkConfig', () => {
  it('reads only the public environment document with just the publishable key', async () => {
    const api = fakeVendor('https://api.clerk.com', { [FAPI_ENV]: ENV });
    const snap = await fetchClerkConfig({ publishableKey: PK, fetchImpl: api.fetchImpl });
    expect(snap).toEqual({ frontendApi: FAPI, environment: ENV });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.url).toBe(`https://${FAPI}/v1/environment`);
    expect(api.calls[0]!.headers.get('authorization')).toBeNull();
  });

  it('adds the Backend API lists with the secret key as a Bearer token, tolerating 403/404', async () => {
    const api = fakeVendor('https://api.clerk.com', {
      [FAPI_ENV]: ENV,
      'GET /v1/jwt_templates': JWT_TEMPLATES,
      'GET /v1/redirect_urls': REDIRECT_URLS,
      'GET /v1/organization_roles?limit=500': { status: 403, body: { errors: [{ message: 'not enabled', long_message: 'Organizations are not enabled for this instance', code: 'organizations_not_enabled' }] } },
      // organization_permissions is unrouted → 404
    });
    const snap = await fetchClerkConfig({ publishableKey: PK, secretKey: 'sk_test_abc123', fetchImpl: api.fetchImpl });
    expect(snap.frontendApi).toBe(FAPI);
    expect(snap.jwtTemplates).toEqual(JWT_TEMPLATES);
    expect(snap.redirectUrls).toEqual(REDIRECT_URLS);
    expect(snap.roles).toEqual([]);
    expect(snap.permissions).toEqual([]);
    const bapi = api.calls.filter((c) => c.url.startsWith('https://api.clerk.com/'));
    expect(bapi.map((c) => c.url)).toEqual([
      'https://api.clerk.com/v1/jwt_templates',
      'https://api.clerk.com/v1/redirect_urls',
      'https://api.clerk.com/v1/organization_roles?limit=500',
      'https://api.clerk.com/v1/organization_permissions?limit=500',
    ]);
    for (const c of bapi) expect(c.headers.get('authorization')).toBe('Bearer sk_test_abc123');
    expect(api.calls.find((c) => c.url.includes(FAPI))!.headers.get('authorization')).toBeNull();
  });

  it('unwraps { data, total_count } lists', async () => {
    const api = fakeVendor('https://api.clerk.com', {
      [FAPI_ENV]: ENV,
      'GET /v1/organization_roles?limit=500': { data: ROLES, total_count: 2 },
      'GET /v1/organization_permissions?limit=500': { data: PERMISSIONS, total_count: 2 },
    });
    const snap = await fetchClerkConfig({ publishableKey: PK, secretKey: 'sk_test_abc123', fetchImpl: api.fetchImpl });
    expect(snap.roles).toEqual(ROLES);
    expect(snap.permissions).toEqual(PERMISSIONS);
    expect(snap.jwtTemplates).toEqual([]);
  });

  it('rethrows other Backend API errors (a revoked secret key)', async () => {
    const api = fakeVendor('https://api.clerk.com', {
      [FAPI_ENV]: ENV,
      'GET /v1/jwt_templates': { status: 401, body: { errors: [{ message: 'Unauthorized', long_message: 'The provided Clerk Secret Key is invalid.', code: 'authentication_invalid' }] } },
    });
    const err = await fetchClerkConfig({ publishableKey: PK, secretKey: 'sk_test_revoked', fetchImpl: api.fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VendorApiError);
    expect((err as VendorApiError).status).toBe(401);
    expect((err as VendorApiError).message).toContain('Clerk API 401 on /v1/jwt_templates');
  });

  it('refuses something that is not a publishable key, before any request', async () => {
    const api = fakeVendor('https://api.clerk.com', {});
    await expect(fetchClerkConfig({ publishableKey: 'sk_test_abc123', fetchImpl: api.fetchImpl })).rejects.toThrow(/not a Clerk publishable key/);
    // valid base64, but the decoded value lacks the trailing `$`
    const noDollar = `pk_live_${Buffer.from(FAPI).toString('base64').replace(/=+$/, '')}`;
    await expect(fetchClerkConfig({ publishableKey: noDollar, fetchImpl: api.fetchImpl })).rejects.toThrow(/not a Clerk publishable key/);
    expect(api.calls).toHaveLength(0);
  });
});

describe('translateClerkConfig', () => {
  it('builds auth_config from the environment document', () => {
    const r = translateClerkConfig(FULL);
    expect(r.origin).toBe(`Clerk instance ${FAPI}`);
    expect(r.documents.instance).toEqual({
      auth_config: {
        strategies: { emailCode: true, emailLink: true, phoneCode: true, username: true, password: true, passkey: true },
        requireEmailVerification: true,
        accountUx: { username: { minLength: 4, maxLength: 64 } },
        mfa: { factors: { totp: true } },
        signUpMode: 'restricted',
        passwordPolicy: { minLength: 8, maxLength: 72, checkBreaches: true },
        session: { multiSession: false },
        organizations: { defaultMaxAllowedMemberships: 5, allowDeletionFromApp: true, creatorRole: 'org:admin' },
      },
    });
    expect(r.bridge).toEqual({ preset: 'clerk', vars: { frontend_api: FAPI } });
    expect(r.lazy).toBeUndefined();
  });

  it('reports attributes, factors, sign-up mode and password rules with their statuses', () => {
    const { report } = translateClerkConfig(FULL);
    expect(report).toContainEqual({
      status: 'mapped',
      area: 'user & authentication',
      setting: 'attributes.email_address.first_factors',
      note: 'Email sign-in: email_code, email_link.',
      atlas: 'auth_config.strategies.emailCode / emailLink',
    });
    expect(report).toContainEqual(expect.objectContaining({ status: 'differs', setting: 'attributes.passkey', atlas: 'auth_config.strategies.passkey' }));
    expect(report).toContainEqual(expect.objectContaining({ status: 'manual', setting: 'attributes.first_name.required', atlas: 'auth_config.identityTraits' }));
    expect(report.find((e) => e.setting === 'attributes.last_name.required')).toBeUndefined();
    expect(report.find((e) => e.setting === 'attributes.web3_wallet')).toBeUndefined();
    expect(report).toContainEqual(expect.objectContaining({ status: 'differs', area: 'multi-factor', setting: 'attributes.phone_number.used_for_second_factor', atlas: 'auth_config.mfa' }));
    expect(report).toContainEqual(expect.objectContaining({ status: 'mapped', area: 'multi-factor', setting: 'attributes.backup_code', atlas: 'auth_config.mfa.backupCodes' }));
    expect(report.find((e) => e.setting === 'sign_in.second_factor.required')).toBeUndefined();
    expect(report).toContainEqual(expect.objectContaining({ status: 'differs', area: 'restrictions', setting: 'sign_up.mode', atlas: 'auth_config.signUpMode' }));
    expect(report).toContainEqual({
      status: 'differs',
      area: 'password',
      setting: 'password_settings.min_length',
      note: 'Clerk allows 6; Atlas requires at least 8 (existing passwords still sign in).',
      atlas: 'auth_config.passwordPolicy.minLength',
    });
    expect(report).toContainEqual(expect.objectContaining({ status: 'mapped', setting: 'password_settings.max_length', note: '72.' }));
    expect(report).toContainEqual(expect.objectContaining({ status: 'mapped', setting: 'password_settings.disable_hibp', note: 'Breached passwords are refused.' }));
    expect(report).toContainEqual(expect.objectContaining({ status: 'differs', setting: 'password_settings.require_special_char' }));
    expect(report.find((e) => e.setting === 'password_settings.require_numbers')).toBeUndefined();
    expect(report).toContainEqual(expect.objectContaining({ status: 'mapped', area: 'sessions', setting: 'auth_config.single_session_mode', note: 'One signed-in account per browser.' }));
    expect(report).toContainEqual(expect.objectContaining({ status: 'manual', area: 'sessions', setting: 'session lifetime / inactivity timeout', atlas: 'auth_config.session' }));
  });

  it('turns enabled social strategies into oauth_providers with placeholder credentials', () => {
    const r = translateClerkConfig(FULL);
    expect(r.documents.oauth_providers).toEqual([
      { provider: 'google', enabled: true, allow_sign_in: true, allow_sign_up: true, client_id: '${GOOGLE_CLIENT_ID}', client_secret: '${GOOGLE_CLIENT_SECRET}' },
      { provider: 'github', enabled: true, allow_sign_in: true, allow_sign_up: false, client_id: '${GITHUB_CLIENT_ID}', client_secret: '${GITHUB_CLIENT_SECRET}' },
    ]);
    expect(r.env).toEqual([
      { name: 'GOOGLE_CLIENT_ID', for: 'oauth_google client id' },
      { name: 'GOOGLE_CLIENT_SECRET', for: 'oauth_google client secret' },
      { name: 'GITHUB_CLIENT_ID', for: 'oauth_github client id' },
      { name: 'GITHUB_CLIENT_SECRET', for: 'oauth_github client secret' },
    ]);
    expect(r.mappings.providers).toEqual({ oauth_google: 'google', oauth_github: 'github' });
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'manual', area: 'SSO connections', setting: 'social.oauth_google', atlas: 'oauth_providers google' }));
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'differs', setting: 'social.oauth_github.authenticatable', atlas: 'oauth_providers github' }));
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'manual', setting: 'social.oauth_custom_acme', atlas: 'custom_oauth_providers', note: expect.stringContaining('Custom OAuth provider "Acme SSO"') }));
    expect(r.report).toContainEqual({
      status: 'manual',
      area: 'SSO connections',
      setting: 'social.oauth_xero',
      note: '"Xero" is not a built-in Atlas provider; add it as a custom OAuth provider.',
      atlas: 'custom_oauth_providers',
    });
    expect(r.report.find((e) => e.setting.startsWith('social.oauth_apple'))).toBeUndefined();
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'mapped', setting: 'enterprise_sso', atlas: 'sso_connections' }));
    expect(r.documents.custom_oauth_providers).toBeUndefined();
  });

  it('maps organization settings, roles, permissions, JWT templates and redirect URLs', () => {
    const r = translateClerkConfig(FULL);
    expect(r.documents.permissions).toEqual([{ key: 'invoices:read', name: 'Read invoices', description: 'View invoices' }]);
    expect(r.documents.roles).toEqual([
      { key: 'org:admin', name: 'Admin', description: 'Full access', permissions: ['invoices:read', 'sys_memberships:manage'] },
      { key: 'org:billing_admin', name: 'Billing Admin', description: '', permissions: ['invoices:read'] },
    ]);
    expect(r.mappings.roles).toEqual({ 'org:admin': 'org:admin', 'org:billing_admin': 'org:billing_admin' });
    expect(r.documents.jwt_templates).toEqual([
      { name: 'supabase', claims: JWT_TEMPLATES[0]!.claims, lifetime: 3600, allowed_clock_skew: 5 },
      { name: 'hasura', claims: JWT_TEMPLATES[1]!.claims, lifetime: 60, allowed_clock_skew: 5 },
    ]);
    expect(r.documents.redirect_urls).toEqual([{ url: 'myapp://oauth-callback' }]);
    const report = r.report;
    expect(report).toContainEqual(expect.objectContaining({ status: 'mapped', setting: 'organization_permissions', note: "1 custom permission(s); Clerk's system permissions are built into Atlas." }));
    expect(report).toContainEqual(expect.objectContaining({ status: 'mapped', setting: 'organization_roles', note: '2 role(s), same keys.' }));
    expect(report).toContainEqual(expect.objectContaining({ status: 'differs', area: 'JWT templates', setting: 'jwt_templates.supabase', atlas: 'jwt_templates supabase' }));
    expect(report).toContainEqual(expect.objectContaining({ status: 'mapped', area: 'JWT templates', setting: 'jwt_templates.hasura' }));
    expect(report).toContainEqual(expect.objectContaining({ status: 'mapped', area: 'paths', setting: 'redirect_urls' }));
    expect(report).toContainEqual(expect.objectContaining({ status: 'mapped', setting: 'organization_settings.domains', note: 'Verified domains (manual_invitation, automatic_invitation) move with each organization.' }));
    expect(report).toContainEqual(expect.objectContaining({ status: 'mapped', setting: 'organization_settings.creator_role', note: 'Creators are seated as org:admin.' }));
    expect(report).toContainEqual(expect.objectContaining({ status: 'differs', area: 'paths', setting: 'display_config.sign_in_url', atlas: 'NEXT_PUBLIC_ATLAS_SIGN_IN_URL' }));
    expect(report).toContainEqual(expect.objectContaining({ status: 'differs', area: 'paths', setting: 'display_config.sign_up_url', atlas: 'NEXT_PUBLIC_ATLAS_SIGN_UP_URL' }));
  });

  it('handles a bare environment: public sign-up, no password, no documents beyond auth_config', () => {
    const r = translateClerkConfig({ frontendApi: FAPI, environment: {} });
    expect(r.documents).toEqual({ instance: { auth_config: { strategies: { password: false }, mfa: { factors: { totp: false } }, signUpMode: 'public' } } });
    expect(r.report).toEqual([
      { status: 'mapped', area: 'restrictions', setting: 'sign_up.mode', note: 'Public sign-up.', atlas: 'auth_config.signUpMode' },
      expect.objectContaining({ status: 'manual', area: 'sessions', setting: 'session lifetime / inactivity timeout' }),
    ]);
    expect(r.env).toEqual([]);
    expect(r.mappings).toEqual({ providers: {}, roles: {} });
  });

  it('maps restricted sign-up, required MFA, a long-enough password and an object creator role', () => {
    const r = translateClerkConfig({
      frontendApi: FAPI,
      environment: {
        auth_config: { object: 'auth_config', single_session_mode: false },
        user_settings: {
          attributes: { password: { enabled: true, required: true } },
          sign_in: { second_factor: { required: true } },
          sign_up: { mode: 'restricted', progressive: true },
          password_settings: { min_length: 10, max_length: 0, disable_hibp: true },
        },
        organization_settings: { enabled: true, max_allowed_memberships: 0, creator_role: { key: 'admin', name: 'Admin' } },
      },
    });
    expect(r.documents.instance).toEqual({
      auth_config: {
        strategies: { password: true },
        mfa: { factors: { totp: false } },
        mfaPolicy: 'required',
        signUpMode: 'restricted',
        passwordPolicy: { minLength: 10, checkBreaches: false },
        session: { multiSession: true },
        organizations: { creatorRole: 'org:admin' },
      },
    });
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'mapped', setting: 'sign_up.mode', note: 'Sign-up by invitation / allowlist only.' }));
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'mapped', setting: 'sign_in.second_factor.required', atlas: 'auth_config.mfaPolicy' }));
    expect(r.report).toContainEqual(expect.objectContaining({ status: 'mapped', setting: 'password_settings.min_length', note: '10.' }));
    expect(r.report).toContainEqual(expect.objectContaining({ setting: 'password_settings.disable_hibp', note: 'Breached-password check off.' }));
    expect(r.report).toContainEqual(expect.objectContaining({ setting: 'auth_config.single_session_mode', note: 'Multi-session (account switching).' }));
    expect(r.report.find((e) => e.setting === 'password_settings.max_length')).toBeUndefined();
    expect(r.report.find((e) => e.setting === 'organization_settings.max_allowed_memberships')).toBeUndefined();
  });
});
