import { createCipheriv, randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decryptKindeExport, exportKinde, kindePasswordHash, mapKindeUser } from './kinde';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';
import { readZip } from './zip';

/**
 * Kinde's data export as its documentation specifies it: an AES-256-CTR
 * encrypted `.dat` (hex Key + IV shown at download) holding a zip with
 * `users.ndjson` / `organizations.ndjson` / `access_requests.ndjson`, user
 * rows per the published JSON schema (with the optional `password` object).
 */
const USERS = [
  {
    id: 'kp_0a1b2c',
    email: 'Ada@Example.com',
    phone: null,
    username: null,
    first_name: 'Ada',
    last_name: 'Lovelace',
    created_on: '2023-01-01T00:00:00.000000+00:00',
    identities: [{ type: 'email', identity: 'ada@example.com' }, { type: 'oauth2:google', identity: 'ada@example.com', provider: 'google' }],
    external_id: 'legacy-17',
    business_code: 'bus_1',
    organizations: ['org_default', 'org_acme'],
    email_verified: true,
    password: { hashed_password: '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', hashing_algorithm: 'bcrypt', hashing_config: {} },
  },
  {
    id: 'kp_ffee',
    email: 'bo@example.com',
    phone: '+61 412 345 678',
    username: 'bo',
    first_name: null,
    last_name: null,
    created_on: '2023-02-01T00:00:00.000000+00:00',
    identities: [{ type: 'email', identity: 'bo@example.com' }],
    external_id: null,
    business_code: 'bus_1',
    organizations: ['org_default'],
    email_verified: false,
    password: { hashed_password: '5f4dcc3b5aa765d61d8327deb882cf99', hashing_algorithm: 'md5', hashing_config: { salt: 'NaCl', salt_position: 'prefix' } },
  },
];
const ORGS = [
  { name: 'Default Organization', created_on: '2023-01-01T00:00:00+00:00', business_code: 'bus_1', organization_code: 'org_default' },
  { name: 'Acme', created_on: '2023-01-02T00:00:00+00:00', business_code: 'bus_1', organization_code: 'org_acme' },
];
const ndjson = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

/** A minimal ZIP writer (deflated entries), the shape Kinde's export unpacks to. */
function makeZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const packed = deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function encryptedExport() {
  const zip = makeZip({ 'export/users.ndjson': ndjson(USERS), 'export/organizations.ndjson': ndjson(ORGS), 'export/access_requests.ndjson': '' });
  const key = randomBytes(32);
  const iv = randomBytes(16);
  const c = createCipheriv('aes-256-ctr', key, iv);
  return { data: Buffer.concat([c.update(zip), c.final()]), key: key.toString('hex'), iv: iv.toString('hex') };
}

describe('Kinde data export', () => {
  it('decrypts the .dat (AES-256-CTR) and reads the zip', () => {
    const enc = encryptedExport();
    const files = readZip(decryptKindeExport(enc.data, enc.key, enc.iv));
    expect([...files.keys()].sort()).toEqual(['export/access_requests.ndjson', 'export/organizations.ndjson', 'export/users.ndjson']);
    expect(() => decryptKindeExport(enc.data, 'abcd', enc.iv)).toThrow(/64 hex/);
  });

  it('maps users, passwords and organizations from the export alone', async () => {
    const set = await exportKinde({ encryptedExport: encryptedExport() });
    expect(set.list('organization')).toEqual([{ id: 'org_acme', name: 'Acme', created_at: '2023-01-02T00:00:00+00:00' }]);
    const [ada, bo] = set.list('user');
    expect(ada).toEqual({
      id: 'kp_0a1b2c',
      emails: [{ email: 'ada@example.com', verified: true, primary: true }],
      first_name: 'Ada',
      last_name: 'Lovelace',
      private_metadata: { kinde_external_id: 'legacy-17' },
      created_at: '2023-01-01T00:00:00.000000+00:00',
      password: { algorithm: 'bcrypt', hash: '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy' },
    });
    expect(bo).toEqual({
      id: 'kp_ffee',
      emails: [{ email: 'bo@example.com', verified: false, primary: true }],
      phones: [{ phone: '+61412345678', verified: false, primary: false }],
      username: 'bo',
      created_at: '2023-02-01T00:00:00.000000+00:00',
      password: { algorithm: 'md5_salted', hash: '5f4dcc3b5aa765d61d8327deb882cf99', salt: 'NaCl', params: { encoding: 'hex', salt_position: 'prefix' } },
    });
    expect(set.list('membership')).toEqual([{ organization_id: 'org_acme', user_id: 'kp_0a1b2c', role: 'member' }]);
    expect(set.omitted.identity?.reason).toMatch(/relink by verified email/);
    expect(set.warnings.some((w) => w.includes('default organization (org_default)'))).toBe(true);
  });

  it('a wrong Key/IV is caught before parsing', async () => {
    const enc = encryptedExport();
    await expect(exportKinde({ encryptedExport: { ...enc, key: 'ab'.repeat(32) } })).rejects.toThrow(/not a zip/);
  });
});

