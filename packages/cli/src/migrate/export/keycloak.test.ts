import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';
import { fetchKeycloakRealm, keycloakAdminHttp, keycloakPassword, mapKeycloak, readKeycloakExport } from './keycloak';

const realm = JSON.parse(readFileSync(join(__dirname, '__fixtures__/keycloak/acme-realm.json'), 'utf8'));
const JANE = 'b1f2c3d4-0000-4000-8000-00000000jane';
const SAM = 'd6ce8fe7-bab3-4d41-9c38-0ef8cafc2d05';

describe('readKeycloakExport', () => {
  it('reads one realm and merges users chunks of a directory export', () => {
    const { users, ...rest } = realm;
    const snap = readKeycloakExport([rest, { realm: 'acme', users: users.slice(0, 2) }, { realm: 'acme', users: users.slice(2) }]);
    expect(snap.users).toHaveLength(users.length);
    expect(snap.source).toBe('file');
  });
  it('names the realms when several are exported and none is chosen', () => {
    expect(() => readKeycloakExport([{ realm: 'a', enabled: true }, { realm: 'b', enabled: true }])).toThrow(/several realms/);
    expect(readKeycloakExport([{ realm: 'master', enabled: true }, { realm: 'b', enabled: true }]).realm.realm).toBe('b');
  });
  it('refuses a document with no realm', () => {
    expect(() => readKeycloakExport([{ foo: 1 }])).toThrow(/No realm/);
  });
});

describe('keycloakPassword', () => {
  it('maps PBKDF2 to the registry envelope fields', () => {
    const r = keycloakPassword({ credentialData: JSON.stringify({ hashIterations: 27500, algorithm: 'pbkdf2-sha256' }), secretData: JSON.stringify({ value: 'dmFs', salt: 'c2FsdA==' }) });
    expect(r).toEqual({ hash: { algorithm: 'pbkdf2', hash: 'dmFs', salt: 'c2FsdA==', params: { digest: 'sha256', iterations: 27500, encoding: 'base64', salt_encoding: 'base64' } } });
  });
  it('builds a PHC string for Argon2 and reads the legacy flat credential shape', () => {
    const a = keycloakPassword({
      credentialData: JSON.stringify({ hashIterations: 3, algorithm: 'argon2', additionalParameters: { memory: ['7168'], parallelism: ['1'], type: ['id'], version: ['1.3'] } }),
      secretData: JSON.stringify({ value: 'aGFzaA==', salt: 'c2FsdA==' }),
    });
    expect(a).toEqual({ hash: { algorithm: 'argon2', hash: '$argon2id$v=19$m=7168,t=3,p=1$c2FsdA$aGFzaA' } });
    expect('hash' in keycloakPassword({ algorithm: 'pbkdf2-sha512', hashIterations: 30000, hashedSaltedValue: 'dmFs', salt: 'c2FsdA==' })).toBe(true);
  });
  it('refuses what it cannot verify', () => {
    expect(keycloakPassword({ credentialData: '{"algorithm":"md5"}', secretData: '{"value":"x","salt":"y"}' })).toEqual({ problem: 'unsupported hash algorithm "md5"' });
    expect('problem' in keycloakPassword({ secretData: '{}' })).toBe(true);
  });
});

