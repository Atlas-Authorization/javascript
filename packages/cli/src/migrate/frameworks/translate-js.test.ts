import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TranslationResult } from '../framework/plugin';
import { translateAuthJs, translateIronSession, translateLucia, translatePassport } from './translate-js';

/**
 * The JavaScript framework translators over small real-shaped apps: Auth.js v5
 * (split auth.config.ts, Prisma adapter, database sessions, Resend, Passkey),
 * NextAuth v4 (pages router, Azure AD, Credentials, JWT sessions, custom
 * cookie), Lucia v3 with arctic, Passport (CommonJS: local, Google, SAML,
 * express-session with connect-pg-simple) and iron-session v8.
 */
const FIXTURES = join(__dirname, '../../../fixtures/frameworks/translate');

function entry(t: TranslationResult, setting: string) {
  const e = t.report.find((r) => r.setting === setting);
  expect(e, `report entry ${setting}`).toBeDefined();
  return e!;
}

function authConfig(t: TranslationResult): Record<string, unknown> {
  return (t.documents.instance as { auth_config: Record<string, unknown> }).auth_config;
}

describe('Auth.js v5', () => {
  const t = translateAuthJs(join(FIXTURES, 'authjs-v5'));

  it('reads the NextAuth() call, following the spread config into auth.config.ts', () => {
    expect(t.origin).toBe('Auth.js config at src/auth.ts:8');
    expect(t.mappings.providers).toEqual({ github: 'github', google: 'google' });
    const providers = t.documents.oauth_providers as Array<Record<string, unknown>>;
    // A bare v5 provider reads AUTH_<ID>_ID / _SECRET; an explicit one keeps its own env names.
    expect(providers).toEqual([
      { provider: 'github', enabled: true, allow_sign_in: true, allow_sign_up: true, client_id: '${AUTH_GITHUB_ID}', client_secret: '${AUTH_GITHUB_SECRET}' },
      { provider: 'google', enabled: true, allow_sign_in: true, allow_sign_up: true, client_id: '${GOOGLE_ID}', client_secret: '${GOOGLE_SECRET}', scopes: ['openid', 'email', 'profile'] },
    ]);
    expect(t.env.map((e) => e.name)).toEqual(['AUTH_GITHUB_ID', 'AUTH_GITHUB_SECRET', 'GOOGLE_ID', 'GOOGLE_SECRET']);
    // A bare provider is located at its import.
    expect(entry(t, 'github')).toMatchObject({ status: 'mapped', file: 'src/auth.config.ts', line: 1, atlas: 'oauth_providers github' });
    expect(entry(t, 'google')).toMatchObject({ status: 'mapped', file: 'src/auth.config.ts', line: 8 });
  });

  it('maps email links, passkeys, account linking and database sessions', () => {
    const cfg = authConfig(t);
    expect(cfg.strategies).toMatchObject({ emailLink: true, passkey: true, oauthProviders: ['github', 'google'] });
    expect(cfg.accountLinking).toBe('auto');
    expect(cfg.session).toEqual({ idleMs: 14 * 86_400_000, idleTimeout: true, absoluteMs: 90 * 86_400_000 });
    expect(entry(t, 'resend')).toMatchObject({ status: 'differs', file: 'src/auth.ts', line: 11 });
    expect(entry(t, 'google.allowDangerousEmailAccountLinking')).toMatchObject({ status: 'differs', file: 'src/auth.config.ts', line: 12 });
    expect(t.bridge).toEqual({ preset: 'authjs', vars: {} });
    expect(t.lazy).toBeUndefined();
    // The passkey provider already turned passkeys on: no second entry for the experimental flag.
    expect(t.report.some((r) => r.setting === 'experimental.enableWebAuthn')).toBe(false);
  });

  it('leaves callbacks and custom pages for a human', () => {
    expect(entry(t, 'callbacks.session')).toMatchObject({ status: 'manual', file: 'src/auth.ts', line: 15 });
    expect(entry(t, 'pages.signIn')).toMatchObject({ status: 'manual', file: 'src/auth.config.ts', line: 15 });
    expect(entry(t, 'adapter').note).toContain('PrismaAdapter');
  });
});

describe('NextAuth v4', () => {
  const t = translateAuthJs(join(FIXTURES, 'authjs-v4'));
  const file = 'pages/api/auth/[...nextauth].ts';

  it('maps Azure AD with v4 env names and never copies a hard-coded secret', () => {
    expect(t.origin).toBe(`Auth.js config at ${file}:25`);
    expect(t.mappings.providers).toEqual({ 'azure-ad': 'microsoft' });
    expect(t.documents.oauth_providers).toEqual([
      {
        provider: 'microsoft',
        enabled: true,
        allow_sign_in: true,
        allow_sign_up: true,
        client_id: '${AZURE_AD_CLIENT_ID}',
        client_secret: '${AZURE_AD_CLIENT_SECRET}',
        values: { tenant: '${AZURE_AD_TENANT_ID}' },
      },
    ]);
    expect(entry(t, 'azure-ad.clientSecret')).toMatchObject({ status: 'manual', file, line: 9 });
    expect(JSON.stringify(t)).not.toContain('hard-coded-secret-value');
    expect(t.env.map((e) => e.name)).toEqual(['AZURE_AD_CLIENT_ID', 'AZURE_AD_CLIENT_SECRET', 'AZURE_AD_TENANT_ID']);
  });

  it('turns Credentials into password sign-in with the lazy fallback, and JWT sessions into the authjs_jwt bridge', () => {
    expect(authConfig(t).strategies).toMatchObject({ password: true, oauthProviders: ['microsoft'] });
    expect(entry(t, 'Credentials')).toMatchObject({ status: 'differs', file, line: 12 });
    expect(t.lazy).toEqual({ preset: 'authjs_credentials', config: {} });
    expect(t.bridge).toEqual({ preset: 'authjs_jwt', vars: { cookie_name: 'legacy.session' } });
    expect(authConfig(t).session).toEqual({ idleMs: 7 * 86_400_000, idleTimeout: true, absoluteMs: 90 * 86_400_000 });
    expect(entry(t, 'cookies.sessionToken')).toMatchObject({ status: 'mapped', file, line: 21 });
    expect(entry(t, 'secret')).toMatchObject({ status: 'mapped', file, line: 22 });
  });

  it('reports where it looked when there is no Auth.js call', () => {
    const none = translateAuthJs(join(FIXTURES, 'lucia-v3'));
    expect(none.report).toHaveLength(1);
    expect(none.report[0]).toMatchObject({ status: 'manual', area: 'setup' });
    expect(none.report[0]!.note).toContain('No NextAuth() / Auth.js call');
  });
});