describe('Kinde Management API', () => {
  const ORIGIN = 'https://acme.kinde.com';
  function kindeApi() {
    return fakeVendor(ORIGIN, {
      'POST /oauth2/token': ({ body }: { body: unknown }) => {
        const form = new URLSearchParams(String(body));
        return form.get('audience') === `${ORIGIN}/api` && form.get('client_secret') === 'm2m' ? { access_token: 'kinde_token' } : { status: 401, body: {} };
      },
      'GET /api/v1/organizations': { code: 'OK', organizations: [{ code: 'org_default', name: 'Default Organization', is_default: true }, { code: 'org_acme', name: 'Acme', handle: 'acme', is_default: false }], next_token: null },
      'GET /api/v1/roles': { roles: [{ id: 'r1', key: 'admin', name: 'Admin', description: 'All' }], next_token: null },
      'GET /api/v1/roles/r1/permissions': { permissions: [{ id: 'p1', key: 'read:invoices' }] },
      'GET /api/v1/users': ({ url }: { url: URL }) =>
        url.searchParams.get('next_token')
          ? { users: [{ id: 'kp_api_only', email: 'api@example.com', first_name: 'Api', is_suspended: true, created_on: '2024-01-01T00:00:00Z', last_signed_in: '2024-02-01T00:00:00Z' }], next_token: null }
          : { users: [{ id: 'kp_0a1b2c', email: 'ada@example.com', picture: 'https://gravatar/ada', last_signed_in: '2024-03-01T00:00:00Z' }], next_token: 'tok2' },
      'GET /api/v1/organizations/org_acme/users': { organization_users: [{ id: 'kp_0a1b2c', email: 'ada@example.com', roles: ['admin'], joined_on: '2023-05-01T00:00:00Z' }], next_token: null },
      'GET /api/v1/connections': { connections: [{ id: 'conn_1', name: 'okta-saml', display_name: 'Corp SAML', strategy: 'saml:custom' }, { id: 'conn_2', name: 'google', strategy: 'oauth2:google' }] },
      'GET /api/v1/connections/conn_1': { id: 'conn_1', options: { home_realm_domains: ['corp.example'], saml_entity_id: 'https://idp.corp.example', saml_idp_metadata_url: 'https://idp.corp.example/metadata' } },
    });
  }

  it('merges the export with organizations, roles, memberships and connections from the API', async () => {
    const api = kindeApi();
    const set = await exportKinde({ domain: 'acme.kinde.com', clientId: 'cid', clientSecret: 'm2m', zip: makeZip({ 'users.ndjson': ndjson(USERS) }), fetchImpl: api.fetchImpl, sleep: noSleep });
    expect(api.calls.filter((c) => c.url.includes('/api/v1/')).every((c) => c.headers.get('authorization') === 'Bearer kinde_token')).toBe(true);
    expect(set.list('organization')).toEqual([{ id: 'org_acme', name: 'Acme', slug: 'acme' }]);
    expect(set.list('role')).toEqual([{ key: 'admin', name: 'Admin', description: 'All', scope: 'organization', permissions: ['read:invoices'] }]);
    const ids = set.list('user').map((u) => u.id);
    expect(ids).toEqual(['kp_0a1b2c', 'kp_ffee', 'kp_api_only']);
    // Export fields win over the API's; the API fills what the export lacks.
    const ada = set.list('user')[0]!;
    expect(ada.password?.algorithm).toBe('bcrypt');
    expect(ada.image_url).toBe('https://gravatar/ada');
    expect(ada.last_sign_in_at).toBe('2024-03-01T00:00:00Z');
    expect(set.list('user')[2]).toMatchObject({ banned: true, emails: [{ email: 'api@example.com', verified: false, primary: true }] });
    expect(set.list('membership')).toEqual([{ organization_id: 'org_acme', user_id: 'kp_0a1b2c', role: 'admin', created_at: '2023-05-01T00:00:00Z' }]);
    expect(set.list('sso_connection')).toEqual([
      { id: 'conn_1', name: 'Corp SAML', protocol: 'saml', domains: ['corp.example'], saml: { idp_entity_id: 'https://idp.corp.example', idp_metadata_url: 'https://idp.corp.example/metadata' } },
    ]);
  });
});

describe('kindePasswordHash', () => {
  it('maps the algorithms Kinde stores or imported', () => {
    expect(kindePasswordHash({ hashed_password: '$6$rounds=5000$salt$hash', hashing_algorithm: 'crypt' })).toEqual({ algorithm: 'auto', hash: '$6$rounds=5000$salt$hash' });
    expect(kindePasswordHash({ hashed_password: '$P$Babcdefgh', hashing_algorithm: 'wordpress' })).toEqual({ algorithm: 'auto', hash: '$P$Babcdefgh' });
    expect(kindePasswordHash({ hashed_password: 'AQAAAAEAACcQ', hashing_algorithm: 'aspnet_identity_v2' })).toEqual({ algorithm: 'aspnet_identity', hash: 'AQAAAAEAACcQ' });
    expect(kindePasswordHash({ hashed_password: 'abc', hashing_algorithm: 'sha256' })).toEqual({ algorithm: 'sha256', hash: 'abc', params: { encoding: 'hex' } });
    expect(kindePasswordHash({ hashed_password: 'h', hashing_algorithm: 'firebase-scrypt', hashing_config: { salt: 's', signer_key: 'k', rounds: 8, mem_cost: 14 } })).toEqual({
      algorithm: 'scrypt_firebase',
      hash: 'h',
      salt: 's',
      params: { signer_key: 'k', salt_separator: 'Bw==', rounds: 8, mem_cost: 14 },
    });
    expect(kindePasswordHash({ hashed_password: 'h', hashing_algorithm: 'pbkdf2' })).toHaveProperty('reason');
    expect(kindePasswordHash({ hashed_password: 'h', hashing_algorithm: 'rot13' })).toHaveProperty('reason');
  });

  it('a phone-only user maps; one without any identifier does not', () => {
    expect(mapKindeUser({ id: 'kp_1', phone: '+14155550100', identities: [] })).toMatchObject({ phones: [{ phone: '+14155550100', verified: false, primary: true }] });
    expect(mapKindeUser({ id: 'kp_2', identities: [] })).toBeNull();
  });
});
