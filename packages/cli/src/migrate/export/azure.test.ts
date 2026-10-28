import { describe, expect, it } from 'vitest';
import { exportAzure, isDirectoryUser, mapAzureUser, providerOfIssuer } from './azure';
import { fakeVendor, noSleep, type Route } from './fake-vendor.test-helper';

/**
 * Microsoft Graph v1.0 responses as Graph returns them (`value` + an absolute
 * `@odata.nextLink`, `identities[]` with signInType / issuer /
 * issuerAssignedId, `extension_<appId>_<name>` properties) and the v2.0
 * client-credentials token endpoint.
 */
const GRAPH = 'https://graph.microsoft.com';
const TOKEN_URL = 'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token';
const EXT = 'extension_0123456789abcdef0123456789abcdef_loyaltyTier';

const ALICE = {
  id: 'a1a1a1a1-0000-0000-0000-000000000001',
  displayName: 'Alice Liddell',
  givenName: 'Alice',
  surname: 'Liddell',
  otherMails: ['alice@example.com', 'alice.alt@example.com'],
  identities: [
    { signInType: 'emailAddress', issuer: 'contoso.onmicrosoft.com', issuerAssignedId: 'Alice@Example.com' },
    { signInType: 'userPrincipalName', issuer: 'contoso.onmicrosoft.com', issuerAssignedId: 'a1@contoso.onmicrosoft.com' },
  ],
  accountEnabled: true,
  createdDateTime: '2021-03-04T05:06:07Z',
  userPrincipalName: 'a1@contoso.onmicrosoft.com',
  creationType: 'LocalAccount',
  passwordPolicies: 'DisablePasswordExpiration',
  [EXT]: 'gold',
};
const BOB = {
  id: 'b2b2b2b2-0000-0000-0000-000000000002',
  mail: 'Bob@Gmail.example',
  identities: [
    { signInType: 'federated', issuer: 'google.com', issuerAssignedId: '1234567890' },
    { signInType: 'federated', issuer: 'facebook.com', issuerAssignedId: null },
    { signInType: 'userPrincipalName', issuer: 'contoso.onmicrosoft.com', issuerAssignedId: 'b2@contoso.onmicrosoft.com' },
  ],
  accountEnabled: false,
  createdDateTime: '2022-01-01T00:00:00Z',
};
const CAROL = {
  id: 'c3c3c3c3-0000-0000-0000-000000000003',
  identities: [
    { signInType: 'phoneNumber', issuer: 'contoso.onmicrosoft.com', issuerAssignedId: '+14155550199' },
    { signInType: 'userName', issuer: 'contoso.onmicrosoft.com', issuerAssignedId: 'carol' },
  ],
  accountEnabled: true,
};
const ADMIN = {
  id: 'd4d4d4d4-0000-0000-0000-000000000004',
  displayName: 'Tenant Admin',
  identities: [{ signInType: 'userPrincipalName', issuer: 'contoso.onmicrosoft.com', issuerAssignedId: 'admin@contoso.onmicrosoft.com' }],
  userType: 'Member',
};

function graphApi(over: Record<string, Route> = {}) {
  const empty = { value: [] };
  return fakeVendor(GRAPH, {
    [`POST ${TOKEN_URL}`]: { access_token: 'graph-token', token_type: 'Bearer', expires_in: 3599 },
    'GET /v1.0/organization': { value: [{ id: 'tid-0000', verifiedDomains: [{ name: 'contoso.com', isInitial: false }, { name: 'contoso.onmicrosoft.com', isInitial: true }] }] },
    'POST /v1.0/directoryObjects/getAvailableExtensionProperties': {
      value: [
        { name: EXT, targetObjects: ['User'] },
        { name: 'extension_0123456789abcdef0123456789abcdef_groupThing', targetObjects: ['Group'] },
      ],
    },
    'GET /v1.0/groups': { value: [{ id: 'g1', displayName: 'VIP Customers', description: 'Top tier' }] },
    'GET /v1.0/groups/g1/members': { value: [{ id: ALICE.id }, { id: ADMIN.id }] },
    'GET /v1.0/users': ({ url }: { url: URL }) =>
      url.searchParams.get('$skiptoken') === 'p2'
        ? { value: [CAROL, ADMIN] }
        : { value: [ALICE, BOB], '@odata.nextLink': `${GRAPH}/v1.0/users?$select=id&$skiptoken=p2` },
    [`GET /v1.0/users/${ALICE.id}/authentication/phoneMethods`]: { value: [{ id: 'm1', phoneNumber: '+1 415 555 0101', phoneType: 'mobile' }, { id: 'm2', phoneNumber: '+1 415 555 0102', phoneType: 'office' }] },
    [`GET /v1.0/users/${ALICE.id}/authentication/emailMethods`]: empty,
    [`GET /v1.0/users/${ALICE.id}/authentication/softwareOathMethods`]: { value: [{ id: 'o1' }] },
    [`GET /v1.0/users/${ALICE.id}/authentication/fido2Methods`]: empty,
    [`GET /v1.0/users/${BOB.id}/authentication/phoneMethods`]: empty,
    [`GET /v1.0/users/${BOB.id}/authentication/emailMethods`]: { value: [{ id: 'e1', emailAddress: 'bob@gmail.example' }] },
    [`GET /v1.0/users/${BOB.id}/authentication/softwareOathMethods`]: empty,
    [`GET /v1.0/users/${BOB.id}/authentication/fido2Methods`]: { value: [{ id: 'f1' }] },
    [`GET /v1.0/users/${CAROL.id}/authentication/phoneMethods`]: empty,
    [`GET /v1.0/users/${CAROL.id}/authentication/emailMethods`]: empty,
    [`GET /v1.0/users/${CAROL.id}/authentication/softwareOathMethods`]: empty,
    [`GET /v1.0/users/${CAROL.id}/authentication/fido2Methods`]: empty,
    ...over,
  });
}

