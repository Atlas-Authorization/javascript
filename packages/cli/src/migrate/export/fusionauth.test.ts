import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';
import { Tables } from './frameworks/tables';
import { fetchFusionAuth, fusionAuthHttp, fusionAuthPassword, fusionAuthSnapshotFromTables, mapFusionAuth } from './fusionauth';

const TENANT = 'f9a1d4c0-0000-4000-8000-000000000001';
const APP = '85a03867-dccf-4882-adde-1a79aeec50df';
const U1 = '00000000-0000-0000-0000-000000000001';
const U2 = '00000000-0000-0000-0000-000000000002';
const GROUP = 'a1a1a1a1-0000-4000-8000-0000000000aa';
const IDP_SAML = 'b2b2b2b2-0000-4000-8000-0000000000bb';
const IDP_GOOGLE = '82339786-3dff-42a6-aac6-1f1ceecb6c46';

describe('fusionAuthPassword', () => {
  it('maps the default PBKDF2 scheme with FusionAuth sample values', () => {
    expect(fusionAuthPassword({ password: 'ULoj1fuENZ+QvRqoaOhZ2YX6vuI7uqi7pY0a1EcE32Q=', salt: 'u8ikPE4m35czpQArp2lDLYDGpIIo+FC+wiNzCclLRbw=', factor: 24000, encryptionScheme: 'salted-pbkdf2-hmac-sha256' })).toEqual({
      hash: {
        algorithm: 'pbkdf2',
        hash: 'ULoj1fuENZ+QvRqoaOhZ2YX6vuI7uqi7pY0a1EcE32Q=',
        salt: 'u8ikPE4m35czpQArp2lDLYDGpIIo+FC+wiNzCclLRbw=',
        params: { digest: 'sha256', iterations: 24000, encoding: 'base64', salt_encoding: 'base64' },
      },
    });
  });
  it('rebuilds a bcrypt digest from salt, factor and the stored remainder', () => {
    const r = fusionAuthPassword({ password: 'E5YPO9kmyuRGyh0XouQYb4YMJKvyOeW', salt: 'CCCCCCCCCCCCCCCCCCCCC.', factor: 5, encryptionScheme: 'bcrypt' });
    expect(r).toEqual({ hash: { algorithm: 'bcrypt', hash: '$2a$05$CCCCCCCCCCCCCCCCCCCCC.E5YPO9kmyuRGyh0XouQYb4YMJKvyOeW' } });
  });
  it('names the registry ids for the salted digests, HMAC and phpass', () => {
    expect(fusionAuthPassword({ password: 'x', salt: 's', factor: 20000, encryptionScheme: 'salted-sha256' })).toMatchObject({ hash: { algorithm: 'fusionauth_salted', params: { digest: 'sha256', iterations: 20000 } } });
    expect(fusionAuthPassword({ password: 'x', salt: 's', factor: 1, encryptionScheme: 'salted-md5' })).toMatchObject({ hash: { algorithm: 'fusionauth_salted', params: { digest: 'md5' } } });
    expect(fusionAuthPassword({ password: 'x', salt: 's', factor: 2048, encryptionScheme: 'phpass-md5' })).toMatchObject({ hash: { algorithm: 'fusionauth_phpass', params: { digest: 'md5', iterations: 2048 } } });
    expect(fusionAuthPassword({ password: 'x', salt: 's', encryptionScheme: 'salted-hmac-sha256' })).toMatchObject({ hash: { algorithm: 'hmac_sha256' } });
  });
  it('reports what it cannot verify and ignores users without a password', () => {
    expect(fusionAuthPassword({ password: 'x', salt: 's', factor: 1, encryptionScheme: 'my-plugin' })).toEqual({ problem: 'the "my-plugin" scheme (a custom password plugin)' });
    expect(fusionAuthPassword({ password: 'x', encryptionScheme: 'bcrypt' })).toMatchObject({ problem: expect.stringMatching(/bcrypt without/) });
    expect(fusionAuthPassword({})).toBeNull();
  });
});