describe('mapKeycloak (realm export)', () => {
  const set = mapKeycloak(readKeycloakExport([realm]));
  const user = (id: string) => set.list('user').find((u) => u.id === id)!;

  it('keeps the Keycloak user id (the sub of its tokens) and drops service accounts', () => {
    expect(user(JANE).emails?.[0]).toMatchObject({ email: 'jane@acme.example', verified: true });
    expect(set.list('user').some((u) => u.id.startsWith('5e5e'))).toBe(false);
    expect(set.omitted.user?.reason).toMatch(/service-account/);
  });
  it('carries password hashes, passwords it cannot verify become warnings', () => {
    expect(user(JANE).password?.algorithm).toBe('argon2');
    expect(user(SAM).password).toMatchObject({ algorithm: 'pbkdf2', params: { digest: 'sha256', iterations: 27500 } });
    expect(set.warnings.join('\n')).toMatch(/imported without a password/);
  });
  it('carries TOTP, recovery codes and passkeys', () => {
    const types = set.list('mfa_factor').map((f) => f.type);
    expect(types).toContain('totp');
    expect(set.list('passkey')).toHaveLength(1);
    expect(set.list('passkey')[0]!.user_id).toBe(JANE);
  });
  it('links social identities and maps SAML and OIDC providers to SSO connections', () => {
    expect(set.list('identity').some((i) => i.provider === 'google' && i.provider_user_id === '1093849')).toBe(true);
    expect(set.list('sso_connection').map((c) => c.protocol).sort()).toEqual(['oidc', 'saml']);
  });
  it('maps Keycloak organizations with their members, ignoring unknown members', () => {
    expect(set.list('organization').some((o) => o.name === 'Partner Co')).toBe(true);
    expect(set.list('membership').filter((m) => m.organization_id === 'org-partner')).toHaveLength(2);
  });
  it('maps realm and client roles and groups as roles by default, groups as organizations on request', () => {
    const keys = set.list('role').map((r) => r.key);
    expect(keys).toContain('admin');
    expect(keys.some((k) => k.includes('engineering'))).toBe(true);
    const orgs = mapKeycloak(readKeycloakExport([realm]), { groupsAs: 'organizations' });
    expect(orgs.list('organization').length).toBeGreaterThan(set.list('organization').length);
  });
  it('states that sessions are not exportable', () => {
    expect(set.warnings.join('\n')).toMatch(/sessions are not exportable/);
  });
});

describe('Admin API export', () => {
  const origin = 'https://sso.example.com';
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- `users` is split off so the realm below omits it
  const { users, ...rest } = realm;
  const api = () =>
    fakeVendor(origin, {
      'POST /realms/acme/protocol/openid-connect/token': { access_token: 'tok', expires_in: 300 },
      'GET /admin/realms/acme': { ...rest, organizationsEnabled: false },
      'GET /admin/realms/acme/identity-provider/instances': rest.identityProviders ?? [],
      'GET /admin/realms/acme/clients': [],
      'GET /admin/realms/acme/roles?briefRepresentation=false': [{ name: 'admin' }],
      'GET /admin/realms/acme/users?briefRepresentation=false&first=0&max=100': [
        { id: SAM, username: 'sam', email: 'sam@acme.example', emailVerified: true, enabled: true, createdTimestamp: 1700000000000 },
        { id: 'svc', username: 'service-account-x', serviceAccountClientId: 'x' },
      ],
      [`GET /admin/realms/acme/users/${SAM}/federated-identity`]: [],
      [`GET /admin/realms/acme/users/${SAM}/groups?briefRepresentation=false`]: [],
      [`GET /admin/realms/acme/users/${SAM}/role-mappings`]: { realmMappings: [{ name: 'admin' }] },
      [`GET /admin/realms/acme/users/${SAM}/credentials`]: [{ type: 'password', credentialData: '{"algorithm":"pbkdf2-sha256","hashIterations":1}' }, { type: 'otp' }],
    });

  it('signs in with the admin client, reads users without secrets and says so', async () => {
    const fake = api();
    const http = keycloakAdminHttp({ baseUrl: origin, realm: 'acme', clientId: 'admin', clientSecret: 's', fetchImpl: fake.fetchImpl, sleep: noSleep });
    const snap = await fetchKeycloakRealm(http, { realm: 'acme', baseUrl: origin });
    const set = mapKeycloak(snap);
    expect(snap.source).toBe('api');
    expect(set.list('user')).toHaveLength(1);
    expect(set.list('user')[0]!.password).toBeUndefined();
    expect(set.list('user')[0]!.roles).toContain('admin');
    expect(set.warnings.join('\n')).toMatch(/never returns password hashes/);
    expect(set.warnings.join('\n')).toMatch(/OTP secrets/);
    expect(fake.calls[0]!.url).toContain('/protocol/openid-connect/token');
  });
  it('needs a credential', () => {
    expect(() => keycloakAdminHttp({ baseUrl: origin, realm: 'acme' })).toThrow(/admin client/);
  });
});
