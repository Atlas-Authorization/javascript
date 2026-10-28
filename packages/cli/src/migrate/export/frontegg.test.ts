import { describe, expect, it } from 'vitest';
import { exportFrontegg, fronteggApiRoot, mapFronteggUser, mapSsoConfig, metadataOf } from './frontegg';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';

/**
 * Frontegg management API responses as its OpenAPI documents them: `POST
 * /auth/vendor` (`{ token, expiresIn }`), users v3 (`_metadata` paging,
 * metadata as JSON strings, per-account `tenants[]` with roles), tenants v2,
 * roles v2, permissions v1, groups v2, invites, SSO configurations and API
 * tokens (account-scoped by the `frontegg-tenant-id` header). Unrouted calls
 * answer 404.
 */
const API = 'https://api.frontegg.com';
const PAGE = '_limit=200&_offset=0';
const byTenant = (map: Record<string, unknown>) => ({ headers }: { headers: Headers }) => map[headers.get('frontegg-tenant-id') ?? ''] ?? { status: 404, body: {} };

const JANE = {
  id: 'u-jane',
  email: 'Jane@Acme.example',
  name: 'Jane Doe',
  verified: true,
  phoneNumber: '+14155550100',
  profilePictureUrl: 'https://img.example/j.png',
  mfaEnrolled: true,
  provider: 'google',
  metadata: '{"plan":"pro"}',
  vendorMetadata: '{"internal":1}',
  externalId: 'ext-1',
  isLocked: false,
  createdAt: '2024-01-02T03:04:05.000Z',
  lastLogin: '2024-02-03T00:00:00.000Z',
  tenants: [
    { tenantId: 't-acme', roles: [{ id: 'r-admin', key: 'Admin', name: 'Admin' }] },
    { tenantId: 't-gone', roles: [] },
  ],
};
const SAM = { id: 'u-sam', email: 'sam@beta.example', verified: false, provider: 'local', isLocked: true, tenants: [{ tenantId: 't-beta', isDisabled: true, roles: [] }] };

function fronteggApi(over: Record<string, unknown> = {}) {
  return fakeVendor(API, {
    'POST /auth/vendor': { token: 'mgmt-token', expiresIn: 3600 },
    [`GET /tenants/resources/tenants/v2?${PAGE}`]: {
      items: [
        { tenantId: 't-acme', name: 'Acme', metadata: '{"tier":"gold"}', createdAt: '2024-01-01T00:00:00.000Z' },
        { tenantId: 't-beta', name: 'Beta', parentTenantId: 't-acme' },
      ],
      _metadata: { totalItems: 2, totalPages: 1 },
    },
    'GET /identity/resources/permissions/v1': [
      { id: 'p1', key: 'billing.read' },
      { id: 'p2', key: 'billing.write' },
    ],
    [`GET /identity/resources/roles/v2?${PAGE}`]: {
      items: [
        { id: 'r-admin', key: 'Admin', name: 'Admin', description: 'Everything', permissions: ['p1', 'p2'] },
        { id: 'r-viewer', key: 'Viewer', name: 'Viewer', permissions: ['p1'] },
      ],
      _metadata: { totalPages: 1 },
    },
    'GET /identity/resources/groups/v2': byTenant({ 't-acme': { items: [{ id: 'g1', name: 'Finance', roles: [{ id: 'r-viewer', key: 'Viewer' }], users: [{ id: 'u-jane' }] }] } }),
    'GET /team/resources/sso/v1/configurations': byTenant({
      't-acme': [
        {
          id: 'sso1',
          type: 'saml',
          enabled: true,
          ssoEndpoint: 'https://idp.example/sso',
          publicCertificate: 'CERT',
          spEntityId: 'sp-entity',
          acsUrl: 'https://acs.example/callback',
          domains: [{ domain: 'acme.example', validated: true }, { domain: 'pending.example', validated: false }],
          configMetadata: { entityId: 'https://idp.example/meta' },
        },
      ],
    }),
    'GET /identity/resources/usernames/v1': [{ userId: 'u-jane', username: 'jane' }],
    [`GET /identity/resources/users/v3?_sortBy=id&_order=ASC&${PAGE}`]: {
      items: [JANE, SAM, { id: 'u-inv', email: 'support@frontegg.com', invisible: true }, { id: 'u-none' }],
      _metadata: { totalItems: 4, totalPages: 1 },
    },
    'GET /identity/resources/tenants/invites/v1/all': [
      { id: 'inv1', tenantId: 't-acme', userId: 'u-jane', expires: '2030-01-01T00:00:00.000Z', roleIds: ['r-viewer'] },
      { id: 'inv2', tenantId: 't-nope', userId: 'u-jane' },
    ],
    'GET /identity/resources/tenants/api-tokens/v1': byTenant({ 't-acme': [{ clientId: 'c1' }, { clientId: 'c2' }] }),
    ...over,
  });
}

