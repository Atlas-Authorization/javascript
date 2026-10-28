import { describe, expect, it } from 'vitest';
import { checkTenantId, exportUserfront, mapUserfrontUser } from './userfront';
import { fakeVendor, noSleep } from './propelauth-harness.test-helper';

/**
 * Userfront admin API responses as its archived API spec documents them:
 * `POST /v0/tenants/{id}/users/find` (`{ results, meta: { totalPages } }`, numeric
 * `userId`, `authorization` keyed by tenant id), the sub-tenant listing and
 * `GET /v0/tenants/{id}/roles`. Unrouted calls answer 404.
 */
const API = 'https://api.userfront.com';
const TID = 'demo1234';
const KEY = 'uf_live_admin_abc';
const V = '/v0';

const JANE = {
  userId: 1,
  userUuid: 'uuid-1',
  email: 'Jane@Acme.example',
  isEmailConfirmed: true,
  username: 'jane',
  name: 'Jane Doe',
  image: 'https://img.example/j.png',
  phoneNumber: '+1 415 555 0101',
  isPhoneNumberConfirmed: false,
  data: { plan: 'pro' },
  authentication: { firstFactors: [{ channel: 'email', strategy: 'password' }, { channel: 'email', strategy: 'google' }], secondFactors: [{ channel: 'sms', strategy: 'totp' }] },
  authorization: { [TID]: { roles: ['admin'] }, org1abcd: { roles: ['owner', 'member'] }, ghost999: { roles: ['x'] } },
  createdAt: '2024-01-01T00:00:00.000Z',
  lastActiveAt: '2024-02-01T00:00:00.000Z',
};
const SAM = {
  userId: 2,
  phoneNumber: '+14155550102',
  isPhoneNumberConfirmed: true,
  locked: true,
  isMfaRequired: true,
  authentication: { firstFactors: [{ channel: 'web', strategy: 'passkey' }] },
  authorization: { org1abcd: { roles: ['member'] } },
};
const OLD = { userId: 4, email: 'old@acme.example', isConfirmed: true };
const NOBODY = { userId: 3 };

function userfrontApi(over: Record<string, unknown> = {}) {
  return fakeVendor(API, {
    [`GET ${V}/tenants/${TID}/tenants?page=0`]: { results: [{ tenantId: 'org1abcd', name: 'Acme', image: 'https://img.example/a.png', data: { tier: 'gold' } }, { tenantId: TID, name: 'self' }], totalPages: 1 },
    [`GET ${V}/tenants/${TID}/roles`]: { roles: [{ name: 'admin' }, { name: 'member' }] },
    [`POST ${V}/tenants/${TID}/users/find`]: ({ body }: { body: unknown }) =>
      (body as { page: number }).page === 0 ? { results: [JANE, SAM, NOBODY, OLD], meta: { totalPages: 1 } } : { results: [] },
    ...over,
  });
}

const run = (api: ReturnType<typeof userfrontApi>, apiKey = KEY) => exportUserfront({ tenantId: TID, apiKey, fetchImpl: api.fetchImpl, sleep: noSleep });

