import { describe, expect, it } from 'vitest';
import { guidFromBase64, generalizedTime, mapLdif, normalizeDn, parseLdif } from './ldap';
import { detectPasswordHash } from './password-detect';

const SSHA = '{SSHA}s1DY0JgEJq42+WEuY7lhba4o0uxgrXZt'; // slappasswd -h {SSHA}, "correct horse"
const SHA6 = '$6$mYsalt$pGY0L4bUTQmQW6OEACClOBRzLGWB6M5YX7pcIgjdmsHfS6rS2TCLxyhOSBLeGVSNZiHzXfbxbL0pZWZODPD7X.';
const b64 = (s: string) => Buffer.from(s).toString('base64');

const OPENLDAP = `# slapcat -n 1
dn: dc=example,dc=com
objectClass: dcObject
dc: example

dn: uid=ada,ou=people,dc=example,dc=com
objectClass: inetOrgPerson
objectClass: posixAccount
uid: ada
cn: Ada Lovelace
givenName: Ada
sn: Lovelace
mail: Ada@Example.com
mail: ada@work.example
mobile: +44 20 7946 0958
userPassword: ${SSHA}
entryUUID: 11111111-2222-3333-4444-555555555555
createTimestamp: 20240102030405Z
title: Analyst
description:: ${b64('folded')}

dn: uid=bob,ou=people,dc=example,dc=com
objectClass: inetOrgPerson
uid: bob
cn: Bob
sn: B
mail: bob@example.com
userPassword:: ${b64(`{CRYPT}${SHA6}`)}
entryUUID: 22222222-2222-3333-4444-555555555555
pwdAccountLockedTime: 000001010000Z

dn: uid=cy,ou=people,dc=example,dc=com
objectClass: inetOrgPerson
uid: cy
cn: Cy
sn: C
mail: cy@example.com
userPassword: {CRYPT}9kU7EFRwqrEX2
entryUUID: 33333333-2222-3333-4444-555555555555

dn: cn=staff,ou=groups,dc=example,dc=com
objectClass: groupOfNames
cn: staff
member: UID=Ada, OU=people, DC=example, DC=com
member: uid=bob,ou=people,dc=example,dc=com

dn: cn=ops,ou=groups,dc=example,dc=com
objectClass: posixGroup
cn: ops
memberUid: cy
`;

describe('parseLdif', () => {
  it('unfolds lines, decodes base64 values and skips comments', () => {
    const { entries, problems } = parseLdif('# c\ndn: uid=a,dc=x\ncn: A very long\n  value\ndescription:: aGk=\n\nnot a line\n');
    expect(problems.length).toBe(1);
    expect(entries[0]!.attrs.get('cn')).toEqual(['A very long value']);
    expect(entries[0]!.attrs.get('description')).toEqual(['hi']);
  });
  it('keeps binary values as base64', () => {
    const bin = Buffer.from([0xff, 0xfe, 0x00, 0x01]).toString('base64');
    const { entries } = parseLdif(`dn: cn=x\nobjectGUID:: ${bin}\n`);
    expect(entries[0]!.attrs.get('objectguid')).toEqual([bin]);
  });
});

describe('mapLdif (OpenLDAP)', () => {
  const set = mapLdif(parseLdif(OPENLDAP).entries);
  const users = set.list('user');

  it('maps people, not the suffix entry', () => {
    expect(users.map((u) => u.username)).toEqual(['ada', 'bob', 'cy']);
    expect(users[0]).toMatchObject({
      id: '11111111-2222-3333-4444-555555555555',
      emails: [{ email: 'ada@example.com', verified: false, primary: true }, { email: 'ada@work.example', primary: false }],
      phones: [{ phone: '+442079460958' }],
      first_name: 'Ada',
      last_name: 'Lovelace',
      created_at: '2024-01-02T03:04:05.000Z',
      password: { algorithm: 'ldap_ssha', hash: SSHA },
    });
  });

  it('keeps verifiable hashes, locks, and reports the rest for lazy migration', () => {
    expect(users[1]).toMatchObject({ banned: true, password: { algorithm: 'ldap_crypt' } });
    expect(users[2]!.password).toBeUndefined();
    expect(set.warnings.join(' ')).toMatch(/1 password\(s\) left out: traditional DES/);
  });

  it('turns groups into roles by DN (case and spacing insensitive) and memberUid', () => {
    expect(set.list('role').map((r) => r.key).sort()).toEqual(['ops', 'staff']);
    expect(users[0]!.roles).toEqual(['staff']);
    expect(users[2]!.roles).toEqual(['ops']);
  });

  it('can make organizations with members instead', () => {
    const orgs = mapLdif(parseLdif(OPENLDAP).entries, { groups: 'organizations' });
    expect(orgs.list('organization').map((o) => o.name).sort()).toEqual(['ops', 'staff']);
    expect(orgs.list('membership')).toHaveLength(3);
    expect(orgs.list('role')).toHaveLength(0);
  });
});

