import { describe, expect, it } from 'vitest';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';
import { exportZitadelApi, fetchZitadel, mapZitadel, readZitadelExport, zitadelPassword } from './zitadel';

/**
 * ZITADEL's export document (`ImportData`: what `zitadel export` and
 * `POST /admin/v1/export` write, camelCase) and the user API.
 */

const BCRYPT = '$2a$12$o6hx.Wog/wvFSkT/Bp/6DOxCtLRTDj7lm9on9suF/WaCGNVHbkfL6';
const ARGON = '$argon2id$v=19$m=32,t=2,p=4$cm94YnRVOW5jZzFzcVE4bQ$MNzk5BtR2vUhrp6qQEjRNw';
const SCRYPT = '$scrypt$ln=15,r=8,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNo';
const PBKDF2 = '$pbkdf2-sha256$i=29000,l=32$c2FsdA$aGFzaA';
const b64 = (s: string) => Buffer.from(s).toString('base64');

const ACME = {
  orgId: '1001',
  org: { name: 'Acme' },
  domains: [
    { domainName: 'acme.com', isVerified: true, isPrimary: true },
    { domainName: 'acme.io', isVerified: false },
  ],
  projectRoles: [
    { projectId: 'p1', roleKey: 'admin', displayName: 'Administrator', group: 'staff' },
    { projectId: 'p1', roleKey: 'viewer', displayName: 'Viewer' },
  ],
  userGrants: [{ userId: 'u1', projectId: 'p1', roleKeys: ['admin', 'viewer'] }],
  orgMembers: [
    { userId: 'u1', roles: ['ORG_OWNER'] },
    { userId: 'u2', roles: ['ORG_USER_MANAGER'] },
  ],
  userMetadata: [
    {
      userId: 'u1',
      metadata: [
        { key: 'plan', value: b64('pro') },
        { key: 'prefs', value: b64('{"theme":"dark"}') },
      ],
    },
  ],
  oidcIdps: [{ idpId: 'idp-oidc', idp: { name: 'Acme SSO', issuer: 'https://sso.acme.com', clientId: 'abc', scopes: ['openid', 'email'] } }],
  googleIdps: [{ idpId: 'idp-google', idp: { name: 'Google', clientId: '123.apps.googleusercontent.com' } }],
  samlIdps: [{ idpId: 'idp-saml', idp: { name: 'Partner', metadataXml: b64('<EntityDescriptor entityID="https://idp.partner.example"/>') } }],
  machineUsers: [{ userId: 'm1', user: { userName: 'svc' } }],
  humanUsers: [
    {
      userId: 'u1',
      user: {
        userName: 'jane@acme.com',
        profile: { firstName: 'Jane', lastName: 'Doe', displayName: 'Jane Doe' },
        email: { email: 'Jane@Acme.com', isEmailVerified: true },
        phone: { phone: '+1 415 555 0101', isPhoneVerified: true },
        hashedPassword: { value: BCRYPT, algorithm: 'bcrypt' },
        otpCode: 'JBSWY3DPEHPK3PXP',
        idps: [
          { configId: 'idp-google', externalUserId: '1093', displayName: 'Jane' },
          { configId: 'idp-saml', externalUserId: 'jane@partner.com' },
          { configId: 'idp-missing', externalUserId: 'x' },
        ],
      },
    },
    { userId: 'u2', user: { userName: 'sam', profile: { firstName: 'Sam', lastName: 'Ray' }, email: { email: 'sam@acme.com' }, hashedPassword: { value: 'abc', algorithm: 'sha1' } } },
    { userId: 'u3', user: { profile: { firstName: 'Nobody' } } },
  ],
};
const GLOBEX = {
  orgId: '1002',
  org: { name: 'Globex' },
  humanUsers: [
    { userId: 'u4', user: { userName: 'kim', email: { email: 'kim@globex.com', isEmailVerified: true }, hashedPassword: { value: SCRYPT, algorithm: 'scrypt' } } },
    { userId: 'u5', user: { userName: 'lee', email: { email: 'lee@globex.com' }, hashed_password: { value: PBKDF2, algorithm: 'pbkdf2' } } },
    { userId: 'u6', user: { userName: 'max', email: { email: 'max@globex.com' }, hashedPassword: { value: '5F4DCC3B5AA765D61D8327DEB882CF99', algorithm: 'md5' } } },
  ],
};
const DOC = { orgs: [ACME, GLOBEX] };