const run = (api: ReturnType<typeof fronteggApi>) => exportFrontegg({ clientId: 'cid', apiKey: 'secret', fetchImpl: api.fetchImpl, sleep: noSleep });

describe('exportFrontegg', () => {
  it('authenticates with the environment credentials and sends the management token and account header', async () => {
    const api = fronteggApi();
    await run(api);
    const login = api.calls[0]!;
    expect(login.method).toBe('POST');
    expect(login.url).toBe(`${API}/auth/vendor`);
    expect(login.body).toEqual({ clientId: 'cid', secret: 'secret' });
    const users = api.calls.find((c) => c.url.includes('/users/v3'))!;
    expect(users.headers.get('authorization')).toBe('Bearer mgmt-token');
    const groups = api.calls.filter((c) => c.url.includes('/groups/v2'));
    expect(groups.map((c) => c.headers.get('frontegg-tenant-id'))).toEqual(['t-acme', 't-beta']);
    // One login serves every call.
    expect(api.calls.filter((c) => c.url.endsWith('/auth/vendor'))).toHaveLength(1);
  });

  it('exports accounts as organizations with SSO domains, metadata and the parent link', async () => {
    const set = await run(fronteggApi());
    const [acme, beta] = set.list('organization');
    expect(acme).toMatchObject({ id: 't-acme', name: 'Acme', domains: ['acme.example'], public_metadata: { tier: 'gold' }, created_at: '2024-01-01T00:00:00.000Z' });
    expect(beta).toMatchObject({ id: 't-beta', name: 'Beta', public_metadata: { frontegg_parent_tenant_id: 't-acme' } });
    expect(set.warnings.some((w) => /sub-accounts/.test(w))).toBe(true);
  });

  it('exports roles with permission keys', async () => {
    const set = await run(fronteggApi());
    expect(set.list('role')).toEqual([
      { key: 'admin', name: 'Admin', description: 'Everything', scope: 'organization', permissions: ['billing.read', 'billing.write'] },
      { key: 'viewer', name: 'Viewer', scope: 'organization', permissions: ['billing.read'] },
    ]);
  });

  it('exports users with verified flags, usernames, metadata, groups and timestamps', async () => {
    const set = await run(fronteggApi());
    const users = set.list('user');
    expect(users.map((u) => u.id)).toEqual(['u-jane', 'u-sam']);
    expect(users[0]).toMatchObject({
      id: 'u-jane',
      emails: [{ email: 'jane@acme.example', verified: true, primary: true }],
      phones: [{ phone: '+14155550100', verified: false, primary: false }],
      username: 'jane',
      name: 'Jane Doe',
      image_url: 'https://img.example/j.png',
      public_metadata: { plan: 'pro' },
      private_metadata: { internal: 1, frontegg_external_id: 'ext-1', frontegg_groups: [{ tenant_id: 't-acme', name: 'Finance' }] },
      created_at: '2024-01-02T03:04:05.000Z',
      last_sign_in_at: '2024-02-03T00:00:00.000Z',
    });
    expect(users[1]).toMatchObject({ emails: [{ email: 'sam@beta.example', verified: false, primary: true }], banned: true, locked: true });
    expect(set.omitted.user).toMatchObject({ count: 2 });
  });

  it('seats members with their direct roles before group roles and drops memberships of unknown accounts', async () => {
    const set = await run(fronteggApi());
    expect(set.list('membership')).toEqual([
      { organization_id: 't-acme', user_id: 'u-jane', role: 'admin' },
      { organization_id: 't-beta', user_id: 'u-sam', role: 'member' },
    ]);
    expect(set.omitted.membership).toMatchObject({ count: 1 });
    expect(set.warnings.some((w) => /several Frontegg roles/.test(w))).toBe(true);
  });

  it('exports SAML connections with only validated domains', async () => {
    const set = await run(fronteggApi());
    expect(set.list('sso_connection')).toEqual([
      {
        id: 'sso1',
        name: 't-acme SAML',
        organization_id: 't-acme',
        domains: ['acme.example'],
        protocol: 'saml',
        saml: { idp_entity_id: 'https://idp.example/meta', idp_sso_url: 'https://idp.example/sso', idp_certificate: 'CERT', sp_entity_id: 'sp-entity', sp_acs_url: 'https://acs.example/callback' },
      },
    ]);
  });

  it('exports invitations through the invited user email', async () => {
    const set = await run(fronteggApi());
    expect(set.list('invitation')).toEqual([{ id: 'inv1', organization_id: 't-acme', email: 'jane@acme.example', role: 'viewer', status: 'pending', expires_at: '2030-01-01T00:00:00.000Z' }]);
    expect(set.omitted.invitation).toMatchObject({ count: 1 });
  });

  it('reports what Frontegg cannot export', async () => {
    const set = await run(fronteggApi());
    expect(set.omitted.api_key).toMatchObject({ count: 2 });
    expect(set.omitted.mfa_factor).toMatchObject({ count: 1 });
    expect(set.omitted.identity).toMatchObject({ count: 1 });
    expect(set.warnings.some((w) => /No password hashes/.test(w) && /lazy-migration/.test(w))).toBe(true);
    expect(set.manifest).toEqual({ origin: API, settings: { region: 'eu' } });
  });

  it('works against a region other than eu', async () => {
    const api = fakeVendor('https://api.us.frontegg.com', { 'POST /auth/vendor': { token: 't', expiresIn: 60 } });
    const set = await exportFrontegg({ clientId: 'cid', apiKey: 'k', region: 'US', fetchImpl: api.fetchImpl, sleep: noSleep });
    expect(api.calls[0]!.url).toBe('https://api.us.frontegg.com/auth/vendor');
    expect(set.manifest).toEqual({ origin: 'https://api.us.frontegg.com', settings: { region: 'us' } });
    expect(set.count('user')).toBe(0);
  });

  it('names the failing call when the credentials are refused', async () => {
    const api = fakeVendor(API, { 'POST /auth/vendor': { status: 401, body: { message: 'Invalid credentials' } } });
    await expect(run(api)).rejects.toThrow(/Frontegg refused the environment credentials \(401\)/);
    await expect(exportFrontegg({ clientId: '', apiKey: '', fetchImpl: api.fetchImpl })).rejects.toThrow(/client id and API key/);
  });
});

