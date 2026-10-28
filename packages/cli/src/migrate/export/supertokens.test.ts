import { describe, expect, it } from 'vitest';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';
import { Tables } from './frameworks/tables';
import { corePrefix, exportSupertokens, mapSupertokensPassword, normalizeCoreUri } from './supertokens';

/**
 * The SuperTokens core as it stores and serves its data: `psql \copy` style
 * rows (snake_case columns, epoch-ms times, JSON as text) for a database dump,
 * and the core's `/users`, `/recipe/…` JSON for the API.
 */
const BCRYPT = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
const ARGON = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$RdescudvJCsgt3ub+b+dWRWJTmaaJObG';

const app = { app_id: 'public' };

function dump(): Tables {
  return new Tables({
    all_auth_recipe_users: [
      { ...app, tenant_id: 'public', user_id: 'ep-ada', primary_or_recipe_user_id: 'ep-ada', is_linked_or_is_a_primary_user: 't', recipe_id: 'emailpassword', time_joined: 1700000000000 },
      { ...app, tenant_id: 'acme', user_id: 'ep-ada', primary_or_recipe_user_id: 'ep-ada', is_linked_or_is_a_primary_user: 't', recipe_id: 'emailpassword', time_joined: 1700000000000 },
      { ...app, tenant_id: 'public', user_id: 'tp-ada', primary_or_recipe_user_id: 'ep-ada', is_linked_or_is_a_primary_user: 't', recipe_id: 'thirdparty', time_joined: 1701000000000 },
      { ...app, tenant_id: 'public', user_id: 'ep-bob', primary_or_recipe_user_id: 'ep-bob', recipe_id: 'emailpassword', time_joined: 1702000000000 },
      { ...app, tenant_id: 'public', user_id: 'ep-dan', primary_or_recipe_user_id: 'ep-dan', recipe_id: 'emailpassword', time_joined: 1703000000000 },
      { ...app, tenant_id: 'public', user_id: 'tp-eve', primary_or_recipe_user_id: 'tp-eve', recipe_id: 'thirdparty', time_joined: 1704000000000 },
      { ...app, tenant_id: 'public', user_id: 'pl-cy', primary_or_recipe_user_id: 'pl-cy', recipe_id: 'passwordless', time_joined: 1705000000000 },
      { app_id: 'other-app', tenant_id: 'public', user_id: 'x-other', primary_or_recipe_user_id: 'x-other', recipe_id: 'emailpassword', time_joined: 1 },
    ],
    emailpassword_users: [
      { ...app, user_id: 'ep-ada', email: 'Ada@Example.com', password_hash: BCRYPT, time_joined: 1700000000000 },
      { ...app, user_id: 'ep-bob', email: 'bob@acme.example', password_hash: ARGON, time_joined: 1702000000000 },
      { ...app, user_id: 'ep-dan', email: 'dan@example.com', password_hash: '$f_scrypt$aGFzaA==$c2FsdA==$m=14$r=8$p=1', time_joined: 1703000000000 },
      { app_id: 'other-app', user_id: 'x-other', email: 'x@other.example', password_hash: BCRYPT, time_joined: 1 },
    ],
    thirdparty_users: [
      { ...app, third_party_id: 'google', third_party_user_id: '1093', user_id: 'tp-ada', email: 'ada@gmail.com', time_joined: 1701000000000 },
      { ...app, third_party_id: 'github', third_party_user_id: '77', user_id: 'tp-eve', email: '', time_joined: 1704000000000 },
    ],
    passwordless_users: [{ ...app, user_id: 'pl-cy', email: 'cy@example.com', phone_number: '+1 415 555 0101', time_joined: 1705000000000 }],
    emailverification_verified_emails: [{ ...app, user_id: 'ep-ada', email: 'ada@example.com' }],
    roles: [{ ...app, role: 'admin' }, { ...app, role: 'billing' }],
    role_permissions: [{ ...app, role: 'admin', permission: 'users:write' }, { ...app, role: 'admin', permission: 'users:read' }],
    userroles: [
      { ...app, tenant_id: 'public', user_id: 'app-ada', role: 'admin' },
      { ...app, tenant_id: 'acme', user_id: 'ep-ada', role: 'billing' },
    ],
    tenants: [{ ...app, tenant_id: 'public' }, { ...app, tenant_id: 'acme' }],
    user_metadata: [{ ...app, user_id: 'ep-ada', user_metadata: '{"first_name":"Ada","last_name":"Lovelace","plan":"pro"}' }],
    totp_user_devices: [
      { ...app, user_id: 'ep-ada', device_name: 'phone', secret_key: 'jbswy3dpehpk3pxp', period: 30, skew: 1, verified: 't' },
      { ...app, user_id: 'ep-ada', device_name: 'old', secret_key: 'MFRGGZDFMZTWQ2LK', period: 30, skew: 1, verified: 'f' },
    ],
    user_last_active: [{ ...app, user_id: 'ep-ada', last_active_time: 1710000000000 }],
    userid_mapping: [{ ...app, supertokens_user_id: 'ep-ada', external_user_id: 'app-ada' }],
  });
}