describe('zitadelPassword', () => {
  it('recognises the encodings ZITADEL verifies', () => {
    expect(zitadelPassword({ value: BCRYPT, algorithm: 'bcrypt' })).toEqual({ algorithm: 'bcrypt', hash: BCRYPT });
    expect(zitadelPassword({ value: ARGON, algorithm: 'argon2id' })).toEqual({ algorithm: 'argon2', hash: ARGON });
    for (const h of [SCRYPT, PBKDF2, '$1$abcdefgh$1234567890123456789012', `$6$rounds=5000$salt$${'a'.repeat(86)}`, '$P$B7c6bbl3jFRUgKvLiXSOVsmf7xu3Q4.']) {
      expect(zitadelPassword({ value: h, algorithm: 'x' })).toEqual({ algorithm: 'auto', hash: h });
    }
  });

  it('maps a bare hex MD5 only when the algorithm says md5', () => {
    expect(zitadelPassword({ value: '5F4DCC3B5AA765D61D8327DEB882CF99', algorithm: 'MD5' })).toEqual({ algorithm: 'md5', hash: '5f4dcc3b5aa765d61d8327deb882cf99', params: { encoding: 'hex' } });
    expect(zitadelPassword({ value: '5f4dcc3b5aa765d61d8327deb882cf99', algorithm: 'sha1' })).toBeNull();
  });

  it('refuses what it cannot verify', () => {
    expect(zitadelPassword({ value: 'abc', algorithm: 'sha1' })).toBeNull();
    expect(zitadelPassword({ value: '', algorithm: 'bcrypt' })).toBeNull();
    expect(zitadelPassword(undefined)).toBeNull();
  });
});

