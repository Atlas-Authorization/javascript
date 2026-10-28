import { describe, expect, it } from 'vitest';
import { readToml, translateNhostConfig } from './nhost-config';

/** nhost/nhost.toml as the Nhost CLI writes it (trimmed to the auth-relevant tables). */
const TOML = `[global]
[[global.environment]]
name = 'ENVIRONMENT'
value = 'production'

[hasura]
version = 'v2.36.0'
adminSecret = '{{ secrets.HASURA_GRAPHQL_ADMIN_SECRET }}'

[[hasura.jwtSecrets]]
type = 'HS256'
key = '{{ secrets.HASURA_GRAPHQL_JWT_SECRET }}'
issuer = 'https://abcdefgh.auth.eu-central-1.nhost.run/v1'

[auth]
version = '0.36.1'

[auth.redirections]
clientUrl = 'https://app.example.com'
allowedUrls = [
  'https://app.example.com/callback', # the SPA
  'myapp://auth',
]

[auth.signUp]
enabled = true
disableNewUsers = true

[auth.user.roles]
default = 'user'
allowed = ['user', 'me', 'editor']

[auth.user.emailDomains]
allowed = ['example.com']
blocked = []

[auth.session.accessToken]
expiresIn = 900

[[auth.session.accessToken.customClaims]]
key = 'organisationId'
value = 'profile.organisation.id'

[auth.session.refreshToken]
expiresIn = 2592000

[auth.method.anonymous]
enabled = false

[auth.method.emailPassword]
hibpEnabled = true
emailVerificationRequired = true
passwordMinLength = 9

[auth.method.oauth.github]
enabled = true
clientId = 'Iv1.0123456789'
clientSecret = '{{ secrets.GITHUB_CLIENT_SECRET }}'

[auth.method.oauth.strava]
enabled = true
clientId = '{{ secrets.STRAVA_CLIENT_ID }}'

[auth.method.oauth.google]
enabled = false

[auth.method.webauthn]
enabled = true
relyingParty = { id = 'example.com', name = "Example \\"App\\"", origins = ['https://app.example.com'] }

[auth.totp]
enabled = true
issuer = 'Example'
`;

describe('readToml', () => {
  it('flattens tables, arrays of tables, multi-line arrays and inline tables with lines', () => {
    const t = readToml(TOML);
    expect(t.get('auth.method.emailPassword.passwordMinLength')).toEqual({ value: 9, line: 53 });
    expect(t.get('auth.redirections.allowedUrls')).toEqual({ value: ['https://app.example.com/callback', 'myapp://auth'], line: 20 });
    expect(t.get('auth.session.accessToken.customClaims.0.key')?.value).toBe('organisationId');
    expect(t.get('hasura.jwtSecrets.0.issuer')?.value).toBe('https://abcdefgh.auth.eu-central-1.nhost.run/v1');
    expect(t.get('auth.method.webauthn.relyingParty.id')?.value).toBe('example.com');
    expect(t.get('auth.method.webauthn.relyingParty.name')?.value).toBe('Example "App"');
    expect(t.get('auth.signUp.disableNewUsers')?.value).toBe(true);
  });
});

describe('translateNhostConfig', () => {
  it('maps nhost.toml auth settings with file:line', () => {
    const t = translateNhostConfig({ path: 'nhost/nhost.toml', text: TOML }, { authUrl: 'https://abcdefgh.auth.eu-central-1.nhost.run/v1/' });
    const auth = (t.documents.instance as { auth_config: Record<string, unknown> }).auth_config;
    expect(auth.signUpMode).toBe('restricted');
    expect(auth.strategies).toEqual({ password: true, passkey: true });
    expect(auth.passwordPolicy).toEqual({ minLength: 9, checkBreaches: true });
    expect(auth.requireEmailVerification).toBe(true);
    expect(auth.session).toEqual({ absoluteMs: 2592000_000, jwtTtlSeconds: 900 });
    expect(auth.mfa).toEqual({ factors: { totp: true } });

    const row = (setting: string) => t.report.find((r) => r.setting === setting);
    expect(row('auth.signUp.disableNewUsers')).toMatchObject({ status: 'mapped', file: 'nhost/nhost.toml', line: 27 });
    expect(row('auth.method.emailPassword.passwordMinLength')).toMatchObject({ status: 'mapped', line: 53 });
    expect(row('auth.method.oauth.github')).toMatchObject({ status: 'differs', line: 56 });
    // Strava is not an Atlas built-in provider.
    expect(row('auth.method.oauth.strava.enabled')).toMatchObject({ status: 'manual', line: 61 });
    expect(row('auth.session.accessToken.customClaims')).toMatchObject({ status: 'manual', line: 40 });
    expect(row('auth.user.emailDomains.allowed')?.status).toBe('manual');
    expect(row('auth.user.emailDomains.blocked')).toBeUndefined();
    expect(row('hasura.jwtSecrets.issuer')).toMatchObject({ status: 'mapped', line: 13 });
    expect(row('auth.method.webauthn.relyingParty.id')).toMatchObject({ status: 'mapped', line: 69 });

    const github = (t.documents.oauth_providers as Array<Record<string, unknown>>)[0]!;
    expect(github).toMatchObject({ provider: 'github', client_id: 'Iv1.0123456789', client_secret: '${GITHUB_CLIENT_SECRET}' });
    expect(t.documents.roles).toEqual([{ key: 'editor', name: 'editor', description: 'Hasura role from Nhost', permissions: [] }]);
    expect(t.documents.redirect_urls).toEqual([{ url: 'https://app.example.com/callback' }, { url: 'https://app.example.com' }]);
    expect(t.bridge).toEqual({ preset: 'nhost', vars: {} });
    expect(t.lazy).toEqual({ preset: 'nhost', config: { auth_url: 'https://abcdefgh.auth.eu-central-1.nhost.run/v1' } });
  });

  it('reports a file without [auth]', () => {
    const t = translateNhostConfig({ path: 'nhost.toml', text: '[hasura]\nversion = "v2"\n' });
    expect(t.report[0]).toMatchObject({ status: 'manual', setting: '[auth]' });
  });
});
