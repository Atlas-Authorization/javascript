import { describe, expect, it } from 'vitest';
import { durationMs, fetchSupabaseAuthConfig, parseToml, settingsFromApi, settingsFromToml, translateSupabaseConfig } from './supabase-config';
import { fakeVendor } from './fake-vendor.test-helper';

/** A config.toml in the shape `supabase init` writes (trimmed to [auth]). */
const TOML = `# A string value
project_id = "demo"

[api]
enabled = true

[auth]
enabled = true
site_url = "http://127.0.0.1:3000"
additional_redirect_urls = [
  "https://app.example.com/auth/callback", # prod
  "https://*.preview.example.com/**",
]
jwt_expiry = 3600
enable_refresh_token_rotation = true
refresh_token_reuse_interval = 10
enable_signup = false
enable_anonymous_sign_ins = true
minimum_password_length = 10
password_requirements = "lower_upper_letters_digits_symbols"

[auth.sessions]
timebox = "24h"
inactivity_timeout = "8h30m"

[auth.email]
enable_signup = true
double_confirm_changes = true
enable_confirmations = true
otp_length = 6

[auth.email.template.invite]
subject = "You have been invited"
content_path = "./supabase/templates/invite.html"

[auth.sms]
enable_signup = true

[auth.sms.twilio]
enabled = true
account_sid = "AC123"
auth_token = "env(SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN)"

[auth.mfa]
max_enrolled_factors = 10

[auth.mfa.totp]
enroll_enabled = true
verify_enabled = true

[auth.mfa.phone]
enroll_enabled = false

[auth.webauthn]
rp_id = "app.example.com"

[auth.external.google]
enabled = true
client_id = "123.apps.googleusercontent.com"
secret = "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET)"
skip_nonce_check = true

[auth.external.azure]
enabled = true
client_id = "env(AZURE_CLIENT_ID)"
url = "https://login.microsoftonline.com/tenant-guid"

[auth.external.keycloak]
enabled = true
url = "https://kc.example.com/realms/main"

[auth.external.github]
enabled = false

[auth.hook.custom_access_token]
enabled = true
uri = "pg-functions://postgres/public/custom_access_token_hook"

[auth.third_party.firebase]
enabled = true
project_id = "old-firebase"
`;

describe('parseToml', () => {
  it('reads tables, multi-line arrays, comments and line numbers', () => {
    const t = parseToml(TOML);
    expect(t.get('project_id')).toEqual({ value: 'demo', line: 2 });
    expect(t.get('auth.additional_redirect_urls')).toEqual({ value: ['https://app.example.com/auth/callback', 'https://*.preview.example.com/**'], line: 10 });
    expect(t.get('auth.jwt_expiry')?.value).toBe(3600);
    expect(t.get('auth.enable_signup')?.value).toBe(false);
    expect(t.get('auth.email.template.invite.subject')?.value).toBe('You have been invited');
    expect(t.get("auth.sms.twilio.auth_token")?.value).toBe('env(SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN)');
  });

  it('parses Go durations', () => {
    expect(durationMs('24h')).toBe(86_400_000);
    expect(durationMs('8h30m')).toBe(30_600_000);
    expect(durationMs(3600)).toBe(3_600_000);
    expect(durationMs('soon')).toBeUndefined();
  });
});

describe('translateSupabaseConfig (config.toml)', () => {
  const r = translateSupabaseConfig(settingsFromToml(TOML, 'supabase/config.toml'));
  const auth = (r.documents.instance as { auth_config: Record<string, unknown> }).auth_config;
  const line = (setting: string) => r.report.find((e) => e.setting === setting);

  it('maps sign-up, methods, sessions, passwords and MFA', () => {
    expect(auth).toMatchObject({
      signUpMode: 'restricted',
      requireEmailVerification: true,
      strategies: { anonymous: true, password: true, emailLink: true, emailCode: true, phoneCode: true },
      session: { absoluteMs: 86_400_000, idleMs: 30_600_000 },
      passwordPolicy: { minLength: 10, requireNumber: true, requireLowercase: true, requireUppercase: true, requireSymbol: true },
      mfa: { factors: { totp: true, sms: false } },
    });
  });

  it('keeps file:line on every line read from the file', () => {
    expect(line('auth.enable_signup')).toMatchObject({ status: 'mapped', file: 'supabase/config.toml', line: 17 });
    expect(line('auth.sessions.timebox')).toMatchObject({ status: 'mapped', line: 23 });
    expect(line('auth.additional_redirect_urls')).toMatchObject({ status: 'differs', line: 10 });
    expect(line('auth.external.google.enabled')).toMatchObject({ file: 'supabase/config.toml', line: 58 });
  });

  it('turns providers into Atlas providers, secrets as placeholders', () => {
    expect(r.documents.oauth_providers).toEqual([
      expect.objectContaining({ provider: 'microsoft', client_id: '${MICROSOFT_CLIENT_ID}' }),
      expect.objectContaining({ provider: 'google', client_id: '123.apps.googleusercontent.com', client_secret: '${GOOGLE_CLIENT_SECRET}' }),
    ]);
    expect(line('auth.external.keycloak.enabled')?.status).toBe('manual');
    expect(line('auth.external.google.skip_nonce_check')?.status).toBe('differs');
    expect(line('auth.external.azure.url')?.status).toBe('differs');
    expect(r.report.some((e) => e.setting.startsWith('auth.external.github'))).toBe(false);
    expect(r.documents.redirect_urls).toEqual([{ url: 'http://127.0.0.1:3000' }, { url: 'https://app.example.com/auth/callback' }]);
  });

  it('lists what has to be done by hand', () => {
    for (const s of ['auth.sms.twilio.enabled', 'auth.hook.custom_access_token.enabled', 'auth.third_party.firebase.enabled', 'auth.email.template.invite.subject']) {
      expect(line(s)?.status, s).toBe('manual');
    }
    expect(line('auth.webauthn.rp_id')?.note).toMatch(/--rp-id app\.example\.com/);
    expect(r.bridge).toEqual({ preset: 'supabase', vars: {} });
  });
});