describe('mapZitadel (an export document)', () => {
  const set = mapZitadel(readZitadelExport(DOC));
  const user = (id: string) => set.list('user').find((u) => u.id === id)!;

  it('exports the ZITADEL user id with profile, verified email and phone, and the password hash', () => {
    expect(user('u1')).toEqual({
      id: 'u1',
      emails: [{ email: 'jane@acme.com', verified: true, primary: true }],
      phones: [{ phone: '+14155550101', verified: true, primary: true }],
      first_name: 'Jane',
      last_name: 'Doe',
      name: 'Jane Doe',
      password: { algorithm: 'bcrypt', hash: BCRYPT },
      roles: ['admin', 'viewer'],
      private_metadata: { zitadel_metadata: { plan: 'pro', prefs: { theme: 'dark' } } },
    });
    expect(user('u2')).toMatchObject({ username: 'sam', emails: [{ email: 'sam@acme.com', verified: false, primary: true }] });
    expect(user('u2').password).toBeUndefined();
  });

  it('keeps the username only when it differs from the email, and reads snake_case files', () => {
    expect(user('u1').username).toBeUndefined();
    expect(user('u5').password).toEqual({ algorithm: 'auto', hash: PBKDF2 });
    expect(user('u4').password).toEqual({ algorithm: 'auto', hash: SCRYPT });
    expect(user('u6').password).toEqual({ algorithm: 'md5', hash: '5f4dcc3b5aa765d61d8327deb882cf99', params: { encoding: 'hex' } });
  });

  it('drops users with no way to sign in and machine users, and says why', () => {
    expect(set.list('user').map((u) => u.id)).toEqual(['u1', 'u2', 'u4', 'u5', 'u6']);
    expect(set.omitted.user).toEqual({ count: 1, reason: 'User with no email address, phone number or username' });
    expect(set.omitted.machine_user?.count).toBe(1);
  });

  it("exports the TOTP secret with ZITADEL's fixed parameters", () => {
    expect(set.list('mfa_factor')).toEqual([{ user_id: 'u1', type: 'totp', secret_base32: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30, algorithm: 'SHA1', verified: true }]);
    expect(set.manifest.settings).toEqual({ totp: { digits: 6, period: 30, algorithm: 'SHA1' } });
  });

  it('links social accounts by provider key and enterprise ones to their SSO connection', () => {
    expect(set.list('identity')).toEqual([
      { user_id: 'u1', provider: 'google', provider_user_id: '1093', kind: 'oauth', email: 'jane@acme.com' },
      { user_id: 'u1', provider: 'Partner', provider_user_id: 'jane@partner.com', kind: 'saml', sso_connection_id: 'idp-saml', email: 'jane@acme.com' },
    ]);
    expect(set.manifest.providers).toEqual(['Partner', 'google']);
    expect(set.warnings.join('\n')).toMatch(/1 social link\(s\) point at an identity provider the export does not describe/);
  });

  it('exports OIDC and SAML identity providers as SSO connections of their organization', () => {
    expect(set.list('sso_connection')).toEqual([
      {
        id: 'idp-oidc',
        name: 'Acme SSO',
        organization_id: '1001',
        protocol: 'oidc',
        oidc: { issuer: 'https://sso.acme.com', discovery_url: 'https://sso.acme.com/.well-known/openid-configuration', client_id: 'abc', scopes: ['openid', 'email'] },
        enabled: true,
      },
      { id: 'idp-saml', name: 'Partner', organization_id: '1001', protocol: 'saml', saml: { idp_metadata_xml: '<EntityDescriptor entityID="https://idp.partner.example"/>' }, enabled: true },
    ]);
  });

  it('exports organizations with their verified domains, project roles as app roles, and memberships', () => {
    expect(set.list('organization')).toEqual([{ id: '1001', name: 'Acme', domains: ['acme.com'] }, { id: '1002', name: 'Globex' }]);
    expect(set.list('role')).toEqual([
      { key: 'admin', name: 'Administrator', description: 'staff', scope: 'app' },
      { key: 'viewer', name: 'Viewer', scope: 'app' },
    ]);
    expect(set.list('membership').map((m) => [m.organization_id, m.user_id, m.role])).toEqual([
      ['1001', 'u1', 'admin'],
      ['1001', 'u2', 'member'],
      ['1002', 'u4', 'member'],
      ['1002', 'u5', 'member'],
      ['1002', 'u6', 'member'],
    ]);
    expect(set.warnings.join('\n')).toMatch(/1 organization member\(s\) hold ZITADEL roles other than ORG_OWNER/);
  });

  it('warns about hashes it cannot verify and about passkeys that cannot move', () => {
    const warnings = set.warnings.join('\n');
    expect(warnings).toMatch(/1 password hash\(es\) are in a format Atlas cannot verify/);
    expect(warnings).toMatch(/passkeys and security keys only in its event store/);
  });

  it('skips organizations on request, and a single organization stays implicit in auto mode', () => {
    expect(mapZitadel(readZitadelExport(DOC), { orgs: 'skip' }).list('organization')).toEqual([]);
    const one = mapZitadel(readZitadelExport({ orgs: [ACME] }));
    expect(one.list('organization')).toEqual([]);
    expect(one.list('membership')).toEqual([]);
    expect(mapZitadel(readZitadelExport({ orgs: [ACME] }), { orgs: 'all' }).list('organization')).toHaveLength(1);
  });

  it('reads a bare array and a single org, and refuses anything else', () => {
    expect(readZitadelExport([ACME]).orgs).toHaveLength(1);
    expect(readZitadelExport(GLOBEX).orgs).toHaveLength(1);
    expect(() => readZitadelExport({ nothing: true })).toThrow(/No organizations found/);
  });

  it('warns when the export carries no hashes or secrets', () => {
    const bare = mapZitadel(readZitadelExport({ orgs: [{ orgId: '1', humanUsers: [{ userId: 'a', user: { userName: 'a', email: { email: 'a@x.io' } } }] }] }));
    expect(bare.warnings.join('\n')).toMatch(/no password hashes/);
    expect(bare.warnings.join('\n')).toMatch(/no TOTP secrets/);
  });
});

