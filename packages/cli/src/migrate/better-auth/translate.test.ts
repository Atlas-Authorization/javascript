import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeBetterAuth } from '@atlasauth/upgrade';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderReport, reportCounts, writeTranslation } from './output';
import { translateBetterAuth, type ReportEntry, type Translation } from './translate';

/**
 * The translator over the fixture Better Auth projects (fixtures/better-auth/*):
 * targeted assertions on the mapping, plus a snapshot of the whole config
 * document and report so any change to the translation is reviewed.
 */
const FIXTURES = join(__dirname, '..', '..', '..', 'fixtures', 'better-auth');
const translate = (name: string): Translation => translateBetterAuth(analyzeBetterAuth(join(FIXTURES, name)));
const find = (t: Translation, option: string): ReportEntry | undefined => t.report.find((e) => e.option === option);
const ac = (t: Translation) => t.document.instance.auth_config as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let out: string;
beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), 'ba-translate-'));
});
afterEach(() => rmSync(out, { recursive: true, force: true }));

describe('basic: one file, social providers, session, origins', () => {
  const t = translate('basic');

  it('maps email/password, verification and the session', () => {
    expect(t.source).toEqual({ file: 'lib/auth.ts', line: 7 });
    expect(ac(t).strategies.password).toBe(true);
    expect(ac(t).requireEmailVerification).toBe(true);
    expect(ac(t).passwordPolicy.minLength).toBe(10);
    expect(ac(t).accountUx.passwordReset).toBe('link');
    expect(ac(t).accountUx.emailVerification).toBe('link');
    expect(ac(t).verification.magicLink.ttlMinutes).toBe(120);
    expect(ac(t).session.idleMs).toBe(30 * 86_400_000);
    expect(ac(t).session.absoluteMs).toBe(90 * 86_400_000);
    expect(ac(t).session.jwtTtlSeconds).toBe(300);
    expect(ac(t).session.multiSession).toBe(false);
    expect(find(t, 'session.expiresIn')).toMatchObject({ status: 'differs', file: 'lib/auth.ts', line: 38 });
  });

  it('turns providers into env placeholders and never copies a secret', () => {
    expect(t.document.oauth_providers).toEqual([
      { provider: 'google', enabled: true, allow_sign_in: true, allow_sign_up: true, client_id: '${GOOGLE_CLIENT_ID}', client_secret: '${GOOGLE_CLIENT_SECRET}' },
      {
        provider: 'github',
        enabled: true,
        allow_sign_in: true,
        allow_sign_up: true,
        client_id: '${GITHUB_CLIENT_ID}',
        client_secret: '${GITHUB_CLIENT_SECRET}',
        scopes: ['read:user', 'user:email'],
      },
    ]);
    expect(ac(t).strategies.oauthProviders).toEqual(['google', 'github']);
    expect(t.env.map((e) => e.name)).toEqual(['BETTER_AUTH_URL', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
    expect(t.mappings.providers).toEqual({ google: 'google', github: 'github' });
  });

  it('collects origins (baseURL from env, wildcards) and maps nextCookies', () => {
    expect(t.document.instance.allowed_origins).toEqual(['${BETTER_AUTH_URL}', 'https://app.acme.com', 'https://*.acme.com']);
    expect(find(t, 'trustedOrigins "https://*.acme.com"')?.status).toBe('differs');
    expect(t.plugins).toEqual(['nextCookies']);
    expect(t.bridge).toEqual({ cookiePrefix: 'better-auth', sessionCookie: 'better-auth.session_token', secretEnv: 'BETTER_AUTH_SECRET', expiresInSeconds: 30 * 86_400 });
  });

  it('matches the snapshot', () => {
    expect({ document: t.document, report: t.report, env: t.env }).toMatchSnapshot();
  });
});

describe('split-options: tsconfig paths, t3 env, spreads, access control', () => {
  const t = translate('split-options');

  it('reads options split over files and env vars through createEnv', () => {
    expect(t.source?.file).toBe('src/lib/auth.ts');
    expect(t.document.oauth_providers).toContainEqual({
      provider: 'discord',
      enabled: true,
      allow_sign_in: true,
      allow_sign_up: false,
      client_id: '${DISCORD_CLIENT_ID}',
      client_secret: '${DISCORD_CLIENT_SECRET}',
    });
    expect(ac(t).accountLinking).toBe('auto');
    expect(ac(t).accountLinkingTrust).toEqual({ discord: 'always' });
    expect(ac(t).session).toMatchObject({ absoluteMs: 7 * 86_400_000, idleTimeout: false });
    expect(ac(t).stepUp).toEqual({ enabled: true, windowMs: 600_000 });
    expect(t.document.instance.allowed_origins).toEqual(['${BETTER_AUTH_URL}']);
  });

  it('maps every plugin', () => {
    expect(t.plugins).toEqual(['organization', 'twoFactor', 'passkey', 'magicLink', 'emailOTP', 'admin', 'apiKey', 'captcha']);
    expect(ac(t).strategies).toMatchObject({ passkey: true, emailLink: true, emailCode: true, phoneCode: false, username: false });
    expect(ac(t).mfa).toMatchObject({ factors: { totp: true, passkey: true }, totp: { digits: 6, period: 30 }, backupCodes: { count: 8 }, rememberDevice: { enabled: true, days: 14 } });
    expect(ac(t).passkeyPolicy.requireUserVerification).toBe(true);
    expect(ac(t).verification.magicLink.ttlMinutes).toBe(10);
    expect(ac(t).verification.emailCode).toEqual({ length: 8, ttlMinutes: 5, maxAttempts: 5 });
    expect(ac(t).endUserApiKeys).toEqual({ selfServiceEnabled: true, keyPrefix: 'split', defaultExpiresInSeconds: 30 * 86_400, maxExpiresInSeconds: 90 * 86_400 });
    expect(ac(t).captcha).toEqual({ provider: 'turnstile', siteKey: '${CAPTCHA_SITE_KEY}', flows: { signUp: { enabled: true }, signIn: { enabled: true }, passwordReset: { enabled: true } } });
    expect(t.secrets).toEqual([{ kind: 'captcha_secret', provider: 'turnstile', env: 'TURNSTILE_SECRET_KEY' }]);
    expect(find(t, 'passkey.rpID')).toMatchObject({ status: 'manual', file: 'src/auth/plugins.ts' });
  });

  it('turns access control into permissions and roles', () => {
    expect(ac(t).organizations).toMatchObject({
      maxOrganizationsPerUser: 5,
      defaultMaxAllowedMemberships: 50,
      invitationTtlSeconds: 7 * 86_400,
      maxTeamsPerOrganization: 10,
      maxMembersPerTeam: 25,
      creatorRole: 'org:admin',
    });
    expect(t.document.permissions.map((p) => (p as { key: string }).key)).toEqual([
      'org:billing:manage',
      'org:project:create',
      'org:project:update',
    ]);
    expect(t.document.roles).toEqual([
      {
        key: 'org:admin_ba',
        name: 'Admin',
        description: 'Migrated from the Better Auth "admin" role.',
        permissions: ['org:project:create', 'org:project:update', 'org:sys_memberships:manage', 'org:sys_memberships:read', 'org:sys_profile:manage'],
      },
      {
        key: 'org:billingmanager',
        name: 'BillingManager',
        description: 'Migrated from the Better Auth "billingManager" role.',
        permissions: ['org:billing:manage', 'org:sys_memberships:manage'],
      },
    ]);
    expect(t.mappings.roles).toMatchObject({ owner: 'org:admin', member: 'org:member', admin: 'org:admin_ba', billingManager: 'org:billingmanager' });
    expect(find(t, 'organization.roles.member')?.status).toBe('differs');
  });

  it('keeps app roles from the admin plugin as a typed trait', () => {
    expect(ac(t).identityTraits.traits).toContainEqual({ key: 'role', type: 'enum', enum: ['user', 'admin', 'support'], userEditable: false });
  });

  it('matches the snapshot', () => {
    expect({ document: t.document, report: t.report, env: t.env, secrets: t.secrets, mappings: t.mappings }).toMatchSnapshot();
  });
});

describe('kitchen-sink: many plugins, a function-scoped instance, payments', () => {
  const t = translate('kitchen-sink');

  it('reads a Workers-style instance built from bindings', () => {
    expect(t.source?.file).toBe('src/auth.ts');
    expect(t.env.map((e) => e.name)).toEqual(
      expect.arrayContaining(['MICROSOFT_CLIENT_ID', 'KEYCLOAK_CLIENT_ID', 'OKTA_CLIENT_SECRET', 'APPLE_TEAM_ID']),
    );
    expect(t.bridge.cookiePrefix).toBe('kitchen');
    expect(t.bridge.sessionCookie).toBe('kitchen.session_token');
  });

  it('flags hard-coded secrets and never writes them', () => {
    const text = JSON.stringify(t.document);
    expect(text).not.toContain('hard-coded-oops');
    expect(text).not.toContain('polar-secret-in-code');
    expect(text).not.toContain('crm-secret-literal');
    expect(find(t, 'socialProviders.twitter.clientSecret')?.status).toBe('manual');
    expect(t.document.oauth_providers).toContainEqual(expect.objectContaining({ provider: 'x', client_id: 'twitter-public-id', client_secret: '${TWITTER_CLIENT_SECRET}' }));
  });

  it('maps social extras: Microsoft tenant, Apple keys, Polar as a custom provider', () => {
    expect(t.document.oauth_providers).toContainEqual(expect.objectContaining({ provider: 'microsoft', values: { tenant: 'organizations' } }));
    const apple = t.document.oauth_providers.find((p) => (p as { provider: string }).provider === 'apple') as Record<string, unknown>;
    expect(apple.values).toEqual({ team_id: '${APPLE_TEAM_ID}', key_id: '${APPLE_KEY_ID}', private_key: '${APPLE_PRIVATE_KEY}' });
    expect(apple).not.toHaveProperty('client_secret');
    expect(t.document.custom_oauth_providers).toContainEqual(expect.objectContaining({ provider_key: 'polar_sh', protocol: 'oauth2' }));
  });

  it('maps generic OAuth, incl. a profile mapping and the Okta preset', () => {
    const kc = t.document.custom_oauth_providers.find((p) => (p as { provider_key: string }).provider_key === 'keycloak') as Record<string, unknown>;
    expect(kc).toMatchObject({
      protocol: 'oidc',
      issuer: 'https://sso.kitchen.example/realms/main',
      pkce: true,
      profile_mapping: { fields: { email: 'email', full_name: { template: '{{given_name}} {{family_name}}' } }, public_metadata: { department: 'department' } },
    });
    const crm = t.document.custom_oauth_providers.find((p) => (p as { provider_key: string }).provider_key === 'legacy_crm') as Record<string, unknown>;
    expect(crm).toMatchObject({ protocol: 'oauth2', token_endpoint_auth_method: 'client_secret_basic', token_endpoint: 'https://crm.kitchen.example/oauth/token' });
    expect(t.document.oauth_providers).toContainEqual(expect.objectContaining({ provider: 'okta', values: { domain: 'kitchen.okta.com' } }));
    expect(t.mappings.providers).toMatchObject({ keycloak: 'keycloak', 'legacy-crm': 'legacy_crm', okta: 'okta', polar: 'polar_sh' });
  });

  it('maps rate limits, cookies, linking, user fields and hooks', () => {
    expect(ac(t).rateLimit.rules).toEqual([
      { group: 'sign_in', windowSeconds: 10, max: 3, key: 'ip' },
      { group: 'sign_up', windowSeconds: 60, max: 5, key: 'ip' },
      { group: 'credential_verify', windowSeconds: 10, max: 3, key: 'ip' },
    ]);
    expect(find(t, 'rateLimit.customRules["/get-session"]')?.status).toBe('differs');
    expect(find(t, 'rateLimit.customRules["/custom-thing"]')?.status).toBe('manual');
    expect(ac(t).session.crossSubdomainCookies).toBe(true);
    expect(ac(t).accountLinking).toBe('block');
    expect(ac(t).passwordPolicy.minLength).toBe(8);
    expect(find(t, 'emailAndPassword.minPasswordLength')?.status).toBe('differs');
    expect(ac(t).identityTraits.traits).toEqual([
      { key: 'plan', type: 'string', userEditable: false },
      { key: 'age', type: 'number', userEditable: true },
      { key: 'tier', type: 'enum', enum: ['free', 'pro'], userEditable: true },
    ]);
    expect(find(t, 'user.additionalFields.tags')?.status).toBe('manual');
    expect(find(t, 'databaseHooks.user.create.before')?.note).toContain('pre-user-registration Action');
    expect(find(t, 'hooks.before')?.status).toBe('manual');
    expect(t.document.instance.allowed_origins).toEqual(['https://kitchen.example', 'https://admin.kitchen.example']);
    expect(t.document.redirect_urls).toEqual([{ url: 'myapp://' }]);
  });

  it('maps the remaining plugins', () => {
    expect(ac(t).strategies).toMatchObject({ phoneCode: true, username: true, anonymous: true, siwe: true, password: true });
    expect(ac(t).accountUx.username).toEqual({ minLength: 4, maxLength: 20 });
    expect(ac(t).session).toMatchObject({ multiSession: true, audience: 'https://api.kitchen.example', jwtTtlSeconds: 900 });
    expect(ac(t).passwordPolicy.checkBreaches).toBe(true);
    expect(ac(t).accountUx.lastSignInMethod).toEqual({ enabled: true });
    expect(ac(t).oauthProvider).toMatchObject({
      dynamicRegistration: true,
      requirePkce: true,
      tokenLifetimes: { accessTokenSeconds: 3600, deviceCodeSeconds: 1800 },
      customScopes: [{ name: 'read:orders', description: 'read:orders', claims: [] }],
    });
    expect(t.document.oauth_clients).toEqual([
      { name: 'Internal dashboard', redirect_uris: ['https://dash.kitchen.example/callback'], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'client_secret_basic', first_party: true },
    ]);
    expect(t.document.resource_servers).toEqual([{ identifier: 'https://mcp.kitchen.example', name: 'MCP server', scopes: ['openid', 'profile', 'email', 'offline_access'] }]);
    expect(t.document.oauth_providers).toContainEqual({ provider: 'siwe', settings: { domain: 'kitchen.example' } });
    expect(find(t, 'customSession()')?.status).toBe('manual');
    expect(find(t, 'sso.defaultSSO bigco')?.status).toBe('manual');
  });

  it('turns Stripe and Polar plans into billing plans', () => {
    expect(t.document.billing_plans).toEqual([
      { name: 'Basic', slug: 'basic', interval: 'month', active: true, audience: 'user', stripe_price_id: 'price_basic_123', limits: { projects: 5 } },
      { name: 'Pro', slug: 'pro', interval: 'month', active: true, audience: 'user', stripe_price_id: 'price_pro_456', annual_price_id: 'price_pro_annual_789', limits: { projects: 50 }, trial_days: 14 },
      { name: 'Starter', slug: 'starter', interval: 'month', active: true, audience: 'user', provider: 'polar', provider_price_id: 'prod_polar_1' },
    ]);
    expect(t.plugins).toContain('payments:polar');
    expect(t.plugins).toContain('payments:stripe');
  });

  it('matches the snapshot', () => {
    expect({ document: t.document, report: t.report, env: t.env, mappings: t.mappings }).toMatchSnapshot();
  });
});

describe('output', () => {
  it('writes only non-empty resource files plus both reports', () => {
    const t = translate('basic');
    const written = writeTranslation(t, out, 'json');
    expect(written).toEqual(['instance.json', 'oauth_providers.json', 'better-auth-report.md', 'better-auth-report.json']);
    expect(readdirSync(out).sort()).toEqual([...written].sort());
    const report = readFileSync(join(out, 'better-auth-report.md'), 'utf8');
    expect(report).toContain('## Environment variables to set before applying');
    expect(report).toContain('| `session.expiresIn` |');
    expect(report).toMatch(/`lib\/auth\.ts:\d+`/);
    const json = JSON.parse(readFileSync(join(out, 'better-auth-report.json'), 'utf8'));
    expect(json.counts).toEqual(reportCounts(t.report));
  });

  it('writes YAML when asked', () => {
    const written = writeTranslation(translate('basic'), out, 'yaml');
    expect(written[0]).toBe('instance.yaml');
    expect(readFileSync(join(out, 'instance.yaml'), 'utf8')).toContain('"auth_config":');
  });

  it('a project with no betterAuth() call reports it', () => {
    const t = translateBetterAuth(analyzeBetterAuth(out));
    expect(t.source).toBeNull();
    expect(renderReport(t)).toContain('No `betterAuth()` call was found.');
  });
});