describe('mapFronteggUser', () => {
  it('keeps a phone-only user and refuses one without any identifier', () => {
    expect(mapFronteggUser({ id: 'u1', phoneNumber: '+14155550100' })).toMatchObject({ id: 'u1', phones: [{ phone: '+14155550100', verified: false, primary: true }] });
    expect(mapFronteggUser({ id: 'u2' })).toBeNull();
    expect(mapFronteggUser({ id: 'u3', email: 'a@b.example', invisible: true })).toBeNull();
  });
});

describe('mapSsoConfig', () => {
  it('maps an OIDC configuration without a secret', () => {
    expect(mapSsoConfig({ type: 'oidc', oidcClientId: 'abc', configMetadata: { issuer: 'https://idp.example' } }, 't1')).toMatchObject({
      id: 't1:oidc',
      protocol: 'oidc',
      organization_id: 't1',
      oidc: { issuer: 'https://idp.example', client_id: 'abc' },
    });
  });

  it('ignores a configuration that carries nothing', () => {
    expect(mapSsoConfig({ type: 'saml', enabled: false }, 't1')).toBeNull();
  });
});

describe('helpers', () => {
  it('reads metadata stored as a JSON string and ignores garbage', () => {
    expect(metadataOf('{"a":1}')).toEqual({ a: 1 });
    expect(metadataOf('not json')).toBeUndefined();
    expect(metadataOf('{}')).toBeUndefined();
  });

  it('resolves regions and rejects unknown ones', () => {
    expect(fronteggApiRoot(undefined)).toBe('https://api.frontegg.com');
    expect(fronteggApiRoot('au')).toBe('https://api.au.frontegg.com');
    expect(fronteggApiRoot('xx', 'https://private.example/')).toBe('https://private.example');
    expect(() => fronteggApiRoot('xx')).toThrow(/Unknown Frontegg region/);
  });
});