const ORIGIN = 'https://acme-abc123.zitadel.cloud';

describe('fetchZitadel (Admin API)', () => {
  it('asks for passwords and TOTP secrets, authenticates with the token, and resolves links through IdP templates', async () => {
    const doc = { orgs: [{ orgId: '1', org: { name: 'Acme' }, humanUsers: [{ userId: 'a', user: { userName: 'a@x.io', email: { email: 'a@x.io', isEmailVerified: true }, idps: [{ configId: 'idp-gh', externalUserId: '42' }] } }] }] };
    const v = fakeVendor(ORIGIN, {
      'POST /admin/v1/export': doc,
      'POST /admin/v1/idps/templates/_search': { result: [{ details: {}, id: 'idp-gh', name: 'GitHub', type: 'IDP_TYPE_GITHUB', github: { clientId: 'gh-client' } }] },
    });
    const set = await exportZitadelApi({ instance: 'acme-abc123.zitadel.cloud', token: 'pat', fetchImpl: v.fetchImpl, sleep: noSleep });
    expect(v.calls[0]!.body).toEqual({ withPasswords: true, withOtp: true, responseOutput: true });
    expect(v.calls.every((c) => c.headers.get('authorization') === 'Bearer pat')).toBe(true);
    expect(set.list('identity')).toEqual([{ user_id: 'a', provider: 'github', provider_user_id: '42', kind: 'oauth', email: 'a@x.io' }]);
    expect(set.manifest.origin).toBe('ZITADEL acme-abc123.zitadel.cloud');
  });

  it('falls back to listing users when the export is refused, without hashes or links', async () => {
    const user = (id: string, org: string, email: string) => ({
      userId: id,
      state: 'USER_STATE_ACTIVE',
      username: email,
      details: { resourceOwner: org },
      human: { profile: { givenName: 'G', familyName: id, displayName: `G ${id}` }, email: { email, isVerified: true }, phone: { phone: '+14155550102', isVerified: false } },
    });
    const offsetOf = (body: unknown) => Number((body as { query: { offset: string } }).query.offset);
    const v = fakeVendor(ORIGIN, {
      'POST /admin/v1/export': { status: 403, body: { code: 7, message: 'No matching permissions found' } },
      'POST /admin/v1/orgs/_search': ({ body }: { body: unknown }) => ({ result: offsetOf(body) === 0 ? [{ id: '1', name: 'Acme' }, { id: '2', name: 'Globex' }] : [] }),
      'POST /v2/users': ({ body }: { body: unknown }) => ({ result: offsetOf(body) === 0 ? [user('a', '1', 'a@x.io'), user('b', '2', 'b@x.io')] : [user('c', '1', 'c@x.io')] }),
      'POST /admin/v1/idps/templates/_search': { status: 403, body: {} },
    });
    const snap = await fetchZitadel({ instance: ORIGIN, token: 'pat', pageSize: 2, fetchImpl: v.fetchImpl, sleep: noSleep });
    expect(snap.source).toBe('users');
    const set = mapZitadel(snap);
    expect(set.list('user').map((u) => [u.id, u.first_name, u.name])).toEqual([
      ['a', 'G', 'G a'],
      ['c', 'G', 'G c'],
      ['b', 'G', 'G b'],
    ]);
    expect(set.list('user').every((u) => u.password === undefined)).toBe(true);
    expect(set.list('organization').map((o) => o.name)).toEqual(['Acme', 'Globex']);
    expect(set.list('membership').map((m) => `${m.organization_id}:${m.user_id}`)).toEqual(['1:a', '1:c', '2:b']);
    expect(set.warnings.join('\n')).toMatch(/v2 user API: it never returns password hashes/);
  });

  it('does not fall back on a bad token', async () => {
    const v = fakeVendor(ORIGIN, { 'POST /admin/v1/export': { status: 401, body: { message: 'invalid token' } } });
    await expect(fetchZitadel({ instance: ORIGIN, token: 'bad', fetchImpl: v.fetchImpl, sleep: noSleep })).rejects.toThrow(/ZITADEL API 401/);
    expect(v.calls).toHaveLength(1);
  });
});
