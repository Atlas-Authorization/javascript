import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';
import { keycloakAdminHttp } from './keycloak';
import { fetchKeycloakConfig, parsePasswordPolicy, translateKeycloakConfig } from './keycloak-config';

const realm = JSON.parse(readFileSync(join(__dirname, '__fixtures__/keycloak/acme-realm.json'), 'utf8'));
const { users: _users, ...realmNoUsers } = realm;
const t = translateKeycloakConfig(realmNoUsers, { baseUrl: 'https://sso.example.com' });
const auth = (t.documents.instance as { auth_config: Record<string, any> }).auth_config;
const entry = (setting: string) => t.report.find((r) => r.setting === setting);

describe('parsePasswordPolicy', () => {
  it('reads the policy expression', () => {
    expect(parsePasswordPolicy('length(12) and digits(1) and notUsername(undefined) and hashAlgorithm(argon2)')).toEqual({ length: ['12'], digits: ['1'], notUsername: [], hashAlgorithm: ['argon2'] });
    expect(parsePasswordPolicy(undefined)).toEqual({});
  });
});

describe('translateKeycloakConfig', () => {
  it('maps the password policy rules', () => {
    expect(auth.passwordPolicy).toMatchObject({ minLength: 12, maxLength: 64, requireNumber: true, requireUppercase: true, requireLowercase: true, rejectIdentifierSubstring: true, historyCount: 3 });
    expect(entry('passwordPolicy hashAlgorithm(argon2)')?.status).toBe('differs');
  });
  it('maps sign-up, email verification, usernames and session lifetimes', () => {
    expect(auth.signUpMode).toBeUndefined();
    expect(auth.requireEmailVerification).toBe(true);
    expect(auth.strategies.username).toBe(true);
    expect(auth.session).toMatchObject({ idleMs: 1_800_000, absoluteMs: 36_000_000, jwtTtlSeconds: 300 });
  });
  it('maps OTP and WebAuthn policy and brute-force detection', () => {
    expect(auth.mfa.factors.totp).toBe(true);
    expect(entry('bruteForceProtected')?.status).toBe('mapped');
  });
  it('turns social brokers into providers without copying secrets, and enterprise brokers into SSO notes', () => {
    const providers = (t.documents.oauth_providers as Array<Record<string, string>>) ?? [];
    expect(providers.map((p) => p.provider)).toEqual(['google']);
    for (const p of providers) expect(p.client_secret).toMatch(/^\$\{[A-Z_]+\}$/);
    expect(t.report.filter((r) => r.area === 'identity providers' && r.atlas === 'sso_connections')).toHaveLength(2);
  });
  it('reports what has no counterpart', () => {
    expect(entry('themes')?.status).toBe('manual');
    expect(entry('smtpServer')?.status).toBe('manual');
    expect(entry('internationalization')?.status).toBe('manual');
  });
  it('hands the bridge and lazy steps the realm and base URL', () => {
    expect(t.bridge).toEqual({ preset: 'keycloak', vars: { realm: 'acme', base_url: 'https://sso.example.com' } });
    expect(t.lazy?.preset).toBe('keycloak');
    expect(t.origin).toBe('Keycloak realm acme');
  });
  it('closes sign-up when registration is off and names roles', () => {
    const closed = translateKeycloakConfig({ realm: 'x', registrationAllowed: false, roles: { realm: [{ name: 'Editor' }, { name: 'offline_access' }, { name: 'default-roles-x' }] } });
    expect((closed.documents.instance as any).auth_config.signUpMode).toBe('restricted');
    expect(closed.documents.roles).toEqual([{ key: 'editor', name: 'Editor', description: '', permissions: [] }]);
  });
});

describe('fetchKeycloakConfig', () => {
  it('reads the realm, its clients and identity providers through the Admin API', async () => {
    const origin = 'https://sso.example.com';
    const fake = fakeVendor(origin, {
      'POST /realms/acme/protocol/openid-connect/token': { access_token: 'tok', expires_in: 300 },
      'GET /admin/realms/acme': { realm: 'acme', registrationAllowed: true },
      'GET /admin/realms/acme/identity-provider/instances': [{ alias: 'google', providerId: 'google' }],
      'GET /admin/realms/acme/clients': [{ id: 'c1', clientId: 'acme-web', redirectUris: ['https://app.example.com/cb'] }],
      'GET /admin/realms/acme/clients/c1/roles': [],
      'GET /admin/realms/acme/roles?briefRepresentation=false': [{ name: 'admin' }],
      'GET /admin/realms/acme/users?briefRepresentation=false&first=0&max=1': [],
    });
    const http = keycloakAdminHttp({ baseUrl: origin, realm: 'acme', clientId: 'a', clientSecret: 's', fetchImpl: fake.fetchImpl, sleep: noSleep });
    const realmDoc = await fetchKeycloakConfig(http, 'acme', origin);
    const r = translateKeycloakConfig(realmDoc);
    expect(r.documents.redirect_urls).toEqual([{ url: 'https://app.example.com/cb' }]);
    expect((r.documents.roles as Array<{ key: string }>).map((x) => x.key)).toEqual(['admin']);
  });
});
