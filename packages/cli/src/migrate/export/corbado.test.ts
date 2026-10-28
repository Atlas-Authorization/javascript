import { describe, expect, it } from 'vitest';
import { exportCorbado, mapCorbadoUser } from './corbado';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';

/**
 * Corbado Backend API v2 as documented: `GET /v2/users` (page / pageSize,
 * `{ users: userAggregate[], paging }` with email / phone / username
 * identifiers of status pending | verified | primary) and
 * `GET /v2/users/{id}/fullCredentials` (`{ fullCredentials: [...] }`, base64url
 * credential id and public key). HTTP Basic auth: project id + API secret.
 */
const ORIGIN = 'https://backendapi.cloud.corbado.io';
const PROJECT = 'pro-1234567890';
const SECRET = 'corbado1_secret';

const JANE = {
  userID: 'usr-1',
  fullName: 'Jane Doe',
  status: 'active',
  emailIdentifiers: [
    { identifierID: 'idf-1', type: 'email', value: 'Jane@Acme.example', status: 'primary', userID: 'usr-1' },
    { identifierID: 'idf-2', type: 'email', value: 'jd@x.example', status: 'pending', userID: 'usr-1' },
  ],
  phoneNumberIdentifiers: [{ identifierID: 'idf-3', type: 'phone', value: '+14155550101', status: 'verified', userID: 'usr-1' }],
  usernameIdentifiers: [{ identifierID: 'idf-4', type: 'username', value: 'janed', status: 'verified', userID: 'usr-1' }],
  socialAccounts: [],
  created: '2024-01-02T03:04:05',
  createdMS: 1700000000000,
};
const BOB = {
  userID: 'usr-2',
  status: 'disabled',
  emailIdentifiers: [{ identifierID: 'idf-5', type: 'email', value: 'bob@acme.example', status: 'verified', userID: 'usr-2' }],
  phoneNumberIdentifiers: [],
  usernameIdentifiers: [],
};
const GONE = { userID: 'usr-3', status: 'deleted', emailIdentifiers: [{ value: 'gone@acme.example', status: 'verified' }] };
const NOID = { userID: 'usr-4', status: 'pending', emailIdentifiers: [], phoneNumberIdentifiers: [], usernameIdentifiers: [] };

const CRED = {
  credentialID: 'cred1',
  publicKey: 'pk1',
  authenticatorSignCount: 5,
  authenticatorAAGUID: 'aaguid-1',
  authenticatorAttachment: 'platform',
  backupEligible: true,
  backupState: true,
  transports: ['internal', 'hybrid'],
  attestationFormat: 'none',
  created: '2024-01-02T03:04:05',
  createdMs: 1700000001000,
  status: 'active',
};

function api(over: Record<string, unknown> = {}) {
  return fakeVendor(ORIGIN, {
    'GET /v2/users': { users: [JANE, BOB, GONE, NOID], paging: { page: 1, totalPages: 1, totalItems: 4 } },
    'GET /v2/users/usr-1/fullCredentials': { fullCredentials: [CRED, { ...CRED, credentialID: '', publicKey: 'x' }] },
    ...over,
  });
}

