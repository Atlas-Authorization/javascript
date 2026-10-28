import { createCipheriv, createVerify, generateKeyPairSync, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { exportFirebase, hashParamsOf, mapFirebaseUser, parseFirebaseExport, serviceAccountAssertion } from './firebase';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';

/**
 * Identity Toolkit responses as Google returns them (UserInfo with web-safe
 * base64 hashes, `customAttributes` as a JSON string, `nextPageToken` paging)
 * and auth:export files as the Firebase CLI writes them.
 */
const ORIGIN = 'https://identitytoolkit.googleapis.com';
const PROJECT = 'demo-proj';

/** The firebase/scrypt README vector (also used by Supabase's own tests). */
const VECTOR = {
  password: 'user1password',
  salt: '42xEC+ixf3L2lw==',
  saltSeparator: 'Bw==',
  rounds: 8,
  memCost: 14,
  signerKey: 'jxspr8Ki0RYycVU8zykbdLGjFQ3McFUH0uiiTvC8pVMXAn210wjLNmdZJzxUECKbm0QsEmYUSDzZvpjeJ9WmXA==',
  hash: 'lSrfV15cpx95/sZS2W9c9Kp6i/LVgQNDNC/qzrCnh1SAyZvqmZqAjTdn3aoItz+VHjoZilo78198JAdRuid5lQ==',
};
const webSafe = (b64: string) => b64.replace(/\+/g, '-').replace(/\//g, '_');

const HASH_CONFIG = { algorithm: 'SCRYPT', signerKey: VECTOR.signerKey, saltSeparator: VECTOR.saltSeparator, rounds: VECTOR.rounds, memoryCost: VECTOR.memCost };

const JANE = {
  localId: 'kYi4EvWQlQTKSfnJ3dRSP6IH3ed2',
  email: 'Jane@Example.com',
  emailVerified: true,
  displayName: 'Jane Doe',
  photoUrl: 'https://img.example/jane.png',
  passwordHash: webSafe(VECTOR.hash),
  salt: webSafe(VECTOR.salt),
  version: 0,
  passwordUpdatedAt: 1508893925000,
  validSince: '1508893925',
  createdAt: '1508893925000',
  lastLoginAt: '1700000000000',
  phoneNumber: '+14155550101',
  customAttributes: '{"admin":true,"plan":"pro"}',
  providerUserInfo: [
    { providerId: 'password', email: 'jane@example.com', rawId: 'jane@example.com' },
    { providerId: 'google.com', rawId: '1093849', email: 'jane@gmail.com', displayName: 'Jane D', federatedId: '1093849' },
    { providerId: 'saml.acme', rawId: 'jane@acme.example', email: 'jane@acme.example' },
    { providerId: 'oidc.corp', rawId: 'corp-sub-1' },
    { providerId: 'phone', rawId: '+14155550101', phoneNumber: '+14155550101' },
  ],
  mfaInfo: [
    { mfaEnrollmentId: 'mfa1', displayName: 'Work phone', phoneInfo: '+14155550199', enrolledAt: '2023-01-02T03:04:05Z' },
    { mfaEnrollmentId: 'mfa2', displayName: 'Authenticator', totpInfo: {}, enrolledAt: '2023-02-02T03:04:05Z' },
  ],
};
const SAM = { localId: 'samUid2', email: 'sam@example.com', emailVerified: false, disabled: true, passwordHash: 'UkVEQUNURUQ=', salt: 'c2FsdA==', createdAt: '1600000000000' };
const ANON = { localId: 'anonUid3', createdAt: '1600000000000' };
const IMPORTED = { localId: 'bcryptUid4', email: 'old@example.com', passwordHash: 'JDJhJDEwJA==', salt: '', version: 1 };

function account() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = {
    type: 'service_account',
    project_id: PROJECT,
    private_key_id: 'key-1',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    client_email: `migrator@${PROJECT}.iam.gserviceaccount.com`,
    token_uri: 'https://oauth2.googleapis.com/token',
  };
  return { json: JSON.stringify(sa), publicKey };
}

function google(over: Record<string, unknown> = {}) {
  return fakeVendor(ORIGIN, {
    'POST https://oauth2.googleapis.com/token': ({ body }: { body: unknown }) => {
      const form = new URLSearchParams(String(body));
      return form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer' && form.get('assertion') ? { access_token: 'ya29.test', expires_in: 3599, token_type: 'Bearer' } : { status: 400, body: { error: 'invalid_grant' } };
    },
    [`GET /v2/projects/${PROJECT}/config`]: { signIn: { email: { enabled: true }, hashConfig: HASH_CONFIG } },
    [`GET /v2/projects/${PROJECT}/inboundSamlConfigs?pageSize=100`]: {
      inboundSamlConfigs: [
        {
          name: `projects/${PROJECT}/inboundSamlConfigs/saml.acme`,
          displayName: 'Acme SAML',
          enabled: true,
          idpConfig: { idpEntityId: 'https://idp.acme.example', ssoUrl: 'https://idp.acme.example/sso', idpCertificates: [{ x509Certificate: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----' }] },
          spConfig: { spEntityId: 'demo-sp', callbackUri: `https://${PROJECT}.firebaseapp.com/__/auth/handler` },
        },
      ],
    },
    [`GET /v1/projects/${PROJECT}/accounts:batchGet?maxResults=1000`]: { users: [JANE, SAM], nextPageToken: 'page2' },
    [`GET /v1/projects/${PROJECT}/accounts:batchGet?maxResults=1000&nextPageToken=page2`]: { users: [ANON, IMPORTED] },
    ...over,
  });
}

describe('exportFirebase (Admin REST)', () => {
  it('exports users, identities, SMS factors and Firebase scrypt hashes with the project parameters', async () => {
    const sa = account();
    const g = google();
    const set = await exportFirebase({ projectId: PROJECT, serviceAccountJson: sa.json, fetchImpl: g.fetchImpl, sleep: noSleep });

    expect(set.list('user').map((u) => u.id)).toEqual([JANE.localId, SAM.localId, IMPORTED.localId]);
    const jane = set.list('user')[0]!;
    expect(jane).toMatchObject({
      emails: [{ email: 'jane@example.com', verified: true, primary: true }],
      phones: [{ phone: '+14155550101', verified: true, primary: true }],
      name: 'Jane Doe',
      public_metadata: { admin: true, plan: 'pro' },
      created_at: 1508893925000,
      last_sign_in_at: 1700000000000,
      // Web-safe base64 from the API, standard base64 in the bundle.
      password: { algorithm: 'scrypt_firebase', hash: VECTOR.hash, salt: VECTOR.salt, params: { signer_key: VECTOR.signerKey, salt_separator: 'Bw==', rounds: 8, mem_cost: 14 } },
    });
    expect(set.list('user')[1]).toMatchObject({ banned: true });
    expect(set.list('user')[1]!.password).toBeUndefined();
    expect(set.list('user')[2]!.password).toBeUndefined();

    expect(set.list('identity')).toEqual([
      expect.objectContaining({ user_id: JANE.localId, provider: 'google', provider_user_id: '1093849', kind: 'oauth', email: 'jane@gmail.com' }),
      expect.objectContaining({ provider: 'saml.acme', kind: 'saml', sso_connection_id: 'saml.acme', provider_user_id: 'jane@acme.example' }),
      expect.objectContaining({ provider: 'oidc.corp', kind: 'oidc', provider_user_id: 'corp-sub-1' }),
    ]);
    expect(set.list('sso_connection')).toEqual([
      expect.objectContaining({ id: 'saml.acme', protocol: 'saml', saml: expect.objectContaining({ idp_entity_id: 'https://idp.acme.example', sp_acs_url: `https://${PROJECT}.firebaseapp.com/__/auth/handler` }) }),
    ]);
    expect(set.list('mfa_factor')).toEqual([expect.objectContaining({ id: 'mfa1', type: 'phone', phone: '+14155550199', verified: true })]);
    expect(set.omitted.mfa_factor?.count).toBe(1);
    expect(set.omitted.user).toEqual({ count: 1, reason: expect.stringContaining('anonymous') });
    expect(set.warnings.join('\n')).toMatch(/REDACTED/);
    expect(set.warnings.join('\n')).toMatch(/not Firebase scrypt/);
    // The signer key never lands in the manifest.
    expect(JSON.stringify(set.manifest)).not.toContain(VECTOR.signerKey);
    expect(set.manifest.settings).toEqual({ password_hash: { algorithm: 'scrypt_firebase', rounds: 8, mem_cost: 14, salt_separator: 'Bw==' } });

    // The service account's key signed the assertion locally; only Google saw it, and the API saw the token.
    const tokenCall = g.calls.find((c) => c.url.startsWith('https://oauth2.googleapis.com/'))!;
    const assertion = new URLSearchParams(String(tokenCall.body)).get('assertion')!;
    const [h, c, s] = assertion.split('.');
    expect(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(sa.publicKey, Buffer.from(s!, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(c!, 'base64url').toString())).toMatchObject({ iss: `migrator@${PROJECT}.iam.gserviceaccount.com`, aud: 'https://oauth2.googleapis.com/token' });
    const apiCalls = g.calls.filter((x) => x.url.startsWith(ORIGIN));
    expect(apiCalls.every((x) => x.headers.get('authorization') === 'Bearer ya29.test')).toBe(true);
    expect(g.calls.some((x) => String(x.body ?? '').includes('PRIVATE KEY'))).toBe(false);
  });

  it('the exported fields reproduce the vendor hash (Firebase scrypt vector)', async () => {
    const g = google();
    const set = await exportFirebase({ projectId: PROJECT, accessToken: 'ya29.direct', fetchImpl: g.fetchImpl, sleep: noSleep });
    const pw = set.list('user')[0]!.password!;
    const dk = scryptSync(VECTOR.password, Buffer.concat([Buffer.from(pw.salt!, 'base64'), Buffer.from(String(pw.params!.salt_separator), 'base64')]), 32, { N: 2 ** Number(pw.params!.mem_cost), r: Number(pw.params!.rounds), p: 1 });
    const c = createCipheriv('aes-256-ctr', dk, Buffer.alloc(16, 0));
    const out = Buffer.concat([c.update(Buffer.from(String(pw.params!.signer_key), 'base64')), c.final()]).toString('base64');
    expect(out).toBe(pw.hash);
  });

  it('leaves hashes out (and says how to fix it) when the hash parameters are unreadable', async () => {
    const g = google({ [`GET /v2/projects/${PROJECT}/config`]: { status: 403, body: { error: { message: 'denied' } } } });
    const set = await exportFirebase({ projectId: PROJECT, accessToken: 't', fetchImpl: g.fetchImpl, sleep: noSleep });
    expect(set.list('user').every((u) => !u.password)).toBe(true);
    expect(set.warnings.join('\n')).toMatch(/firebase-signer-key/);
    // Flags fill them in.
    const withFlags = await exportFirebase({ projectId: PROJECT, accessToken: 't', fetchImpl: google({ [`GET /v2/projects/${PROJECT}/config`]: { status: 403, body: {} } }).fetchImpl, sleep: noSleep, hashParams: { signer_key: VECTOR.signerKey, salt_separator: 'Bw==', rounds: 8, mem_cost: 14 } });
    expect(withFlags.list('user')[0]!.password?.algorithm).toBe('scrypt_firebase');
  });

  it('exports every tenant as an organization, each with its own hash parameters', async () => {
    const g = google({
      [`GET /v2/projects/${PROJECT}/tenants?pageSize=1000`]: { tenants: [{ name: `projects/${PROJECT}/tenants/tenant-a-1x2y`, displayName: 'Tenant A' }] },
      [`GET /v2/projects/${PROJECT}/tenants/tenant-a-1x2y`]: { name: 'x', hashConfig: { ...HASH_CONFIG, rounds: 9 } },
      [`GET /v2/projects/${PROJECT}/tenants/tenant-a-1x2y/inboundSamlConfigs?pageSize=100`]: {},
      [`GET /v1/projects/${PROJECT}/tenants/tenant-a-1x2y/accounts:batchGet?maxResults=1000`]: { users: [{ ...JANE, tenantId: 'tenant-a-1x2y', providerUserInfo: [] }] },
    });
    const set = await exportFirebase({ projectId: PROJECT, accessToken: 't', tenant: 'all', fetchImpl: g.fetchImpl, sleep: noSleep });
    expect(set.list('organization')).toEqual([{ id: 'tenant-a-1x2y', name: 'Tenant A', public_metadata: { firebase_tenant_id: 'tenant-a-1x2y' } }]);
    expect(set.list('membership')).toEqual([{ organization_id: 'tenant-a-1x2y', user_id: JANE.localId, role: 'member' }]);
    expect(set.list('user')[0]!.password?.params?.rounds).toBe(9);
    expect(set.list('user')[0]!.private_metadata).toMatchObject({ firebase_tenant_id: 'tenant-a-1x2y' });
  });
});

describe('auth:export files', () => {
  it('reads the JSON export (standard base64, lastSignedInAt, string customAttributes)', async () => {
    const file = JSON.stringify({
      users: [
        { localId: 'u1', email: 'a@example.com', emailVerified: true, passwordHash: VECTOR.hash, salt: VECTOR.salt, displayName: 'A', lastSignedInAt: '1700000000000', createdAt: '1600000000000', customAttributes: '{"role":"x"}', mfaInfo: [{ mfaEnrollmentId: 'm', phoneInfo: '+14155550123' }], providerUserInfo: [{ providerId: 'github.com', rawId: '42', email: 'a@example.com' }] },
      ],
    });
    const set = await exportFirebase({ projectId: PROJECT, usersText: file, usersFileName: 'users.json', hashParams: { signer_key: VECTOR.signerKey, salt_separator: VECTOR.saltSeparator, rounds: 8, mem_cost: 14 } });
    expect(set.list('user')[0]).toMatchObject({ id: 'u1', last_sign_in_at: 1700000000000, public_metadata: { role: 'x' }, password: { hash: VECTOR.hash, salt: VECTOR.salt } });
    expect(set.list('identity')).toEqual([expect.objectContaining({ provider: 'github', provider_user_id: '42' })]);
    expect(set.list('mfa_factor')).toHaveLength(1);
    expect(set.warnings.join('\n')).toMatch(/ten social providers/);
  });

  it('reads the header-less 52-column CSV (the firebase/scrypt README row)', () => {
    const row = `kYi4EvWQlQTKSfnJ3dRSP6IH3ed2,user1@test.com,false,${VECTOR.hash},${VECTOR.salt},Test User 1,,1093849,g@example.com,G,,,,,,,,,,42,,,,1508893925000,1508893925000,+14155550101,false,"{""a"":1}",,,,,,,,,,,,,,,,,,,,,,,,,`;
    const users = parseFirebaseExport(row, 'users.csv');
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ localId: 'kYi4EvWQlQTKSfnJ3dRSP6IH3ed2', email: 'user1@test.com', passwordHash: VECTOR.hash, displayName: 'Test User 1', createdAt: '1508893925000', phoneNumber: '+14155550101', customAttributes: '{"a":1}' });
    expect(users[0]!.providerUserInfo).toEqual([
      { providerId: 'google.com', rawId: '1093849', email: 'g@example.com', displayName: 'G', photoUrl: '' },
      { providerId: 'github.com', rawId: '42', email: '', displayName: '', photoUrl: '' },
    ]);
    const mapped = mapFirebaseUser(users[0]!, { params: null });
    expect(mapped.user).toMatchObject({ emails: [{ email: 'user1@test.com', verified: false }], public_metadata: { a: 1 } });
    expect(mapped.user!.password).toBeUndefined();
  });

  it('refuses a tenant with an export file', async () => {
    await expect(exportFirebase({ projectId: PROJECT, usersText: '{"users":[]}', tenant: 't1' })).rejects.toThrow(/cannot export a tenant/);
  });
});

describe('helpers', () => {
  it('reads hash parameters in the API and console spellings', () => {
    expect(hashParamsOf({ signerKey: 'a-b_', saltSeparator: 'Bw==', rounds: 8, memoryCost: 14 })).toEqual({ signer_key: 'a+b/', salt_separator: 'Bw==', rounds: 8, mem_cost: 14 });
    expect(hashParamsOf({ base64_signer_key: 'k', base64_salt_separator: 's', rounds: '8', mem_cost: '14' })).toEqual({ signer_key: 'k', salt_separator: 's', rounds: 8, mem_cost: 14 });
  });

  it('signs a JWT-bearer assertion with the key id', () => {
    const sa = JSON.parse(account().json) as { private_key: string; client_email: string; private_key_id: string };
    const jwt = serviceAccountAssertion(sa, 1_700_000_000);
    expect(JSON.parse(Buffer.from(jwt.split('.')[0]!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'key-1' });
    expect(JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString())).toMatchObject({ iat: 1_700_000_000, exp: 1_700_003_600 });
  });
});