describe('the Management API', () => {
  const API = {
    site_url: 'https://app.example.com',
    uri_allow_list: 'https://app.example.com/cb,https://admin.example.com/cb',
    jwt_exp: 3600,
    disable_signup: false,
    external_email_enabled: true,
    mailer_autoconfirm: false,
    external_phone_enabled: false,
    password_min_length: 8,
    password_required_characters: 'abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789',
    mfa_totp_enroll_enabled: true,
    mfa_phone_enroll_enabled: false,
    sessions_timebox: 0,
    sessions_inactivity_timeout: 43200,
    external_github_enabled: true,
    external_github_client_id: 'Iv1.abc',
    external_github_secret: 'never-copied',
    external_apple_enabled: false,
    hook_send_email_enabled: true,
    rate_limit_email_sent: 30,
  };

  it('folds API fields onto the config.toml paths, reporting the API field', async () => {
    const v = fakeVendor('https://api.supabase.com', { 'GET /v1/projects/abcdefghijklmnopqrst/config/auth': API });
    const settings = await fetchSupabaseAuthConfig({ projectRef: 'abcdefghijklmnopqrst', accessToken: 'sbp_test', fetchImpl: v.fetchImpl });
    expect(v.calls[0]!.headers.get('authorization')).toBe('Bearer sbp_test');
    const r = translateSupabaseConfig(settings);
    const auth = (r.documents.instance as { auth_config: Record<string, unknown> }).auth_config;
    expect(auth).toMatchObject({
      signUpMode: 'public',
      requireEmailVerification: true,
      strategies: { password: true },
      session: { idleMs: 43_200_000 },
      passwordPolicy: { minLength: 8, requireNumber: true, requireUppercase: true, requireLowercase: true },
    });
    expect((auth.session as Record<string, unknown>).absoluteMs).toBeUndefined();
    expect((auth.strategies as Record<string, unknown>).phoneCode).toBeUndefined();
    expect(r.report.find((e) => e.setting === 'disable_signup')).toMatchObject({ status: 'mapped', atlas: 'auth_config.signUpMode' });
    expect(r.report.find((e) => e.setting === 'hook_send_email_enabled')?.status).toBe('manual');
    expect(r.report.every((e) => !e.file)).toBe(true);
    expect(r.documents.oauth_providers).toEqual([expect.objectContaining({ provider: 'github', client_id: 'Iv1.abc' })]);
    expect(JSON.stringify(r.documents)).not.toContain('never-copied');
    expect(r.bridge).toEqual({ preset: 'supabase', vars: { project_ref: 'abcdefghijklmnopqrst' } });
    expect(r.lazy).toEqual({ preset: 'supabase', config: { url: 'https://abcdefghijklmnopqrst.supabase.co' } });
  });

  it('refuses a malformed project ref before calling anything', async () => {
    await expect(fetchSupabaseAuthConfig({ projectRef: '../x', accessToken: 't', fetchImpl: (() => { throw new Error('called'); }) as never })).rejects.toThrow(/project ref/);
  });

  it('reads the character-set requirement', () => {
    expect(settingsFromApi({ password_required_characters: 'abc...:ABC...:012...:!@#' }, 'x').values.get('auth.password_requirements')?.value).toBe('lower_upper_letters_digits_symbols');
  });
});