describe('mapLdif (Active Directory)', () => {
  const guid = Buffer.from('33221100554477668899aabbccddeeff', 'hex').toString('base64');
  const ldif = `dn: CN=Grace Hopper,OU=Users,DC=corp,DC=example
objectClass: top
objectClass: person
objectClass: organizationalPerson
objectClass: user
sAMAccountName: ghopper
userPrincipalName: ghopper@corp.example
mail: grace@corp.example
givenName: Grace
sn: Hopper
objectGUID:: ${guid}
userAccountControl: 514
whenCreated: 20230101000000.0Z
lastLogonTimestamp: 133500000000000000
memberOf: CN=Admins,OU=Groups,DC=corp,DC=example
`;
  const set = mapLdif(parseLdif(ldif).entries);
  it('uses objectGUID, honours ACCOUNTDISABLE and memberOf, and says AD has no hashes', () => {
    expect(set.list('user')[0]).toMatchObject({ id: '00112233-4455-6677-8899-aabbccddeeff', username: 'ghopper', banned: true, roles: ['admins'] });
    expect(set.list('user')[0]!.last_sign_in_at).toMatch(/^20\d\d-/);
    expect(set.warnings.join(' ')).toMatch(/Active Directory never exports password hashes/);
  });
});

describe('helpers', () => {
  it('normalises DNs, GUIDs and times', () => {
    expect(normalizeDn('UID=Ada , OU=People,DC=X')).toBe('uid=ada,ou=people,dc=x');
    expect(guidFromBase64(Buffer.alloc(3).toString('base64'))).toBeUndefined();
    expect(generalizedTime('20240102030405+0100')).toBe('2024-01-02T02:04:05.000Z');
    expect(generalizedTime('garbage')).toBeUndefined();
  });
});

describe('detectPasswordHash', () => {
  it('recognises directory and crypt schemes', () => {
    expect(detectPasswordHash(SSHA)).toMatchObject({ ok: true, password: { algorithm: 'ldap_ssha' }, weak: true });
    expect(detectPasswordHash(SHA6)).toMatchObject({ ok: true, password: { algorithm: 'sha_crypt' } });
    expect(detectPasswordHash('{PBKDF2-SHA256}29000$AAECAwQFBgcICQoLDA0ODw$ZvLORN3Wu1.2s6Mb0kBKZ43bylSsC/t0Vz5rE9nJPNg')).toMatchObject({ ok: true, password: { algorithm: 'ldap_pbkdf2' } });
    expect(detectPasswordHash('{BCRYPT}$2y$04$fAc/tTQgRYNSKtjWhiHTo.rgTRLaKMcMlR/H5LdsPNKPDK4tzpiuK')).toMatchObject({ ok: true, password: { algorithm: 'ldap_crypt' } });
  });
  it('explains what it cannot use, and never keeps a clear password', () => {
    expect(detectPasswordHash('{SASL}ada@EXAMPLE')).toMatchObject({ ok: false, reason: expect.stringContaining('another service') });
    expect(detectPasswordHash('{CRYPT}9kU7EFRwqrEX2')).toMatchObject({ ok: false });
    expect(detectPasswordHash('plainpw')).toMatchObject({ ok: false });
    const clear = detectPasswordHash('{CLEARTEXT}hunter2');
    expect(clear).toMatchObject({ ok: true, password: { algorithm: 'pbkdf2' } });
    expect(JSON.stringify(clear)).not.toContain('hunter2');
  });
});
