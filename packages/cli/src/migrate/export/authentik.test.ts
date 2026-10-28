import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDumpDir, Tables } from './frameworks/tables';
import { authentikSubject, authentikUid, base32, djangoPassword, exportAuthentik, exportAuthentikDump } from './authentik';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';

const DUMP = join(__dirname, '__fixtures__/authentik/dump');
const INSTALL = '5b1a3c7e-0f2d-4c8e-9a61-2f4b8d0e7c13';
const NOW = new Date('2026-10-01T00:00:00Z');
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const uid = (pk: string) => authentikUid(pk, INSTALL);

describe('authentikUid / authentikSubject', () => {
  it('is sha256("<pk>-<install id>") in hex, the default sub of authentik tokens', () => {
    expect(authentikUid('2', INSTALL)).toBe(sha256(`2-${INSTALL}`));
  });

  it('follows the provider sub mode', () => {
    const u = { pk: '2', uuid: 'u-2', username: 'ada', email: 'ada@x.test', attributes: { upn: 'ada@corp' }, isActive: true };
    expect(authentikSubject(u, 'user_id')).toBe('2');
    expect(authentikSubject(u, 'user_uuid')).toBe('u-2');
    expect(authentikSubject(u, 'user_username')).toBe('ada');
    expect(authentikSubject(u, 'user_email')).toBe('ada@x.test');
    expect(authentikSubject(u, 'user_upn')).toBe('ada@corp');
    expect(authentikSubject(u, 'hashed_user_id')).toBeUndefined();
    expect(authentikSubject(u, 'hashed_user_id', INSTALL)).toBe(uid('2'));
    expect(authentikSubject({ ...u, attributes: {} }, 'user_upn', INSTALL)).toBe(uid('2'));
  });
});

describe('djangoPassword', () => {
  it('passes PBKDF2 and bcrypt-sha256 through for the Django verifiers', () => {
    const pb = 'pbkdf2_sha256$870000$Hc7oBkW2rN9qXs4Lz1Vt$t183TsfzorLGwX00ZMxs3gumVfVNFo13oyAFDT8Sg7U=';
    expect(djangoPassword(pb)).toEqual({ algorithm: 'pbkdf2_django', hash: pb });
    const bs = 'bcrypt_sha256$$2b$12$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ01234';
    expect(djangoPassword(bs)).toEqual({ algorithm: 'bcrypt_sha256_django', hash: bs });
  });

  it('turns argon2 into the PHC string (a version-less hash is v=16) and bcrypt$ into plain bcrypt', () => {
    expect(djangoPassword('argon2$argon2id$v=19$m=102400,t=2,p=8$Y2hhbmdlbWVTYWx0$4Qb1x0lK6mA8yQq7nV1eTw')).toEqual({
      algorithm: 'argon2',
      hash: '$argon2id$v=19$m=102400,t=2,p=8$Y2hhbmdlbWVTYWx0$4Qb1x0lK6mA8yQq7nV1eTw',
    });
    expect(djangoPassword('argon2$argon2i$m=512,t=2,p=2$c2FsdHNhbHQ$Zm9vYmFyYmF6cXV4')?.hash).toBe('$argon2i$v=16$m=512,t=2,p=2$c2FsdHNhbHQ$Zm9vYmFyYmF6cXV4');
    expect(djangoPassword('bcrypt$$2b$10$zyxwvutsrqponmlkjihgfedcbaZYXWVUTSRQPONMLKJIHGFEDCBA9')).toEqual({
      algorithm: 'bcrypt',
      hash: '$2b$10$zyxwvutsrqponmlkjihgfedcbaZYXWVUTSRQPONMLKJIHGFEDCBA9',
    });
  });

  it('keeps Django scrypt parameters', () => {
    expect(djangoPassword('scrypt$16384$c2FsdA$8$1$aGFzaGhhc2g=')).toEqual({
      algorithm: 'scrypt',
      hash: 'aGFzaGhhc2g=',
      salt: 'c2FsdA',
      params: { n: 16384, r: 8, p: 1, encoding: 'base64', salt_encoding: 'utf8' },
    });
  });

  it('drops unusable and unknown digests', () => {
    expect(djangoPassword('!Wn3pZ8kQ2rT5yU7iO9pA1sD3fG5hJ7kL9zX1cV3')).toBeNull();
    expect(djangoPassword('md5$abcd$0123456789abcdef0123456789abcdef')).toBeNull();
    expect(djangoPassword('')).toBeNull();
    expect(djangoPassword(undefined)).toBeNull();
  });
});