describe('exportCorbado', () => {
  it('maps users, identifiers and passkeys with Basic auth, and lists what it skips', async () => {
    const a = api();
    const progress: string[] = [];
    const set = await exportCorbado({ projectId: PROJECT, apiSecret: SECRET, rpId: 'acme.example', fetchImpl: a.fetchImpl, sleep: noSleep, onProgress: (m) => progress.push(m) });

    const auth = `Basic ${Buffer.from(`${PROJECT}:${SECRET}`).toString('base64')}`;
    expect(a.calls.every((c) => c.headers.get('authorization') === auth)).toBe(true);
    expect(progress).toEqual(['users', 'passkeys']);
    expect(a.calls[0]!.url).toBe(`${ORIGIN}/v2/users?page=1&pageSize=100&sort=%2Bcreated&includeIdentifiers=true`);

    expect(set.list('user')).toEqual([
      {
        id: 'usr-1',
        emails: [
          { email: 'jane@acme.example', verified: true, primary: true },
          { email: 'jd@x.example', verified: false, primary: false },
        ],
        phones: [{ phone: '+14155550101', verified: true, primary: false }],
        username: 'janed',
        name: 'Jane Doe',
        created_at: 1700000000000,
      },
      { id: 'usr-2', emails: [{ email: 'bob@acme.example', verified: true, primary: true }], banned: true },
    ]);
    expect(set.omitted.user!.count).toBe(2);
    expect(set.list('passkey')).toEqual([
      {
        user_id: 'usr-1',
        credential_id: 'cred1',
        public_key: 'pk1',
        sign_count: 5,
        rp_id: 'acme.example',
        transports: ['internal', 'hybrid'],
        aaguid: 'aaguid-1',
        backed_up: true,
        created_at: 1700000001000,
      },
    ]);
    // usr-2 has no route: a 404 means no passkeys, not a failure.
    expect(a.calls.map((c) => c.url)).toContain(`${ORIGIN}/v2/users/usr-2/fullCredentials`);
    expect(set.manifest).toEqual({ origin: PROJECT, settings: { project_id: PROJECT }, rpId: 'acme.example' });
    expect(set.warnings.some((w) => w.includes('bound to acme.example'))).toBe(true);
  });

  it('pages until the reported total pages', async () => {
    const a = api({
      'GET /v2/users': ({ url }: { url: URL }) =>
        url.searchParams.get('page') === '1'
          ? { users: [JANE], paging: { page: 1, totalPages: 2, totalItems: 2 } }
          : { users: [BOB], paging: { page: 2, totalPages: 2, totalItems: 2 } },
    });
    const set = await exportCorbado({ projectId: PROJECT, apiSecret: SECRET, fetchImpl: a.fetchImpl, sleep: noSleep });
    expect(set.list('user').map((u) => u.id)).toEqual(['usr-1', 'usr-2']);
    expect(a.calls.filter((c) => c.url.includes('/v2/users?'))).toHaveLength(2);
  });

  it('does not call the passkey endpoint without a relying-party id, and says why', async () => {
    const a = api();
    const set = await exportCorbado({ projectId: PROJECT, apiSecret: SECRET, fetchImpl: a.fetchImpl, sleep: noSleep });
    expect(a.calls.some((c) => c.url.includes('fullCredentials'))).toBe(false);
    expect(set.count('passkey')).toBe(0);
    expect(set.warnings.some((w) => w.includes('--corbado-rp-id'))).toBe(true);
    expect(set.manifest.rpId).toBeUndefined();
  });

  it('stops asking for passkeys once Corbado refuses the export permission', async () => {
    const a = api({ 'GET /v2/users/usr-1/fullCredentials': { status: 403, body: { message: 'forbidden' } } });
    const set = await exportCorbado({ projectId: PROJECT, apiSecret: SECRET, rpId: 'acme.example', fetchImpl: a.fetchImpl, sleep: noSleep });
    expect(a.calls.filter((c) => c.url.includes('fullCredentials'))).toHaveLength(1);
    expect(set.warnings.some((w) => w.includes('credentials:export'))).toBe(true);
  });

  it('rejects a bad project id or a missing secret before calling Corbado', async () => {
    const a = api();
    await expect(exportCorbado({ projectId: 'nope', apiSecret: SECRET, fetchImpl: a.fetchImpl })).rejects.toThrow(/project id/);
    await expect(exportCorbado({ projectId: PROJECT, apiSecret: '', fetchImpl: a.fetchImpl })).rejects.toThrow(/API secret/);
    expect(a.calls).toHaveLength(0);
  });

  it('fails with the vendor message when the user listing is refused', async () => {
    const a = api({ 'GET /v2/users': { status: 401, body: { message: 'bad credentials' } } });
    await expect(exportCorbado({ projectId: PROJECT, apiSecret: SECRET, fetchImpl: a.fetchImpl, sleep: noSleep })).rejects.toThrow(/401.*bad credentials/);
  });
});

describe('mapCorbadoUser', () => {
  it('makes the first email primary when none is, and drops invalid phones', () => {
    const u = mapCorbadoUser({ userID: 'usr-9', status: 'active', emailIdentifiers: [{ value: 'a@b.example', status: 'verified' }], phoneNumberIdentifiers: [{ value: '12', status: 'verified' }] });
    expect(u).toEqual({ id: 'usr-9', emails: [{ email: 'a@b.example', verified: true, primary: true }] });
  });

  it('gives a phone-only user a primary phone', () => {
    const u = mapCorbadoUser({ userID: 'usr-8', status: 'active', phoneNumberIdentifiers: [{ value: '+1 415 555 0102', status: 'verified' }] });
    expect(u).toEqual({ id: 'usr-8', phones: [{ phone: '+14155550102', verified: true, primary: true }] });
  });

  it('flags deleted users and rejects users without a usable identifier', () => {
    expect(mapCorbadoUser({ userID: 'usr-7', status: 'deleted' })).toBe('deleted');
    expect(mapCorbadoUser({ userID: 'usr-6', status: 'active' })).toBeNull();
    expect(mapCorbadoUser({ status: 'active' })).toBeNull();
  });
});