describe('exportUserfront', () => {
  it('sends the admin key and the find body, and stops at an empty page', async () => {
    const api = userfrontApi();
    await run(api);
    const find = api.calls.filter((c) => c.method === 'POST');
    expect(find[0]!.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(find[0]!.body).toEqual({ filters: {}, page: 0, order: [['createdAt', 'ASC']] });
    expect(find.map((c) => (c.body as { page: number }).page)).toEqual([0, 1]);
  });

  it('exports users with verified flags, phones, metadata and the tenant roles', async () => {
    const set = await run(userfrontApi());
    const users = set.list('user');
    expect(users.map((u) => u.id)).toEqual(['1', '2', '4']);
    expect(users[0]).toEqual({
      id: '1',
      emails: [{ email: 'jane@acme.example', verified: true, primary: true }],
      phones: [{ phone: '+14155550101', verified: false, primary: false }],
      username: 'jane',
      name: 'Jane Doe',
      image_url: 'https://img.example/j.png',
      public_metadata: { plan: 'pro' },
      private_metadata: { userfront_user_uuid: 'uuid-1', userfront_tenant_id: TID },
      created_at: '2024-01-01T00:00:00.000Z',
      last_sign_in_at: '2024-02-01T00:00:00.000Z',
      roles: ['admin'],
    });
    expect(users[1]).toMatchObject({ phones: [{ phone: '+14155550102', verified: true, primary: true }], locked: true });
    expect(users[2]!.emails).toEqual([{ email: 'old@acme.example', verified: true, primary: true }]);
    expect(set.omitted.user).toMatchObject({ count: 1, reason: 'no email, phone number or username' });
  });

  it('exports sub-tenants as organizations with each member role, and skips grants to unknown tenants', async () => {
    const set = await run(userfrontApi());
    expect(set.list('organization')).toEqual([{ id: 'org1abcd', name: 'Acme', image_url: 'https://img.example/a.png', public_metadata: { tier: 'gold' } }]);
    expect(set.list('membership')).toEqual([
      { organization_id: 'org1abcd', user_id: '1', role: 'owner' },
      { organization_id: 'org1abcd', user_id: '2', role: 'member' },
    ]);
    expect(set.warnings.some((w) => w.startsWith('1 organization grant(s)'))).toBe(true);
    expect(set.warnings.some((w) => /several Userfront roles/.test(w))).toBe(true);
  });

  it('exports roles at app and organization scope', async () => {
    const set = await run(userfrontApi());
    expect(set.list('role')).toEqual([
      { key: 'admin', name: 'admin', scope: 'app' },
      { key: 'admin', name: 'admin', scope: 'organization' },
      { key: 'member', name: 'member', scope: 'app' },
      { key: 'member', name: 'member', scope: 'organization' },
      { key: 'owner', name: 'owner', scope: 'app' },
      { key: 'owner', name: 'owner', scope: 'organization' },
    ]);
  });

  it('reports what Userfront cannot export and points at lazy migration', async () => {
    const set = await run(userfrontApi());
    expect(set.omitted.mfa_factor).toMatchObject({ count: 2 });
    expect(set.omitted.passkey).toMatchObject({ count: 1 });
    expect(set.omitted.identity).toMatchObject({ count: 1 });
    expect(set.warnings.some((w) => /never returns password hashes/.test(w) && /lazy-migration/.test(w))).toBe(true);
    expect(set.manifest).toEqual({ origin: TID, settings: { tenant_id: TID } });
  });

  it('degrades to users only when the roles and sub-tenant listings are not there', async () => {
    const api = fakeVendor(API, { [`POST ${V}/tenants/${TID}/users/find`]: ({ body }: { body: unknown }) => ((body as { page: number }).page === 0 ? { results: [OLD] } : { results: [] }) });
    const set = await run(api as ReturnType<typeof userfrontApi>);
    expect(set.count('user')).toBe(1);
    expect(set.count('organization')).toBe(0);
    expect(set.count('role')).toBe(0);
  });

  it('refuses a key that is not an admin key and a malformed tenant id', async () => {
    await expect(run(userfrontApi(), 'uf_live_abc')).rejects.toThrow(/admin API key/);
    await expect(exportUserfront({ tenantId: 'no spaces!', apiKey: KEY })).rejects.toThrow(/tenant id/);
  });

  it('lets a rejected key through as an error', async () => {
    const api = userfrontApi({ [`POST ${V}/tenants/${TID}/users/find`]: { status: 401, body: { message: 'bad key' } } });
    await expect(run(api)).rejects.toThrow(/401/);
  });
});

describe('mapUserfrontUser and checkTenantId', () => {
  it('drops a row with no id or no identifier', () => {
    expect(mapUserfrontUser({ email: 'a@b.example' }, TID)).toBeNull();
    expect(mapUserfrontUser({ userId: 9 }, TID)).toBeNull();
  });

  it('keeps a username-only user', () => {
    expect(mapUserfrontUser({ userId: 9, username: 'solo' }, TID)).toMatchObject({ id: '9', username: 'solo' });
  });

  it('trims and validates tenant ids', () => {
    expect(checkTenantId(' demo1234 ')).toBe('demo1234');
    expect(() => checkTenantId('ab')).toThrow(/tenant id/);
  });
});