describe('exportSupertokens: database dump', () => {
  it('folds linked login methods into one user and maps passwords, verification, roles, TOTP and tenants', async () => {
    const set = await exportSupertokens({ tables: dump() });

    // The user id is the one the app sees (userid_mapping); another app's users are not carried.
    expect(set.list('user').map((u) => u.id)).toEqual(['app-ada', 'ep-bob', 'ep-dan', 'pl-cy']);
    const [ada, bob, dan, cy] = set.list('user');
    expect(ada).toMatchObject({
      id: 'app-ada',
      emails: [
        { email: 'ada@example.com', verified: true, primary: true },
        { email: 'ada@gmail.com', verified: false, primary: false },
      ],
      first_name: 'Ada',
      last_name: 'Lovelace',
      password: { algorithm: 'bcrypt', hash: BCRYPT },
      roles: ['admin'],
      private_metadata: { plan: 'pro', first_name: 'Ada' },
      created_at: 1700000000000,
      last_sign_in_at: 1710000000000,
    });
    expect(bob).toMatchObject({ emails: [{ email: 'bob@acme.example', verified: false, primary: true }], password: { algorithm: 'argon2', hash: ARGON } });
    expect(dan!.password).toBeUndefined();
    expect(cy).toMatchObject({ emails: [{ email: 'cy@example.com', verified: true, primary: true }], phones: [{ phone: '+14155550101', verified: true, primary: true }] });
    expect(set.omitted.user).toEqual({ count: 1, reason: 'no email address or phone number' });
    expect(set.warnings.some((w) => w.includes('1 user(s) have a password hash Atlas cannot verify'))).toBe(true);

    expect(set.list('identity')).toEqual([{ user_id: 'app-ada', provider: 'google', provider_user_id: '1093', kind: 'oauth', email: 'ada@gmail.com', email_verified: false }]);

    expect(set.list('role')).toEqual([
      { key: 'admin', name: 'admin', scope: 'app', permissions: ['users:write', 'users:read'] },
      { key: 'billing', name: 'billing', scope: 'app' },
      { key: 'billing', name: 'billing', scope: 'organization' },
    ]);
    expect(set.list('organization')).toEqual([{ id: 'acme', name: 'acme', slug: 'acme' }]);
    expect(set.list('membership')).toEqual([{ organization_id: 'acme', user_id: 'app-ada', role: 'billing' }]);

    // Only the verified device moves, with its secret.
    expect(set.list('mfa_factor')).toEqual([{ user_id: 'app-ada', type: 'totp', secret_base32: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, verified: true }]);
    expect(set.omitted.mfa_factor).toEqual({ count: 1, reason: 'a TOTP device that was never verified' });

    expect(set.manifest).toMatchObject({
      origin: 'SuperTokens database (app public)',
      providers: ['google'],
      settings: { app_id: 'public', read_from: 'database', password_algorithms: { bcrypt: 1, argon2: 1 } },
    });
    expect(set.warnings.some((w) => w.includes('Sessions are not exported'))).toBe(true);
  });

  it('gives a tenant member without a role there the member role, and reads a table prefix', async () => {
    const tables = new Tables({
      st_all_auth_recipe_users: [{ tenant_id: 'acme', user_id: 'u1', primary_or_recipe_user_id: 'u1', recipe_id: 'emailpassword' }],
      st_emailpassword_users: [{ user_id: 'u1', email: 'a@acme.example', password_hash: BCRYPT }],
    });
    const set = await exportSupertokens({ tables, tablePrefix: 'st_' });
    expect(set.list('membership')).toEqual([{ organization_id: 'acme', user_id: 'u1', role: 'member' }]);
    expect(set.list('role')).toEqual([{ key: 'member', name: 'Member', scope: 'organization' }]);
  });

  it('works for a core older than account linking (no all_auth_recipe_users)', async () => {
    const tables = new Tables({ emailpassword_users: [{ user_id: 'u1', email: 'a@b.example', password_hash: BCRYPT, time_joined: 1700000000000 }] });
    const set = await exportSupertokens({ tables });
    expect(set.list('user')).toEqual([expect.objectContaining({ id: 'u1', emails: [{ email: 'a@b.example', verified: false, primary: true }] })]);
  });
});

