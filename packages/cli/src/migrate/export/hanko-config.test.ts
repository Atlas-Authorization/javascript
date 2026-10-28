import { describe, expect, it } from 'vitest';
import { goDurationMs, settingsFromYaml, translateHankoConfig } from './hanko-config';

/** A config.yaml as the Hanko docs and the Docker quickstart write it. */
const YAML = `database:
  database: hanko
  host: localhost
  password: db-secret-pw
  user: hanko
secrets:
  keys:
    - abcdefghijklmnopqrstuvwxyz
service:
  name: Acme
server:
  public:
    cors:
      allow_origins:
        - https://app.example.com
        - https://*.preview.example.com
session:
  lifespan: 12h
  issuer: https://auth.example.com
  cookie:
    name: hanko
    domain: example.com
password:
  enabled: true
  min_length: 10
  optional: false
passcode:
  ttl: 300
  email:
    enabled: true
  smtp:
    host: smtp.example.com
    user: mailer
    password: smtp-secret
email:
  require_verification: true
  can_login_with_unverified: false
username:
  enabled: true
  min_length: 3
passkey:
  enabled: true
  user_verification: preferred
webauthn:
  relying_party:
    id: example.com
    display_name: Acme
    origins:
      - https://app.example.com
mfa:
  totp:
    enabled: true
  security_keys:
    enabled: false
  optional: true
saml:
  enabled: true
  default_redirect_url: https://app.example.com/saml
  allowed_redirect_urls:
    - https://app.example.com/saml
  identity_providers:
    - enabled: true
      name: Corp
      domain: corp.example
      metadata_url: https://idp.corp.example/metadata
third_party:
  redirect_url: https://auth.example.com/thirdparty/callback
  default_redirect_url: https://app.example.com
  error_redirect_url: https://app.example.com/error
  allowed_redirect_urls:
    - https://app.example.com
    - https://*.preview.example.com
  providers:
    github:
      enabled: true
      client_id: Iv1.abc
      secret: ghs-secret
      allow_signup: true
    google:
      enabled: true
      client_id: 123.apps.googleusercontent.com
      secret: google-secret
      allow_signup: false
    linkedin:
      enabled: false
    custom_keycloak:
      enabled: true
      display_name: Corp SSO
      client_id: hanko
      secret: kc-secret
      discovery_endpoint: https://sso.corp.example/realms/main/.well-known/openid-configuration
      scopes: [openid, email, profile]
webhooks:
  enabled: true
rate_limiter:
  enabled: true
account_deletion:
  enabled: true
`;

const lineOf = (needle: string) => YAML.split('\n').findIndex((l) => l.includes(needle)) + 1;

describe('goDurationMs', () => {
  it('reads Go durations', () => {
    expect(goDurationMs('12h')).toBe(43_200_000);
    expect(goDurationMs('1h30m')).toBe(5_400_000);
    expect(goDurationMs('90s')).toBe(90_000);
    expect(goDurationMs(300)).toBe(300_000);
    expect(goDurationMs('soon')).toBeUndefined();
    expect(goDurationMs(undefined)).toBeUndefined();
  });
});