const base = { tenant: 'contoso.onmicrosoft.com', clientId: 'app-id', clientSecret: 'app-secret', sleep: noSleep };

describe('exportAzure', () => {
  it('maps B2C consumers by object id with their sign-in identities, links, custom attributes, groups and factors', async () => {
    const api = graphApi();
    const set = await exportAzure({ kind: 'b2c', ...base, authMethods: true, fetchImpl: api.fetchImpl });

    const token = api.calls[0]!;
    expect(token.url).toBe(TOKEN_URL);
    expect(String(token.body)).toContain('grant_type=client_credentials');
    expect(String(token.body)).toContain('scope=https%3A%2F%2Fgraph.microsoft.com%2F.default');
    expect(api.calls.filter((c) => c.url.startsWith(GRAPH)).every((c) => c.headers.get('authorization') === 'Bearer graph-token')).toBe(true);
    expect(api.calls.filter((c) => c.url.startsWith(TOKEN_URL))).toHaveLength(1);
    const usersCall = api.calls.find((c) => c.url.includes('/v1.0/users?'))!;
    expect(decodeURIComponent(usersCall.url)).toContain(`identities,accountEnabled`);
    expect(decodeURIComponent(usersCall.url)).toContain(EXT);
    expect(decodeURIComponent(usersCall.url)).not.toContain('groupThing');

    expect(set.list('user').map((u) => u.id)).toEqual([ALICE.id, BOB.id, CAROL.id]);
    const [alice, bob, carol] = set.list('user');
    expect(alice).toEqual({
      id: ALICE.id,
      emails: [
        { email: 'alice@example.com', verified: true, primary: true },
        { email: 'alice.alt@example.com', verified: false, primary: false },
      ],
      first_name: 'Alice',
      last_name: 'Liddell',
      name: 'Alice Liddell',
      roles: ['vip_customers'],
      public_metadata: { loyaltyTier: 'gold' },
      private_metadata: { azure_user_principal_name: 'a1@contoso.onmicrosoft.com', azure_creation_type: 'LocalAccount', azure_password_policies: 'DisablePasswordExpiration' },
      created_at: '2021-03-04T05:06:07Z',
    });
    expect(bob).toMatchObject({ emails: [{ email: 'bob@gmail.example', verified: false, primary: true }], banned: true });
    expect(carol).toMatchObject({ username: 'carol', phones: [{ phone: '+14155550199', verified: true, primary: true }] });
    expect(set.omitted.user).toEqual({ count: 1, reason: 'directory (admin / work) account that signs in with a userPrincipalName only' });

    expect(set.list('identity')).toEqual([{ user_id: BOB.id, provider: 'google', provider_user_id: '1234567890', kind: 'oauth', profile: { issuer: 'google.com' } }]);
    expect(set.omitted.identity?.count).toBe(1);
    expect(set.list('role')).toEqual([{ key: 'vip_customers', name: 'VIP Customers', description: 'Top tier', scope: 'app' }]);
    expect(set.list('mfa_factor')).toEqual([
      { user_id: ALICE.id, type: 'phone', phone: '+14155550101', verified: true },
      { user_id: BOB.id, type: 'email', verified: true },
    ]);
    expect(set.omitted.mfa_factor?.count).toBe(1);
    expect(set.omitted.passkey?.count).toBe(1);

    expect(set.manifest.origin).toBe('Azure AD B2C tenant contoso.onmicrosoft.com');
    expect(set.manifest.settings).toEqual({ kind: 'b2c', tenant_id: 'tid-0000', tenant_name: 'contoso', extension_attributes: [EXT] });
    expect(set.manifest.providers).toEqual(['google']);
    expect(set.warnings.some((w) => w.includes('ROPC user flow'))).toBe(true);
    expect(set.warnings.some((w) => w.includes('sub claim of default B2C user flows'))).toBe(true);
  });

  it('exports External ID customers, stops asking for authentication methods once denied, and survives a tenant read it may not do', async () => {
    const denied = { status: 403, body: { error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges' } } };
    const api = graphApi({
      'POST https://login.microsoftonline.com/tid-0000/oauth2/v2.0/token': { access_token: 'graph-token', token_type: 'Bearer', expires_in: 3599 },
      'GET /v1.0/organization': denied,
      [`GET /v1.0/users/${ALICE.id}/authentication/phoneMethods`]: denied,
    });
    const set = await exportAzure({ kind: 'entra', ...base, tenant: 'tid-0000', authMethods: true, groups: 'skip', fetchImpl: api.fetchImpl });
    expect(set.count('user')).toBe(3);
    expect(set.count('mfa_factor')).toBe(0);
    expect(api.calls.filter((c) => c.url.includes('/authentication/'))).toHaveLength(1);
    expect(set.warnings).toContain('Authentication methods were not exported: grant the app registration UserAuthenticationMethod.Read.All.');
    expect(set.warnings.some((w) => w.includes('native authentication'))).toBe(true);
    expect(set.manifest.origin).toBe('Entra External ID tenant tid-0000');
    expect(api.calls.some((c) => c.url.includes('/groups'))).toBe(false);
  });

  it('includes directory accounts when asked, and uses a Graph token as given', async () => {
    const api = graphApi();
    const set = await exportAzure({ kind: 'b2c', tenant: 'contoso.onmicrosoft.com', accessToken: 'given', includeDirectoryUsers: true, groups: 'skip', fetchImpl: api.fetchImpl, sleep: noSleep });
    expect(set.list('user').map((u) => u.id)).toContain(ADMIN.id);
    expect(api.calls.some((c) => c.url === TOKEN_URL)).toBe(false);
    expect(api.calls.every((c) => c.headers.get('authorization') === 'Bearer given')).toBe(true);
  });

  it('reports a rejected client secret in Microsoft\'s words, without the secret', async () => {
    const api = graphApi({
      [`POST ${TOKEN_URL}`]: { status: 401, body: { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.\r\nTrace ID: x' } },
    });
    const run = exportAzure({ kind: 'b2c', ...base, fetchImpl: api.fetchImpl });
    await expect(run).rejects.toThrow('Microsoft Entra API 401 on /oauth2/v2.0/token: AADSTS7000215: Invalid client secret provided.');
    await expect(exportAzure({ kind: 'b2c', ...base, fetchImpl: api.fetchImpl })).rejects.not.toThrow('app-secret');
  });
});

describe('Azure mapping helpers', () => {
  it('maps federated issuers to providers', () => {
    expect(providerOfIssuer('google.com')).toEqual({ provider: 'google', kind: 'oauth' });
    expect(providerOfIssuer('facebook.com')).toEqual({ provider: 'facebook', kind: 'oauth' });
    expect(providerOfIssuer('https://appleid.apple.com')).toEqual({ provider: 'apple', kind: 'oauth' });
    expect(providerOfIssuer('MicrosoftAccount')).toEqual({ provider: 'microsoft', kind: 'oauth' });
    expect(providerOfIssuer('https://login.partner.example/v2.0')).toEqual({ provider: 'https://login.partner.example/v2.0', kind: 'oidc' });
  });

  it('tells directory accounts from consumers', () => {
    expect(isDirectoryUser(ADMIN)).toBe(true);
    expect(isDirectoryUser(ALICE)).toBe(false);
    expect(isDirectoryUser({ id: 'x', identities: [{ signInType: 'userPrincipalName' }], creationType: 'LocalAccount' })).toBe(false);
  });

  it('keeps a federated-only user without an email through a generated username, and drops a user with nothing', () => {
    const fed = mapAzureUser({ id: 'e5e5e5e5-0000-0000-0000-000000000005', identities: [{ signInType: 'federated', issuer: 'github.com', issuerAssignedId: '42' }] });
    expect(fed?.user.username).toBe('user_e5e5e5e5000000000000');
    expect(fed?.identities[0]).toMatchObject({ provider: 'github', provider_user_id: '42' });
    expect(mapAzureUser({ id: 'f6', identities: [] })).toBeNull();
  });
});