describe('exportSupertokens: core API', () => {
  const ORIGIN = 'https://st-dev-1234.aws.supertokens.io';
  const U1 = {
    id: 'u1',
    isPrimaryUser: true,
    tenantIds: ['public', 'acme'],
    emails: ['ada@example.com'],
    loginMethods: [
      { recipeId: 'emailpassword', recipeUserId: 'u1', tenantIds: ['public', 'acme'], email: 'ada@example.com', verified: true, timeJoined: 1700000000000 },
      { recipeId: 'thirdparty', recipeUserId: 'u1b', tenantIds: ['public'], email: 'ada@gmail.com', thirdParty: { id: 'google', userId: '1093' }, verified: true, timeJoined: 1701000000000 },
    ],
    timeJoined: 1700000000000,
  };
  const U2 = { id: 'u2', loginMethods: [{ recipeId: 'passwordless', recipeUserId: 'u2', tenantIds: ['public'], email: 'bob@example.com', phoneNumber: '+14155550101', verified: true, timeJoined: 1702000000000 }], timeJoined: 1702000000000 };

  function core(over: Record<string, unknown> = {}) {
    return fakeVendor(ORIGIN, {
      'GET /recipe/multitenancy/tenant/list/v2': { status: 'OK', tenants: [{ tenantId: 'public' }, { tenantId: 'acme' }] },
      'GET /users': ({ url }: { url: URL }) => (url.searchParams.get('paginationToken') ? { status: 'OK', users: [U2] } : { status: 'OK', users: [U1], nextPaginationToken: 'tok' }),
      'GET /acme/users': { status: 'OK', users: [U1] },
      'GET /recipe/roles': { status: 'OK', roles: ['admin'] },
      'GET /recipe/role/permissions': { status: 'OK', permissions: ['users:read'] },
      'GET /recipe/user/roles': ({ url }: { url: URL }) => ({ status: 'OK', roles: url.searchParams.get('userId') === 'u1' ? ['admin'] : [] }),
      'GET /acme/recipe/user/roles': ({ url }: { url: URL }) => ({ status: 'OK', roles: url.searchParams.get('userId') === 'u1' ? ['admin'] : [] }),
      'GET /recipe/user/metadata': ({ url }: { url: URL }) => ({ status: 'OK', metadata: url.searchParams.get('userId') === 'u1' ? { first_name: 'Ada' } : {} }),
      ...over,
    });
  }

  it('lists users across tenants and pages, with the API key on every call', async () => {
    const api = core();
    const set = await exportSupertokens({ connectionUri: ORIGIN, apiKey: 'core-key', fetchImpl: api.fetchImpl, sleep: noSleep });
    expect(api.calls.every((c) => c.headers.get('api-key') === 'core-key')).toBe(true);
    expect(api.calls.some((c) => c.url.includes('paginationToken=tok'))).toBe(true);

    expect(set.list('user').map((u) => u.id)).toEqual(['u1', 'u2']);
    expect(set.list('user')[0]).toMatchObject({
      emails: [{ email: 'ada@example.com', verified: true, primary: true }, { email: 'ada@gmail.com', verified: true, primary: false }],
      roles: ['admin'],
      first_name: 'Ada',
    });
    expect(set.list('user')[0]!.password).toBeUndefined();
    expect(set.list('user')[1]).toMatchObject({ emails: [{ email: 'bob@example.com', verified: true, primary: true }], phones: [{ phone: '+14155550101', verified: true, primary: true }] });
    expect(set.list('identity')).toEqual([expect.objectContaining({ user_id: 'u1', provider: 'google', provider_user_id: '1093' })]);
    expect(set.list('organization')).toEqual([{ id: 'acme', name: 'acme', slug: 'acme' }]);
    expect(set.list('membership')).toEqual([{ organization_id: 'acme', user_id: 'u1', role: 'admin' }]);
    expect(set.list('role').map((r) => `${r.scope}:${r.key}`)).toEqual(['app:admin', 'organization:admin']);
    expect(set.warnings.some((w) => w.includes('1 user(s) sign in with a password the core API never returns'))).toBe(true);
    expect(set.warnings.some((w) => w.includes('never returns password hashes or TOTP secrets'))).toBe(true);
    expect(set.manifest).toMatchObject({ origin: 'st-dev-1234.aws.supertokens.io', settings: { read_from: 'api' } });
  });

  it('uses the app and tenant path prefixes of a multi-app core', async () => {
    expect(corePrefix('public', 'public')).toBe('');
    expect(corePrefix('shop', 'acme')).toBe('/appid-shop/acme');
    const api = fakeVendor(ORIGIN, {
      'GET /appid-shop/recipe/multitenancy/tenant/list/v2': { status: 'OK', tenants: [{ tenantId: 'public' }] },
      'GET /appid-shop/users': { status: 'OK', users: [U2] },
      'GET /appid-shop/recipe/roles': { status: 'OK', roles: [] },
      'GET /appid-shop/recipe/user/metadata': { status: 'OK', metadata: {} },
    });
    const set = await exportSupertokens({ connectionUri: ORIGIN, appId: 'shop', fetchImpl: api.fetchImpl, sleep: noSleep });
    expect(set.list('user').map((u) => u.id)).toEqual(['u2']);
    expect(api.calls[0]!.headers.get('api-key')).toBeNull();
  });

  it('warns and goes on when the tenant list is not available, and refuses without a source', async () => {
    const api = core({ 'GET /recipe/multitenancy/tenant/list/v2': { status: 404, body: {} }, 'GET /recipe/multitenancy/tenant/list': { status: 404, body: {} } });
    const set = await exportSupertokens({ connectionUri: ORIGIN, fetchImpl: api.fetchImpl, sleep: noSleep });
    expect(set.warnings).toContain('The tenant list could not be read (404): skipped.');
    expect(set.count('user')).toBeGreaterThan(0);
    await expect(exportSupertokens({})).rejects.toThrow(/database dump/);
  });
});

describe('helpers', () => {
  it('maps bcrypt and Argon2 hashes and leaves the rest', () => {
    expect(mapSupertokensPassword(BCRYPT)).toEqual({ algorithm: 'bcrypt', hash: BCRYPT });
    expect(mapSupertokensPassword(ARGON)).toEqual({ algorithm: 'argon2', hash: ARGON });
    expect(mapSupertokensPassword('$f_scrypt$aGFzaA==$c2FsdA==')).toBeNull();
    expect(mapSupertokensPassword('')).toBeNull();
    expect(mapSupertokensPassword(undefined)).toBeNull();
  });

  it('normalises the core address', () => {
    expect(normalizeCoreUri('st-dev-1.aws.supertokens.io/')).toBe('https://st-dev-1.aws.supertokens.io');
    expect(normalizeCoreUri('http://localhost:3567/')).toBe('http://localhost:3567');
  });
});