describe('translateHankoConfig', () => {
  const settings = settingsFromYaml(YAML, 'config.yaml', 'https://auth.example.com');
  const out = translateHankoConfig(settings);
  const auth = (out.documents.instance as { auth_config: Record<string, unknown>; allowed_origins: string[] }).auth_config;
  const rep = (setting: string) => out.report.find((r) => r.setting === setting);

  it('never keeps a secret, in memory or in the output', () => {
    for (const secret of ['db-secret-pw', 'abcdefghijklmnopqrstuvwxyz', 'smtp-secret', 'ghs-secret', 'google-secret', 'kc-secret']) {
      expect(JSON.stringify(out)).not.toContain(secret);
      expect(JSON.stringify([...settings.values.values()])).not.toContain(secret);
    }
  });

  it('translates sessions, sign-in methods and the password policy, with file and line', () => {
    expect(auth.session).toEqual({ absoluteMs: 43_200_000 });
    expect(rep('session.lifespan')).toMatchObject({ status: 'mapped', file: 'config.yaml', line: lineOf('lifespan') });
    expect(auth.strategies).toEqual({ password: true, emailCode: true, passkey: true });
    expect(auth.passwordPolicy).toEqual({ minLength: 10 });
    expect(auth.requireEmailVerification).toBe(true);
    expect(rep('password.optional')?.status).toBe('differs');
  });

  it('translates second factors and says how enrolment differs', () => {
    expect((auth.mfa as { factors: Record<string, unknown> }).factors).toEqual({ totp: true, passkey: false });
    expect(rep('mfa.totp.enabled')?.note).toMatch(/database export/);
    expect(rep('mfa.optional')?.status).toBe('differs');
  });

  it('maps exact origins and redirect URLs, and reports wildcards', () => {
    expect((out.documents.instance as { allowed_origins: string[] }).allowed_origins).toEqual(['https://app.example.com']);
    expect(out.documents.redirect_urls).toEqual([{ url: 'https://app.example.com' }, { url: 'https://app.example.com/saml' }, { url: 'https://app.example.com/error' }]);
    expect(out.report.some((r) => r.area === 'origins' && r.status === 'differs')).toBe(true);
    expect(rep('third_party.allowed_redirect_urls')).toMatchObject({ status: 'differs' });
  });

  it('maps built-in providers with placeholders and honours allow_signup', () => {
    const providers = out.documents.oauth_providers as Array<Record<string, unknown>>;
    expect(providers.map((p) => p.provider)).toEqual(['github', 'google']);
    expect(providers[0]).toMatchObject({ client_id: 'Iv1.abc', client_secret: '${GITHUB_CLIENT_SECRET}', allow_sign_up: true });
    expect(providers[1]).toMatchObject({ allow_sign_up: false });
    expect(providers.some((p) => p.provider === 'linkedin')).toBe(false);
  });

  it('maps a custom OIDC provider with its discovery URL and scopes', () => {
    expect((out.documents.custom_oauth_providers as unknown[])[0]).toMatchObject({
      provider_key: 'keycloak',
      display_name: 'Corp SSO',
      client_id: 'hanko',
      client_secret: '${KEYCLOAK_CLIENT_SECRET}',
      discovery_url: 'https://sso.corp.example/realms/main/.well-known/openid-configuration',
      scopes: ['openid', 'email', 'profile'],
    });
    expect(out.mappings.providers).toMatchObject({ github: 'github', custom_keycloak: 'keycloak' });
  });

  it('lists SAML identity providers, SMTP, usernames, webhooks and passkey domain as manual work', () => {
    expect(rep('saml.identity_providers Corp')).toMatchObject({ status: 'manual', atlas: 'sso_connections' });
    expect(rep('saml.identity_providers Corp')?.note).toContain('https://idp.corp.example/metadata');
    expect(rep('passcode.smtp.host')?.status).toBe('manual');
    expect(rep('username.enabled')?.note).toMatch(/minimum 3/);
    expect(rep('webhooks.enabled')?.status).toBe('manual');
    expect(rep('webauthn.relying_party.id')?.note).toContain('--set hanko-rp-id=example.com');
    expect(rep('session.cookie.domain')?.status).toBe('differs');
  });

  it('hands the bridge and lazy steps what it learned', () => {
    expect(out.bridge).toEqual({ preset: 'hanko', vars: { base_url: 'https://auth.example.com' } });
    expect(out.lazy).toEqual({ preset: 'hanko', config: { base_url: 'https://auth.example.com' } });
    const custom = translateHankoConfig(settingsFromYaml(YAML.replace('issuer: https://auth.example.com', 'issuer: https://example.com'), 'config.yaml', 'https://auth.example.com'));
    expect(custom.bridge).toEqual({ preset: 'hanko_jwt', vars: { base_url: 'https://auth.example.com', issuer: 'https://example.com' } });
    const noUrl = translateHankoConfig(settingsFromYaml(YAML, 'config.yaml'));
    expect(noUrl.bridge).toBeUndefined();
    expect(noUrl.report.some((r) => r.area === 'bridge' && /hanko-api-url/.test(r.note))).toBe(true);
  });

  it('flags a session cookie with another name', () => {
    const r = translateHankoConfig(settingsFromYaml(YAML.replace('name: hanko\n    domain', 'name: acme_session\n    domain'), 'config.yaml'));
    expect(r.report.find((x) => x.setting === 'session.cookie.name')?.note).toContain('acme_session');
  });

  it('reads an empty config without error and rejects malformed YAML with the line', () => {
    expect(translateHankoConfig(settingsFromYaml('{}\n', 'empty.yaml')).documents).toEqual({});
    expect(() => settingsFromYaml('a:\n  - b: 1\n   c: 2\n', 'bad.yaml')).toThrow(/line/i);
  });
});