const tables = () =>
  new Tables({
    tenants: [{ id: TENANT, name: 'Default', data: JSON.stringify({ issuer: 'acme.com' }) }],
    applications: [{ id: APP, name: 'Acme Web', tenants_id: TENANT }],
    application_roles: [
      { id: 'r1', applications_id: APP, name: 'admin', is_super_role: 'true' },
      { id: 'r2', applications_id: APP, name: 'Billing Manager' },
    ],
    groups: [{ id: GROUP, name: 'Engineering', tenants_id: TENANT }],
    group_application_roles: [{ groups_id: GROUP, application_roles_id: 'r2' }],
    group_members: [{ groups_id: GROUP, users_id: U1 }],
    users: [
      { id: U1, tenants_id: TENANT, email: 'Jane@Acme.example', verified: 't', username: 'jane', first_name: 'Jane', last_name: 'Doe', mobile_phone: '+1 415 555 0100', active: 't', insert_instant: 1700000000000, last_login_instant: 1700000100000, password: 'ULoj1fuENZ+QvRqoaOhZ2YX6vuI7uqi7pY0a1EcE32Q=', salt: 'u8ikPE4m35czpQArp2lDLYDGpIIo+FC+wiNzCclLRbw=', factor: 24000, encryption_scheme: 'salted-pbkdf2-hmac-sha256', data: '{"plan":"pro"}' },
      { id: U2, tenants_id: TENANT, email: 'old@acme.example', verified: 'f', active: 'f', password: 'x', salt: 's', factor: 1, encryption_scheme: 'my-plugin' },
    ],
    user_registrations: [{ id: 'reg1', users_id: U1, applications_id: APP, verified: 't' }],
    user_registrations_application_roles: [{ user_registrations_id: 'reg1', application_roles_id: 'r1' }],
    identity_providers: [
      { id: IDP_GOOGLE, type: 'Google', name: 'Google', enabled: 't', data: '{}' },
      { id: IDP_SAML, type: 'SAMLv2', name: 'Partner', enabled: 't', data: JSON.stringify({ idpEndpoint: 'https://idp.partner.example/sso', issuer: 'https://idp.partner.example', domains: ['Partner.example'], keyId: 'k1' }) },
    ],
    keys: [{ id: 'k1', public_key: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----' }],
    identity_provider_links: [
      { identity_providers_id: IDP_GOOGLE, users_id: U1, identity_provider_user_id: '1093849' },
      { identity_providers_id: IDP_SAML, users_id: U1, identity_provider_user_id: 'jane@partner.example' },
    ],
    twofactor_methods: [
      { id: 'm1', users_id: U1, method: 'authenticator', secret: Buffer.from('12345678901234567890').toString('base64'), settings: '{"authenticator":{"algorithm":"HmacSHA1","codeLength":6,"timeStep":30}}' },
      { id: 'm2', users_id: U1, method: 'sms', mobile_phone: '+14155550100' },
    ],
    twofactor_recovery_codes: [{ users_id: U1, recovery_codes: '["AAAA-1111","BBBB-2222"]' }],
    api_keys: [
      { id: 'k-1', key_value: 'sup3rs3cretkeyvalue', key_manager: 'f', meta_data: '{"attributes":{"description":"ci"}}' },
      { id: 'k-2', key_value: 'managerkey', key_manager: 't' },
    ],
  });

describe('mapFusionAuth (database dump)', () => {
  const set = mapFusionAuth(fusionAuthSnapshotFromTables(tables()));
  const jane = () => set.list('user').find((u) => u.id === U1)!;

  it('keeps the FusionAuth user id and the profile', () => {
    expect(jane().emails).toEqual([{ email: 'jane@acme.example', verified: true, primary: true }]);
    expect(jane().phones?.[0]?.phone).toBe('+14155550100');
    expect(jane().username).toBe('jane');
    expect(jane().created_at).toBe(1700000000000);
    expect(jane().private_metadata).toMatchObject({ plan: 'pro' });
  });
  it('carries the password hash and reports an unverifiable scheme', () => {
    expect(jane().password?.algorithm).toBe('pbkdf2');
    expect(set.list('user').find((u) => u.id === U2)?.password).toBeUndefined();
    expect(set.list('user').find((u) => u.id === U2)?.banned).toBe(true);
    expect(set.warnings.join('\n')).toMatch(/custom password plugin/);
  });
  it('maps application roles to roles and registrations and group roles to user roles', () => {
    expect(set.list('role').map((r) => r.key)).toEqual(expect.arrayContaining(['admin', 'billing_manager']));
    expect(jane().roles?.sort()).toEqual(['admin', 'billing_manager']);
  });
  it('maps groups to organizations with memberships', () => {
    expect(set.list('organization').map((o) => o.name)).toEqual(['Engineering']);
    expect(set.list('membership')).toEqual([{ organization_id: `group:${GROUP}`, user_id: U1, role: 'member' }]);
  });
  it('turns the authenticator secret to base32 (a known RFC 6238 key), SMS and recovery codes into factors', () => {
    const f = set.list('mfa_factor');
    expect(f.find((x) => x.type === 'totp')).toMatchObject({ secret_base32: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', digits: 6, period: 30, algorithm: 'SHA1' });
    expect(f.find((x) => x.type === 'phone')?.phone).toBe('+14155550100');
    expect(f.find((x) => x.type === 'backup_codes')?.backup_codes).toEqual(['AAAA-1111', 'BBBB-2222']);
  });
  it('maps SAML to an SSO connection and Google to a social identity', () => {
    expect(set.list('sso_connection')).toHaveLength(1);
    expect(set.list('sso_connection')[0]).toMatchObject({ id: IDP_SAML, protocol: 'saml', domains: ['partner.example'], saml: { idp_sso_url: 'https://idp.partner.example/sso' } });
    const ids = set.list('identity');
    expect(ids.find((i) => i.provider === 'google')?.provider_user_id).toBe('1093849');
    expect(ids.find((i) => i.kind === 'saml')?.sso_connection_id).toBe(IDP_SAML);
  });
  it('stores API keys as SHA-256 hashes and leaves key managers out', () => {
    expect(set.list('api_key')).toHaveLength(1);
    expect(set.list('api_key')[0]).toMatchObject({ hash: createHash('sha256').update('sup3rs3cretkeyvalue').digest('hex'), hash_algorithm: 'sha256', start: 'sup3rs' });
    expect(set.omitted.api_key?.count).toBe(1);
  });
  it('can move groups as roles', () => {
    const roles = mapFusionAuth(fusionAuthSnapshotFromTables(tables()), { groupsAs: 'roles' });
    expect(roles.list('role').some((r) => r.key === 'group:engineering')).toBe(true);
    expect(roles.list('organization')).toHaveLength(0);
  });
});

describe('FusionAuth API export', () => {
  const origin = 'https://auth.example.com';
  const api = () =>
    fakeVendor(origin, {
      'GET /api/tenant': { tenants: [{ id: TENANT, name: 'Default', issuer: 'acme.com' }] },
      'GET /api/application': { applications: [{ id: APP, name: 'Acme Web', roles: [{ name: 'admin' }] }] },
      'GET /api/group': { groups: [] },
      'GET /api/identity-provider': { identityProviders: [] },
      'GET /api/api-key': { status: 403 },
      'POST /api/user/search': {
        total: 1,
        users: [{ id: U1, tenantId: TENANT, email: 'jane@acme.example', verified: true, active: true, registrations: [{ applicationId: APP, roles: ['admin'] }], twoFactor: { methods: [{ id: 'm1', method: 'authenticator', authenticator: { algorithm: 'HmacSHA1', codeLength: 6, timeStep: 30 } }] } }],
      },
      [`GET /api/identity-provider/link?userId=${U1}`]: { identityProviderLinks: [] },
      [`GET /api/user/two-factor/recovery-code/${U1}`]: { recoveryCodes: ['CODE-1'] },
    });

  it('reads users with their roles and recovery codes, and says what the API cannot return', async () => {
    const fake = api();
    const http = fusionAuthHttp({ baseUrl: origin, apiKey: 'key', tenantId: TENANT, fetchImpl: fake.fetchImpl, sleep: noSleep });
    const warnings: string[] = [];
    const snap = await fetchFusionAuth(http, { baseUrl: origin, warn: (m) => warnings.push(m) });
    const set = mapFusionAuth(snap);
    expect(snap.source).toBe('api');
    expect(set.list('user')).toHaveLength(1);
    expect(set.list('user')[0]!.password).toBeUndefined();
    expect(set.list('user')[0]!.roles).toEqual(['admin']);
    expect(set.list('mfa_factor').map((f) => f.type)).toEqual(['backup_codes']);
    expect(set.warnings.join('\n')).toMatch(/never returns password hashes/);
    expect(set.warnings.join('\n')).toMatch(/authenticator secrets/);
    expect(warnings.join('\n')).toMatch(/API keys could not be read/);
    expect(fake.calls[0]!.headers.get('authorization')).toBe('key');
    expect(fake.calls[0]!.headers.get('x-fusionauth-tenantid')).toBe(TENANT);
  });
});
