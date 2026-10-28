import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TranslationResult } from '../framework/plugin';
import { translateDevise, translateDjango } from './translate-rails-django';

/**
 * The Rails and Django translators over small real-shaped apps: Devise 4.9
 * (generated initializer with settings uncommented, devise-two-factor,
 * devise_invitable, OmniAuth Google / GitHub / SAML, cookie store, a second
 * Admin model), a legacy Devise app (devise-encryptable, activerecord session
 * store, hard-coded secret_key), Django with django-environ + allauth (MFA,
 * headless, social apps in settings and in the database, signed-cookie
 * sessions, a production override) and a plain Django app with
 * python-social-auth.
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

describe('Devise', () => {
  const t = translateDevise(join(FIXTURES, 'devise'));
  const init = 'config/initializers/devise.rb';

  it('reads the initializer and the OmniAuth providers, carrying env vars by name', () => {
    expect(t.origin).toBe(`Devise config at ${init}:5`);
    expect(t.mappings.providers).toEqual({ google_oauth2: 'google', github: 'github' });
    expect(t.documents.oauth_providers).toEqual([
      { provider: 'google', enabled: true, allow_sign_in: true, allow_sign_up: true, client_id: '${GOOGLE_CLIENT_ID}', client_secret: '${GOOGLE_CLIENT_SECRET}', scopes: ['email', 'profile'] },
      { provider: 'github', enabled: true, allow_sign_in: true, allow_sign_up: true, client_id: '${GITHUB_KEY}', client_secret: '${GITHUB_CLIENT_SECRET}', scopes: ['user:email'] },
    ]);
    expect(t.env.map((e) => e.name)).toEqual(['GITHUB_CLIENT_SECRET', 'GITHUB_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
    expect(entry(t, 'omniauth :google_oauth2')).toMatchObject({ status: 'mapped', file: init, line: 62, atlas: 'oauth_providers google' });
    // A Rails credentials lookup cannot be read: placeholder + manual entry.
    expect(entry(t, 'omniauth :github client secret')).toMatchObject({ status: 'manual', file: init, line: 63 });
    expect(entry(t, 'omniauth :saml')).toMatchObject({ status: 'manual', file: init, line: 64, atlas: 'sso_connections' });
  });

  it('maps passwords, confirmation, recovery, lockout and two-factor', () => {
    const cfg = authConfig(t);
    expect(cfg.strategies).toEqual({ password: true, oauthProviders: ['google', 'github'] });
    expect(cfg.passwordPolicy).toEqual({ minLength: 12, maxLength: 128, checkBreaches: true });
    expect(cfg.requireEmailVerification).toBe(true);
    expect(cfg.accountUx).toEqual({ passwordReset: 'link', emailVerification: 'link' });
    // reset_password_within (6 hours) sets the link lifetime; confirm_within does not override it.
    expect(cfg.verification).toEqual({ magicLink: { ttlMinutes: 360 } });
    expect(cfg.signInAfterReset).toBe(false);
    expect(cfg.attackProtection).toEqual({ bruteForce: { enabled: true } });
    expect(cfg.mfa).toEqual({ factors: { totp: true }, backupCodes: { count: 8 } });
    expect(cfg.mfaPolicy).toBe('optional');
    expect(cfg.signUpMode).toBeUndefined();

    expect(entry(t, 'password_length')).toMatchObject({ status: 'mapped', file: init, line: 42 });
    expect(entry(t, 'pepper')).toMatchObject({ status: 'mapped', file: init, line: 30 });
    expect(entry(t, ':confirmable')).toMatchObject({ status: 'mapped', file: 'app/models/user.rb', line: 7 });
    expect(entry(t, 'allow_unconfirmed_access_for')).toMatchObject({ status: 'mapped', line: 33 });
    expect(entry(t, 'confirm_within')).toMatchObject({ status: 'differs', line: 34 });
    expect(entry(t, 'reset_password_within')).toMatchObject({ status: 'differs', line: 55 });
    expect(entry(t, ':lockable')).toMatchObject({ status: 'differs', file: 'app/models/user.rb', line: 7 });
    expect(entry(t, ':lockable').note).toContain('lock after 5 failures, unlock after 1 h');
    expect(entry(t, 'maximum_attempts')).toMatchObject({ status: 'differs', line: 51 });
    expect(t.report.filter((r) => r.setting === ':two_factor_authenticatable')).toHaveLength(2);
    expect(entry(t, ':invitable').status).toBe('differs');
    expect(entry(t, 'devise-pwned_password')).toMatchObject({ status: 'mapped', file: 'Gemfile', line: 11 });
  });

  it('maps :timeoutable to an idle timeout and remember_for to the absolute lifetime', () => {
    expect(authConfig(t).session).toEqual({ idleMs: 2 * 3_600_000, idleTimeout: true, absoluteMs: 28 * 86_400_000 });
    expect(entry(t, 'timeout_in')).toMatchObject({ status: 'mapped', file: init, line: 46, atlas: 'auth_config.session.idleMs' });
    expect(entry(t, 'remember_for')).toMatchObject({ status: 'differs', file: init, line: 38, atlas: 'auth_config.session.absoluteMs' });
  });

  it('bridges the cookie store and flags the second model, mail and plumbing', () => {
    expect(t.bridge).toEqual({ preset: 'devise', vars: { cookie_name: '_shopfront_session' } });
    expect(entry(t, 'session_store :cookie_store')).toMatchObject({ status: 'mapped', file: 'config/initializers/session_store.rb', line: 3, atlas: 'bridge preset devise' });
    expect(t.lazy).toBeUndefined();
    expect(entry(t, 'Admin')).toMatchObject({ status: 'manual', file: 'app/models/admin.rb', line: 2 });
    expect(entry(t, 'Admin').note).toContain('--set users-table=admins');
    expect(entry(t, 'secret_key')).toMatchObject({ status: 'mapped', line: 9 });
    expect(entry(t, 'mailer_sender')).toMatchObject({ status: 'manual', line: 16 });
    expect(entry(t, 'mailer_sender').note).toContain('accounts@shopfront.example');
    expect(entry(t, 'sign_out_via')).toMatchObject({ status: 'mapped', line: 59 });
    expect(entry(t, 'responder.error_status')).toMatchObject({ status: 'mapped', line: 67 });
    expect(t.report.some((r) => r.status === 'manual' && r.note.startsWith('Not translated'))).toBe(false);
  });
});

describe('Devise (legacy app: devise-encryptable, activerecord sessions)', () => {
  const t = translateDevise(join(FIXTURES, 'devise-minimal'));
  const init = 'config/initializers/devise.rb';

  it('sends encryptable digests to lazy migration under the model scope', () => {
    expect(t.origin).toBe(`Devise config at ${init}:1`);
    expect(t.lazy).toEqual({ preset: 'devise_json', config: { scope: 'member', path: '/members/sign_in' } });
    expect(entry(t, ':encryptable')).toMatchObject({ status: 'manual', file: 'app/models/member.rb', line: 2, atlas: 'lazy migration devise_json' });
    expect(entry(t, ':encryptable').note).toContain(':authlogic_sha512');
  });

  it('closes sign-up without :registerable and raises a short minimum length', () => {
    const cfg = authConfig(t);
    expect(cfg.signUpMode).toBe('restricted');
    expect(cfg.requireEmailVerification).toBe(false);
    expect(cfg.strategies).toEqual({ password: true, username: true });
    expect(cfg.passwordPolicy).toEqual({ minLength: 8, maxLength: 128 });
    expect(entry(t, 'password_length')).toMatchObject({ status: 'differs', line: 7 });
    expect(entry(t, 'authentication_keys')).toMatchObject({ status: 'differs', line: 8 });
    // :rememberable without :timeoutable: the default two weeks, fixed.
    expect(cfg.session).toEqual({ absoluteMs: 14 * 86_400_000, idleMs: 14 * 86_400_000, idleTimeout: false });
    expect(entry(t, 'remember_for (default 2 weeks)')).toMatchObject({ status: 'mapped', file: 'app/models/member.rb', line: 2 });
    expect(entry(t, ':rememberable').status).toBe('differs');
    expect(t.documents.oauth_providers).toBeUndefined();
  });

  it('bridges activerecord sessions under the default cookie name and never copies the hard-coded secret', () => {
    expect(t.bridge).toEqual({ preset: 'devise_active_record', vars: { cookie_name: '_my_legacy_store_session' } });
    expect(entry(t, 'session_store :active_record_store')).toMatchObject({ status: 'mapped', file: 'config/application.rb', line: 7 });
    expect(entry(t, 'secret_key')).toMatchObject({ status: 'manual', line: 9 });
    expect(JSON.stringify(t)).not.toContain('f1c4a7d0');
  });

  it('reports a folder without Devise', () => {
    const none = translateDevise(join(FIXTURES, 'passport'));
    expect(none.origin).toBe('Devise config (not found)');
    expect(none.report).toEqual([expect.objectContaining({ status: 'manual', setting: 'devise' })]);
  });
});

describe('Django with django-allauth', () => {
  const t = translateDjango(join(FIXTURES, 'django'));
  const base = 'acme/settings/base.py';

  it('reads the settings package, base first, and the social apps', () => {
    expect(t.origin).toBe(`Django settings at ${base}`);
    expect(t.mappings.providers).toEqual({ google: 'google', github: 'github', microsoft: 'microsoft' });
    expect(t.documents.oauth_providers).toEqual([
      { provider: 'google', enabled: true, allow_sign_in: true, allow_sign_up: true, client_id: '${GOOGLE_CLIENT_ID}', client_secret: '${GOOGLE_CLIENT_SECRET}', scopes: ['profile', 'email'] },
      { provider: 'github', enabled: true, allow_sign_in: true, allow_sign_up: true, client_id: '${GITHUB_CLIENT_ID}', client_secret: '${GITHUB_SECRET}' },
      { provider: 'microsoft', enabled: true, allow_sign_in: true, allow_sign_up: true, client_id: '${MICROSOFT_CLIENT_ID}', client_secret: '${MICROSOFT_CLIENT_SECRET}' },
    ]);
    expect(t.env.map((e) => e.name)).toEqual(['GITHUB_CLIENT_ID', 'GITHUB_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET']);
    expect(entry(t, 'allauth.socialaccount.providers.google')).toMatchObject({ status: 'mapped', file: base, line: 24 });
    // A provider with no APP in settings keeps its credentials in a SocialApp row.
    expect(entry(t, 'SocialApp microsoft')).toMatchObject({ status: 'manual', file: base, line: 26 });
    expect(entry(t, 'allauth.socialaccount.providers.saml')).toMatchObject({ status: 'manual', line: 27, atlas: 'sso_connections' });
    expect(entry(t, 'SOCIALACCOUNT_PROVIDERS.google.AUTH_PARAMS')).toMatchObject({ status: 'manual', line: 80 });
  });

  it('maps login methods, verification, codes, MFA and account linking', () => {
    const cfg = authConfig(t);
    expect(cfg.strategies).toEqual({ password: true, emailCode: true, passkey: true, oauthProviders: ['google', 'github', 'microsoft'] });
    expect(cfg.requireEmailVerification).toBe(true);
    expect(cfg.accountUx).toEqual({ emailVerification: 'link' });
    expect(cfg.accountLinking).toBe('auto');
    expect(cfg.mfaPolicy).toBe('optional');
    expect(cfg.mfa).toEqual({ factors: { totp: true, passkey: true }, backupCodes: { count: 12 } });
    expect(entry(t, 'ACCOUNT_LOGIN_METHODS')).toMatchObject({ status: 'mapped', file: base, line: 65 });
    expect(entry(t, 'ACCOUNT_RATE_LIMITS')).toMatchObject({ status: 'differs', line: 69 });
    expect(entry(t, 'ACCOUNT_ADAPTER')).toMatchObject({ status: 'manual', line: 70 });
    expect(entry(t, 'HEADLESS_FRONTEND_URLS')).toMatchObject({ status: 'manual', line: 97 });
  });

  it('maps hashers and validators; a custom hasher goes to lazy migration', () => {
    const cfg = authConfig(t);
    expect(cfg.passwordPolicy).toEqual({ minLength: 10, checkBreaches: true });
    expect(entry(t, 'PASSWORD_HASHERS Argon2PasswordHasher')).toMatchObject({ status: 'mapped', file: base, line: 42 });
    expect(entry(t, 'PASSWORD_HASHERS Argon2PasswordHasher').note).toContain('argon2 hashes (new hashes)');
    expect(entry(t, 'PASSWORD_HASHERS LegacyPHPassHasher')).toMatchObject({ status: 'manual', line: 45, atlas: 'lazy migration allauth_headless' });
    expect(entry(t, 'MinimumLengthValidator')).toMatchObject({ status: 'mapped', line: 50 });
    expect(entry(t, 'CommonPasswordValidator')).toMatchObject({ status: 'differs', line: 54 });
    expect(entry(t, 'NumericPasswordValidator')).toMatchObject({ status: 'differs', line: 55 });
    expect(t.lazy).toEqual({ preset: 'allauth_headless', config: {} });
  });

  it('bridges signed-cookie sessions and reports the production override', () => {
    expect(t.bridge).toEqual({ preset: 'django_signed_cookies', vars: { cookie_name: 'acme_session' } });
    expect(entry(t, 'SESSION_ENGINE')).toMatchObject({ status: 'mapped', file: base, line: 58, atlas: 'bridge preset django_signed_cookies' });
    // 60 * 60 * 24 * 7, extended on every request.
    expect(authConfig(t).session).toEqual({ idleMs: 7 * 86_400_000, idleTimeout: true, absoluteMs: 90 * 86_400_000, crossSubdomainCookies: true });
    const age = t.report.filter((r) => r.setting === 'SESSION_COOKIE_AGE');
    expect(age).toEqual([
      expect.objectContaining({ status: 'mapped', file: base, line: 60 }),
      expect.objectContaining({ status: 'manual', file: 'acme/settings/production.py', line: 4 }),
    ]);
    expect(entry(t, 'SESSION_COOKIE_SECURE')).toMatchObject({ status: 'mapped', file: 'acme/settings/production.py', line: 5 });
    expect(entry(t, 'SECRET_KEY')).toMatchObject({ status: 'mapped', line: 11 });
    // Non-auth settings are not reported, overridden or not.
    expect(t.report.some((r) => r.setting === 'DEBUG')).toBe(false);
  });
});

describe('Django (contrib.auth + python-social-auth)', () => {
  const t = translateDjango(join(FIXTURES, 'django-plain'));
  const file = 'mysite/settings.py';

  it('maps social_django backends and their SOCIAL_AUTH_* keys', () => {
    expect(t.origin).toBe(`Django settings at ${file}`);
    expect(t.mappings.providers).toEqual({ 'google-oauth2': 'google', github: 'github' });
    expect(t.documents.oauth_providers).toEqual([
      { provider: 'google', enabled: true, allow_sign_in: true, allow_sign_up: true, client_id: '${GOOGLE_KEY}', client_secret: '${GOOGLE_SECRET}' },
      { provider: 'github', enabled: true, allow_sign_in: true, allow_sign_up: true, client_id: 'Iv1.8a61f9b3a7aba766', client_secret: '${GITHUB_CLIENT_SECRET}' },
    ]);
    expect(t.env.map((e) => e.name)).toEqual(['GITHUB_CLIENT_SECRET', 'GOOGLE_KEY', 'GOOGLE_SECRET']);
    expect(entry(t, 'AUTHENTICATION_BACKENDS GoogleOAuth2')).toMatchObject({ status: 'mapped', file, line: 22 });
    expect(entry(t, 'SOCIAL_AUTH_GITHUB_SECRET')).toMatchObject({ status: 'manual', line: 30 });
    expect(entry(t, 'social_django')).toMatchObject({ status: 'differs', line: 17 });
    expect(authConfig(t).accountLinking).toBe('auto');
  });

  it('maps ModelBackend, defaults and browser-close sessions', () => {
    const cfg = authConfig(t);
    expect(cfg.strategies).toEqual({ password: true, username: true, oauthProviders: ['google', 'github'] });
    expect(cfg.passwordPolicy).toEqual({ minLength: 8 });
    expect(cfg.requireEmailVerification).toBeUndefined();
    expect(cfg.session).toEqual({ absoluteMs: 14 * 86_400_000, idleMs: 14 * 86_400_000, idleTimeout: false });
    expect(entry(t, 'AUTHENTICATION_BACKENDS ModelBackend')).toMatchObject({ status: 'mapped', line: 24 });
    expect(entry(t, 'MinimumLengthValidator')).toMatchObject({ status: 'mapped', line: 33 });
    expect(entry(t, 'PASSWORD_HASHERS (default)').status).toBe('mapped');
    expect(entry(t, 'SESSION_EXPIRE_AT_BROWSER_CLOSE')).toMatchObject({ status: 'differs', line: 38 });
    expect(entry(t, 'LOGIN_REDIRECT_URL')).toMatchObject({ status: 'manual', line: 40 });
    expect(t.bridge).toEqual({ preset: 'django', vars: {} });
    expect(entry(t, 'SESSION_ENGINE (default database sessions)')).toMatchObject({ status: 'mapped', file, line: 1 });
    expect(t.lazy).toBeUndefined();
  });

  it('never copies hard-coded secrets', () => {
    expect(entry(t, 'SECRET_KEY')).toMatchObject({ status: 'manual', line: 6 });
    const json = JSON.stringify(t);
    expect(json).not.toContain('django-insecure');
    expect(json).not.toContain('e4c1d0b9');
  });

  it('reports a folder without Django settings', () => {
    const none = translateDjango(join(FIXTURES, 'passport'));
    expect(none.origin).toBe('Django settings (not found)');
    expect(none.report).toEqual([expect.objectContaining({ status: 'manual', setting: 'settings' })]);
  });
});