describe('base32', () => {
  it('encodes RFC 4648 test vectors (unpadded)', () => {
    expect(base32(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32(Buffer.from('12345678901234567890'))).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });
});

describe('exportAuthentikDump (database tables)', () => {
  const tables = readDumpDir(DUMP);
  const set = exportAuthentikDump(tables, { now: NOW });
  const user = (pk: string) => set.list('user').find((u) => u.id === uid(pk))!;

  it('keys users by the hashed sub the OAuth2 providers hand out, and skips placeholders and service accounts', () => {
    expect(set.list('user').map((u) => u.id).sort()).toEqual(['1', '2', '3', '4', '7', '8', '9'].map(uid).sort());
    expect(set.omitted.user?.count).toBe(1);
    expect(set.manifest.settings).toMatchObject({ sub_mode: 'hashed_user_id', groups_as: 'roles' });
  });

  it('keeps Django digests with their algorithm and reports the ones it cannot verify', () => {
    expect(user('1').password?.algorithm).toBe('pbkdf2_django');
    expect(user('2').password?.algorithm).toBe('argon2');
    expect(user('3').password?.algorithm).toBe('bcrypt_sha256_django');
    expect(user('4').password).toBeUndefined();
    expect(user('9').password).toBeUndefined();
    expect(set.warnings.some((w) => w.includes('1 user(s) had no usable password'))).toBe(true);
    expect(set.warnings.some((w) => w.includes('Django format Atlas cannot verify'))).toBe(true);
  });

  it('lowercases emails, trusts the email_verified attribute only, and keeps authentik ids in private metadata', () => {
    const ada = user('2');
    expect(ada.emails).toEqual([{ email: 'ada@example.com', verified: true, primary: true }]);
    expect(user('1').emails?.[0]?.verified).toBe(false);
    expect(ada.username).toBe('ada');
    expect(ada.name).toBe('Ada Lovelace');
    expect(ada.private_metadata).toMatchObject({
      authentik_pk: '2',
      authentik_uuid: '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      authentik_uid: uid('2'),
      authentik_path: 'users/engineering',
      authentik_attributes: { upn: 'ada@corp.example', department: 'R&D' },
    });
    expect((ada.private_metadata as { authentik_attributes: Record<string, unknown> }).authentik_attributes.email_verified).toBeUndefined();
    expect(user('8').emails).toBeUndefined();
  });

  it('trusts every email with trustEmails', () => {
    const trusted = exportAuthentikDump(tables, { now: NOW, trustEmails: true });
    expect(trusted.list('user').find((u) => u.id === uid('1'))!.emails?.[0]?.verified).toBe(true);
  });

  it('bans deactivated users and records the external type', () => {
    expect(user('3')).toMatchObject({ banned: true });
    expect(user('4').private_metadata).toMatchObject({ authentik_type: 'external' });
    expect(user('2').banned).toBeUndefined();
  });

  it('maps groups to roles with superuser groups as admin, RBAC roles through users and group ancestry', () => {
    expect(user('1').roles).toEqual(['authentik_admins', 'admin']);
    expect(user('2').roles).toEqual(['platform_team', 'rbac:auditors', 'rbac:deployers']);
    expect(user('3').roles).toEqual(['engineering', 'rbac:deployers']);
    expect(set.list('role').map((r) => r.key).sort()).toEqual(['admin', 'authentik_admins', 'engineering', 'platform_team', 'rbac:auditors', 'rbac:deployers']);
    expect(set.warnings.some((w) => w.includes('hierarchy is flattened'))).toBe(true);
  });

  it('can map groups to organizations with memberships instead', () => {
    const orgs = exportAuthentikDump(tables, { now: NOW, groupsAs: 'organizations' });
    expect(orgs.list('organization').map((o) => o.name).sort()).toEqual(['Engineering', 'Platform Team', 'authentik Admins']);
    expect(orgs.list('membership')).toHaveLength(3);
    expect(orgs.list('membership')[0]!.role).toBe('member');
    expect(orgs.list('role').some((r) => r.key === 'member')).toBe(true);
    expect(exportAuthentikDump(tables, { now: NOW, groupsAs: 'skip' }).count('role')).toBeGreaterThan(0); // RBAC roles still move
  });

  it('exports OAuth source links, SAML links and SAML sources; leaves directory links out', () => {
    const ids = set.list('identity');
    expect(ids.find((i) => i.user_id === uid('2'))).toMatchObject({ provider: 'github', provider_user_id: '583231', kind: 'oauth' });
    expect(ids.find((i) => i.user_id === uid('4'))).toMatchObject({ provider: 'corp-keycloak', kind: 'oidc' });
    expect(ids.find((i) => i.user_id === uid('3'))).toMatchObject({ provider: 'partner-saml', kind: 'saml', sso_connection_id: 'eeeeeeee-0000-4000-8000-000000000003' });
    expect(ids).toHaveLength(3);
    expect(set.omitted.identity?.count).toBe(2); // the LDAP link, and the outpost account's link
    const conn = set.list('sso_connection');
    expect(conn).toHaveLength(1);
    expect(conn[0]).toMatchObject({ protocol: 'saml', name: 'Partner SAML', saml: { idp_sso_url: 'https://idp.partner.example/sso', sp_entity_id: 'https://auth.example.com/source/saml/partner-saml/metadata/' } });
    expect(conn[0]!.saml?.idp_certificate).toContain('MIIBkTCB');
    expect(set.manifest.providers).toEqual(['corp-keycloak', 'github', 'partner-saml']);
  });

  it('never copies upstream OAuth tokens unless asked', () => {
    expect(JSON.stringify([...set.ordered()])).not.toContain('gho_upstreamToken123');
    const withTokens = exportAuthentikDump(tables, { now: NOW, oauthTokens: true });
    expect(withTokens.list('identity').find((i) => i.provider === 'github')?.access_token).toBe('gho_upstreamToken123');
  });

  it('never writes certificate private keys or source secrets', () => {
    const all = JSON.stringify([...set.ordered()]);
    expect(all).not.toContain('NEVER-IN-THE-BUNDLE');
    expect(all).not.toContain('never-copied');
  });

  it('exports API and app-password tokens as sha256 key hashes; drops recovery, managed and expired tokens', () => {
    const keys = set.list('api_key');
    expect(keys.map((k) => k.name).sort()).toEqual(['ada-ci (CI deploys)', 'ada-mail']);
    const ci = keys.find((k) => k.id === 'ffffffff-0000-4000-8000-000000000001')!;
    expect(ci).toMatchObject({ user_id: uid('2'), hash: sha256('Xk3vR8pQ2mN7sT4wY6zA1bC5dE9fG0hJ3kL7mN2pQ5rS8tU1vW4xY7zA0bC3dE6f'), hash_algorithm: 'sha256', start: 'Xk3v' });
    expect(ci.expires_at).toBe('2099-01-01T00:00:00.000Z');
    const mail = keys.find((k) => k.name === 'ada-mail')!;
    expect(mail.scopes).toEqual(['authentik:app_password']);
    expect(mail.expires_at).toBeUndefined(); // non-expiring, whatever the stale expires column says
    expect(set.omitted.api_key?.count).toBe(3);
  });

  it('moves TOTP seeds (hex to base32, 8 digits kept), recovery codes, SMS and email factors', () => {
    const factors = set.list('mfa_factor');
    const totp = factors.filter((f) => f.type === 'totp');
    expect(totp).toHaveLength(2);
    expect(totp.find((f) => f.user_id === uid('2'))).toMatchObject({ secret_base32: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', digits: 6, period: 30, algorithm: 'SHA1', verified: true });
    expect(totp.find((f) => f.user_id === uid('1'))).toMatchObject({ digits: 8 });
    expect(factors.find((f) => f.type === 'backup_codes')).toMatchObject({ user_id: uid('2'), backup_codes: ['k4m2p9x1q8w7', 'z5v3b1n7c9x2'] });
    expect(factors.find((f) => f.type === 'phone')).toMatchObject({ user_id: uid('3'), phone: '+15555550123' });
    expect(factors.find((f) => f.type === 'email')).toMatchObject({ user_id: uid('1') });
    expect(set.omitted.mfa_factor?.count).toBeGreaterThanOrEqual(2); // unconfirmed TOTP, Duo
  });

  it('exports passkeys with the device RP id, and holds back those registered before authentik stored one', () => {
    const keys = set.list('passkey');
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ user_id: uid('2'), credential_id: 'AQIDBAUGBwgJCgsMDQ4PEA', rp_id: 'auth.example.com', sign_count: 4, aaguid: 'cb69481e-8ff7-4039-93ec-0a2729a154a8', name: 'YubiKey 5' });
    expect(set.omitted.passkey?.count).toBe(1);
    expect(set.manifest.rpId).toBe('auth.example.com');
    const withRp = exportAuthentikDump(tables, { now: NOW, rpId: 'auth.example.com' });
    expect(withRp.count('passkey')).toBe(2);
    expect(withRp.list('passkey').find((p) => p.user_id === uid('1'))!.aaguid).toBeUndefined();
  });

  it('keys users by another sub mode and warns when it disagrees with the providers', () => {
    const byName = exportAuthentikDump(tables, { now: NOW, subMode: 'user_username' });
    expect(byName.list('user').map((u) => u.id)).toContain('ada');
    expect(byName.warnings.some((w) => w.includes('sub mode hashed_user_id') && w.includes('user_username'))).toBe(true);
    const byUuid = exportAuthentikDump(tables, { now: NOW, subMode: 'user_uuid' });
    expect(byUuid.list('user').find((u) => u.username === 'ada')!.id).toBe('7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d');
  });

  it('needs the install id for hashed ids', () => {
    const t = new Tables({ authentik_core_user: [{ id: 1, username: 'a', email: 'a@x.test' }] });
    expect(() => exportAuthentikDump(t)).toThrow(/install id/);
    expect(exportAuthentikDump(t, { installId: INSTALL }).list('user')[0]!.id).toBe(uid('1'));
  });

  it('warns about differing provider sub modes and about an empty dump', () => {
    const t = new Tables({
      authentik_core_user: [{ id: 1, username: 'a', email: 'a@x.test' }],
      authentik_providers_oauth2_oauth2provider: [{ sub_mode: 'hashed_user_id' }, { sub_mode: 'user_email' }],
    });
    expect(exportAuthentikDump(t, { installId: INSTALL }).warnings.some((w) => w.includes('different sub modes'))).toBe(true);
    expect(exportAuthentikDump(new Tables({})).warnings[0]).toMatch(/No authentik_core_user rows/);
  });

  it('reads the pre-2025.10 schema (parent column, rbac role with a group)', () => {
    const t = new Tables({
      authentik_core_user: [{ id: 1, username: 'a', email: 'a@x.test' }],
      authentik_core_group: [
        { group_uuid: 'g1', name: 'Parent', is_superuser: false },
        { group_uuid: 'g2', name: 'Child', is_superuser: false, parent_id: 'g1' },
      ],
      authentik_core_user_ak_groups: [{ user_id: 1, group_id: 'g2' }],
      authentik_rbac_role: [{ uuid: 'r1', name: 'Ops', group_id: 'g1' }],
    });
    const out = exportAuthentikDump(t, { installId: INSTALL });
    expect(out.list('user')[0]!.roles).toEqual(['child', 'rbac:ops']);
  });
});

describe('exportAuthentik (API)', () => {
  const BASE = 'https://auth.example.com';
  const api = (p: string) => `GET /api/v3${p}`;
  const page = (results: unknown[], next = 0) => ({ pagination: { next, current: 1 }, results });
  const GID = 'aaaaaaaa-0000-4000-8000-000000000001';
  const routes = {
    [api('/core/groups/')]: page([{ pk: GID, name: 'Admins', is_superuser: true, parents: [], roles: ['r1'] }]),
    [api('/rbac/roles/')]: page([{ pk: 'r1', name: 'Auditors' }]),
    [api('/core/users/')]: page([
      { pk: 10, uuid: 'u-10', uid: 'hash10', username: 'ada', email: 'Ada@X.test', name: 'Ada', is_active: true, type: 'internal', groups: [GID], roles: [], attributes: { email_verified: 'true' } },
      { pk: 11, uuid: 'u-11', uid: 'hash11', username: 'svc', name: 'svc', is_active: true, type: 'service_account', groups: [], roles: [], attributes: {} },
    ]),
    [api('/sources/oauth/')]: page([{ pk: 's1', slug: 'google', provider_type: 'google' }]),
    [api('/sources/saml/')]: page([{ pk: 's2', slug: 'partner', name: 'Partner', sso_url: 'https://idp.x.test/sso', issuer: 'https://auth.example.com/meta', verification_kp: 'kp1', enabled: true }]),
    [api('/crypto/certificatekeypairs/kp1/view_certificate/')]: { data: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----' },
    [api('/sources/user_connections/oauth/')]: page([{ user: 10, identifier: 'g-1', source_obj: { slug: 'google' } }]),
    [api('/sources/user_connections/saml/')]: page([{ user: 10, identifier: 'ada@partner', source_obj: { slug: 'partner', pk: 's2' } }]),
    [api('/core/tokens/')]: page([
      { identifier: 'ci', intent: 'api', user: 10, expiring: false, description: 'deploys' },
      { identifier: 'hidden', intent: 'api', user: 10, expiring: false },
      { identifier: 'rec', intent: 'recovery', user: 10 },
    ]),
    [api('/core/tokens/ci/view_key/')]: { key: 'abc123xyz' },
    [api('/core/tokens/hidden/view_key/')]: { status: 403, body: { detail: 'no' } },
    [api('/authenticators/admin/totp/')]: page([{ pk: 1 }, { pk: 2 }]),
    [api('/authenticators/admin/static/')]: page([]),
    [api('/authenticators/admin/webauthn/')]: page([{ pk: 1 }]),
  };

  it('exports users, groups, sources, links and token keys, and says what the API withholds', async () => {
    const v = fakeVendor(BASE, routes);
    const set = await exportAuthentik({ baseUrl: BASE, token: 'tok-1', fetchImpl: v.fetchImpl, sleep: noSleep, now: NOW });
    expect(v.calls.every((c) => c.headers.get('authorization') === 'Bearer tok-1')).toBe(true);
    expect(v.calls.every((c) => !c.url.includes('tok-1'))).toBe(true);
    const users = set.list('user');
    expect(users.map((u) => u.id)).toEqual(['hash10']);
    expect(users[0]).toMatchObject({ roles: ['admins', 'admin', 'rbac:auditors'], emails: [{ email: 'ada@x.test', verified: true, primary: true }] });
    expect(users[0]!.password).toBeUndefined();
    expect(set.omitted.user?.count).toBe(1);
    expect(set.list('identity').map((i) => [i.provider, i.kind]).sort()).toEqual([['google', 'oauth'], ['partner', 'saml']]);
    expect(set.list('identity').find((i) => i.provider === 'partner')?.sso_connection_id).toBe('s2');
    expect(set.list('sso_connection')[0]).toMatchObject({ id: 's2', saml: { idp_certificate: expect.stringContaining('MIIB'), sp_acs_url: 'https://auth.example.com/source/saml/partner/acs/' } });
    expect(set.list('api_key')).toEqual([expect.objectContaining({ id: 'ci', user_id: 'hash10', hash: sha256('abc123xyz') })]);
    expect(set.omitted.api_key?.count).toBe(2);
    expect(set.omitted.mfa_factor?.count).toBe(2);
    expect(set.omitted.passkey?.count).toBe(1);
    expect(set.warnings.some((w) => w.includes('never returns password hashes'))).toBe(true);
  });

  it('follows pagination', async () => {
    const all = Array.from({ length: 3 }, (_, i) => ({ pk: i + 1, uid: `h${i + 1}`, username: `u${i + 1}`, email: `u${i + 1}@x.test`, is_active: true, attributes: {} }));
    const v = fakeVendor(BASE, {
      [api('/core/groups/')]: page([]),
      [api('/core/users/')]: ({ url }: { url: URL }) => (url.searchParams.get('page') === '1' ? page(all.slice(0, 2), 2) : page(all.slice(2))),
    });
    const set = await exportAuthentik({ baseUrl: BASE, token: 't', fetchImpl: v.fetchImpl, sleep: noSleep });
    expect(set.count('user')).toBe(3);
  });

  it('skips what the token cannot read, with a warning', async () => {
    const v = fakeVendor(BASE, { [api('/core/groups/')]: page([]), [api('/core/users/')]: page([{ pk: 1, uid: 'h1', username: 'a', is_active: true, attributes: {} }]) });
    const set = await exportAuthentik({ baseUrl: BASE, token: 't', fetchImpl: v.fetchImpl, sleep: noSleep });
    expect(set.count('user')).toBe(1);
    expect(set.warnings.some((w) => w.includes('RBAC roles could not be read'))).toBe(true);
  });

  it('stops when the token is rejected, and asks for input when neither dump nor API is given', async () => {
    const v = fakeVendor(BASE, { [api('/core/groups/')]: { status: 401, body: { detail: 'Token invalid' } } });
    await expect(exportAuthentik({ baseUrl: BASE, token: 'bad', fetchImpl: v.fetchImpl, sleep: noSleep })).rejects.toThrow(/401/);
    await expect(exportAuthentik({})).rejects.toThrow(/AUTHENTIK_DUMP/);
    await expect(exportAuthentik({ baseUrl: 'nope', token: 't' })).rejects.toThrow(/Not an authentik URL/);
  });
});