describe('Lucia v3', () => {
  const t = translateLucia(join(FIXTURES, 'lucia-v3'));
  const file = 'src/lib/auth.ts';

  it('reads the session lifetime, cookie name and user attributes', () => {
    expect(t.origin).toBe(`Lucia at ${file}:8`);
    expect(authConfig(t).session).toEqual({ idleMs: 14 * 86_400_000, idleTimeout: true, absoluteMs: 90 * 86_400_000 });
    expect(entry(t, 'sessionExpiresIn')).toMatchObject({ status: 'mapped', file, line: 9 });
    expect(t.bridge).toEqual({ preset: 'lucia', vars: { cookie_name: 'blog_session' } });
    expect(entry(t, 'sessionCookie.name')).toMatchObject({ status: 'mapped', line: 11 });
    expect(entry(t, 'getUserAttributes')).toMatchObject({ status: 'manual', line: 14 });
    expect(entry(t, 'adapter').note).toContain('DrizzlePostgreSQLAdapter');
  });

  it('maps arctic providers by constructor argument', () => {
    expect(t.mappings.providers).toEqual({ github: 'github', google: 'google' });
    expect(t.documents.oauth_providers).toEqual([
      { provider: 'github', enabled: true, allow_sign_in: true, allow_sign_up: true, client_id: '${GITHUB_CLIENT_ID}', client_secret: '${GITHUB_CLIENT_SECRET}' },
      { provider: 'google', enabled: true, allow_sign_in: true, allow_sign_up: true, client_id: '${GOOGLE_CLIENT_ID}', client_secret: '${GOOGLE_CLIENT_SECRET}' },
    ]);
    expect(entry(t, 'new GitHub(…)')).toMatchObject({ status: 'mapped', file, line: 17 });
  });
});

describe('Passport', () => {
  const t = translatePassport(join(FIXTURES, 'passport'));
  const file = 'src/auth.js';

  it('maps the strategies, required through CommonJS', () => {
    expect(t.origin).toBe(`Passport at ${file}:8`);
    expect(authConfig(t).strategies).toMatchObject({ password: true, oauthProviders: ['google'] });
    expect(entry(t, 'passport-local')).toMatchObject({ status: 'differs', line: 8, atlas: 'auth_config.strategies.password' });
    expect(t.documents.oauth_providers).toEqual([
      { provider: 'google', enabled: true, allow_sign_in: true, allow_sign_up: true, client_id: '${GOOGLE_CLIENT_ID}', client_secret: '${GOOGLE_CLIENT_SECRET}', scopes: ['profile', 'email'] },
    ]);
    expect(entry(t, 'passport-google-oauth20.callbackURL')).toMatchObject({ status: 'mapped', line: 15 });
    expect(entry(t, 'passport-google-oauth20 verify callback')).toMatchObject({ status: 'manual' });
    const saml = entry(t, '@node-saml/passport-saml');
    expect(saml).toMatchObject({ status: 'manual', area: 'sso', line: 22, atlas: 'sso_connections' });
    expect(saml.note).toContain('https://idp.example.com/sso');
  });

  it('reads express-session for the bridge and the session lifetime', () => {
    expect(t.bridge).toEqual({ preset: 'passport', vars: { cookie_name: 'api.sid' } });
    expect(entry(t, 'session({ name })')).toMatchObject({ status: 'mapped', line: 25 });
    expect(authConfig(t).session).toEqual({ idleMs: 30 * 86_400_000, idleTimeout: true, absoluteMs: 90 * 86_400_000 });
    expect(entry(t, 'store')).toMatchObject({ status: 'mapped', line: 27 });
    expect(entry(t, 'secret')).toMatchObject({ status: 'mapped', line: 26 });
  });
});

describe('iron-session', () => {
  const t = translateIronSession(join(FIXTURES, 'iron-session'));
  const file = 'app/lib/session.ts';

  it('reads the options object passed to getIronSession', () => {
    expect(t.origin).toBe(`iron-session at ${file}:12`);
    expect(t.bridge).toEqual({ preset: 'iron_session', vars: { cookie_name: 'dash-session' } });
    expect(entry(t, 'cookieName')).toMatchObject({ status: 'mapped', file, line: 6 });
    expect(entry(t, 'password')).toMatchObject({ status: 'mapped', line: 5 });
    expect(entry(t, 'password').note).toContain('SECRET_COOKIE_PASSWORD');
    // ttl is a fixed lifetime (the seal expires; nothing extends it).
    expect(authConfig(t).session).toEqual({ absoluteMs: 7 * 86_400_000, idleMs: 7 * 86_400_000, idleTimeout: false });
    expect(entry(t, 'ttl')).toMatchObject({ status: 'mapped', line: 7 });
    expect(entry(t, 'user store')).toMatchObject({ status: 'manual' });
  });
});
