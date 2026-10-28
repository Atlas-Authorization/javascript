import { describe, expect, it } from 'vitest';
import { exportOkta, mapOktaUser } from './okta';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';

/**
 * Okta Management API responses as Okta returns them: bare arrays, paged by
 * `Link: <…>; rel="next"`, user objects with `profile` + `credentials`.
 */
const ORIGIN = 'https://acme.okta.com';

const JANE = {
  id: '00u1janeABCD',
  status: 'ACTIVE',
  created: '2020-01-01T00:00:00.000Z',
  activated: '2020-01-01T00:01:00.000Z',
  lastLogin: '2024-05-01T00:00:00.000Z',
  profile: { login: 'jane@acme.example', email: 'Jane@Acme.example', secondEmail: 'jane@home.example', firstName: 'Jane', lastName: 'Doe', mobilePhone: '+1 (415) 555-0101', costCenter: 'R&D', employeeNumber: '42', nickName: null },
  credentials: { password: {}, provider: { type: 'OKTA', name: 'OKTA' } },
};
const SAM = {
  id: '00u2samEFGH',
  status: 'LOCKED_OUT',
  profile: { login: 'sam', email: 'sam@acme.example', firstName: 'Sam', lastName: 'Ray' },
  credentials: { emails: [{ value: 'sam@acme.example', status: 'VERIFIED', type: 'PRIMARY' }], provider: { type: 'OKTA' } },
};
const STAGED = { id: '00u3stg', status: 'STAGED', profile: { login: 'new@acme.example', email: 'new@acme.example' } };
const SUSPENDED = { id: '00u4sus', status: 'SUSPENDED', profile: { login: 'gone@acme.example', email: 'gone@acme.example', displayName: 'Gone Person' } };

function oktaApi(over: Record<string, unknown> = {}) {
  return fakeVendor(ORIGIN, {
    'GET /api/v1/groups': [
      { id: '00g0every', type: 'BUILT_IN', profile: { name: 'Everyone' } },
      { id: '00g1eng', type: 'OKTA_GROUP', created: '2020-01-01T00:00:00.000Z', profile: { name: 'Engineering Team', description: 'Builders' } },
    ],
    'GET /api/v1/users?limit=200': { status: 200, body: [JANE, SAM], headers: { link: `<${ORIGIN}/api/v1/users?limit=200>; rel="self", <${ORIGIN}/api/v1/users?after=00u2samEFGH&limit=200>; rel="next"` } },
    'GET /api/v1/users?after=00u2samEFGH&limit=200': [STAGED, SUSPENDED],
    'GET /api/v1/groups/00g1eng/users': [{ id: '00u1janeABCD' }, { id: '00u9unknown' }],
    'GET /api/v1/idps': [
      { id: '0oa1goog', type: 'GOOGLE', name: 'Google', status: 'ACTIVE' },
      {
        id: '0oa2saml',
        type: 'SAML2',
        name: 'Partner SAML',
        status: 'ACTIVE',
        protocol: {
          type: 'SAML2',
          endpoints: { sso: { url: 'https://idp.partner.example/sso', binding: 'HTTP-POST' }, acs: { url: `${ORIGIN}/sso/saml2/0oa2saml` } },
          credentials: { trust: { issuer: 'https://idp.partner.example', audience: 'https://www.okta.com/saml2/service-provider/sp1', kid: 'kid-1' } },
        },
      },
      { id: '0oa3oidc', type: 'OIDC', name: 'Partner OIDC', status: 'ACTIVE', protocol: { type: 'OIDC', issuer: { url: 'https://login.partner.example' }, scopes: ['openid', 'email'], credentials: { client: { client_id: 'okta-client' } } } },
      { id: '0oa4x', type: 'X509', name: 'Smart card', status: 'ACTIVE' },
    ],
    'GET /api/v1/idps/0oa1goog/users': [{ id: '00u1janeABCD', externalId: '1093849', profile: { email: 'jane@gmail.com' } }],
    'GET /api/v1/idps/0oa2saml/users': [{ id: '00u2samEFGH', externalId: 'sam@partner.example' }],
    'GET /api/v1/idps/0oa3oidc/users': [],
    'GET /api/v1/idps/credentials/keys/kid-1': { kid: 'kid-1', kty: 'RSA', x5c: ['MIIBkTCB+wIJAKHBfpegPjMCMA0GCSqGSIb3DQEBCwUA'] },
    'GET /oauth2/default/v1/keys': { keys: [{ kid: 'ak1', kty: 'RSA', alg: 'RS256', n: 'x', e: 'AQAB' }] },
    ...over,
  });
}

describe('exportOkta', () => {
  it('maps users, groups as roles, social links, SAML/OIDC IdPs and keys, following Link paging', async () => {
    const api = oktaApi();
    const set = await exportOkta({ domain: 'acme.okta.com', apiToken: '00token', fetchImpl: api.fetchImpl, sleep: noSleep });
    expect(api.calls.every((c) => c.headers.get('authorization') === 'SSWS 00token')).toBe(true);

    expect(set.list('user').map((u) => u.id)).toEqual(['00u1janeABCD', '00u2samEFGH', '00u3stg', '00u4sus']);
    const [jane, sam, staged, suspended] = set.list('user');
    expect(jane).toEqual({
      id: '00u1janeABCD',
      emails: [
        { email: 'jane@acme.example', verified: true, primary: true },
        { email: 'jane@home.example', verified: false, primary: false },
      ],
      phones: [{ phone: '+14155550101', verified: false, primary: false }],
      first_name: 'Jane',
      last_name: 'Doe',
      roles: ['engineering_team'],
      private_metadata: { costCenter: 'R&D', employeeNumber: '42' },
      created_at: '2020-01-01T00:00:00.000Z',
      last_sign_in_at: '2024-05-01T00:00:00.000Z',
    });
    expect(sam).toMatchObject({ username: 'sam', locked: true, private_metadata: { okta_status: 'LOCKED_OUT' } });
    expect(sam!.emails).toEqual([{ email: 'sam@acme.example', verified: true, primary: true }]);
    // A STAGED user never activated: the address is not proven.
    expect(staged!.emails).toEqual([{ email: 'new@acme.example', verified: false, primary: true }]);
    expect(suspended).toMatchObject({ banned: true, ban_reason: 'Suspended in Okta', name: 'Gone Person' });

    expect(set.list('role')).toEqual([{ key: 'engineering_team', name: 'Engineering Team', description: 'Builders', scope: 'app' }]);
    expect(set.list('identity')).toEqual([
      { user_id: '00u1janeABCD', provider: 'google', provider_user_id: '1093849', kind: 'oauth', profile: { email: 'jane@gmail.com' } },
      { user_id: '00u2samEFGH', provider: 'Partner SAML', provider_user_id: 'sam@partner.example', kind: 'saml', sso_connection_id: '0oa2saml' },
    ]);
    expect(set.list('sso_connection')).toEqual([
      {
        id: '0oa2saml',
        name: 'Partner SAML',
        protocol: 'saml',
        enabled: true,
        saml: {
          idp_entity_id: 'https://idp.partner.example',
          idp_sso_url: 'https://idp.partner.example/sso',
          idp_certificate: '-----BEGIN CERTIFICATE-----\nMIIBkTCB+wIJAKHBfpegPjMCMA0GCSqGSIb3DQEBCwUA\n-----END CERTIFICATE-----',
          sp_entity_id: 'https://www.okta.com/saml2/service-provider/sp1',
          sp_acs_url: `${ORIGIN}/sso/saml2/0oa2saml`,
        },
      },
      { id: '0oa3oidc', name: 'Partner OIDC', protocol: 'oidc', enabled: true, oidc: { issuer: 'https://login.partner.example', client_id: 'okta-client', scopes: ['openid', 'email'] } },
    ]);
    expect(set.warnings.some((w) => w.includes('Smart card (X509)'))).toBe(true);
    expect(set.warnings.some((w) => w.includes('never exports password hashes') && w.includes('okta lazy-migration preset'))).toBe(true);
    expect(set.list('jwks').map((k) => k.kid)).toEqual(['ak1']);
    expect(set.list('user').every((u) => u.password === undefined)).toBe(true);
  });

  it('can carry groups as organizations and read SMS / email factors', async () => {
    const api = oktaApi({
      'GET /api/v1/users/00u1janeABCD/factors': [
        { id: 'sms1', factorType: 'sms', provider: 'OKTA', status: 'ACTIVE', profile: { phoneNumber: '+1 415-555-0199' }, created: '2021-01-01T00:00:00.000Z' },
        { id: 'tot1', factorType: 'token:software:totp', provider: 'GOOGLE', status: 'ACTIVE', profile: { credentialId: 'jane' } },
        { id: 'em1', factorType: 'email', status: 'PENDING_ACTIVATION', profile: { email: 'jane@acme.example' } },
      ],
    });
    const set = await exportOkta({ domain: 'acme.okta.com', accessToken: 'oauth-at', groupsAs: 'organizations', factors: true, fetchImpl: api.fetchImpl, sleep: noSleep });
    expect(api.calls[0]!.headers.get('authorization')).toBe('Bearer oauth-at');
    expect(set.list('organization')).toEqual([{ id: '00g1eng', name: 'Engineering Team', slug: 'engineering-team', public_metadata: { description: 'Builders' }, created_at: '2020-01-01T00:00:00.000Z' }]);
    expect(set.list('membership')).toEqual([{ organization_id: '00g1eng', user_id: '00u1janeABCD', role: 'member' }]);
    expect(set.list('user')[0]!.roles).toBeUndefined();
    expect(set.list('mfa_factor')).toEqual([{ user_id: '00u1janeABCD', type: 'phone', phone: '+14155550199', verified: true, created_at: '2021-01-01T00:00:00.000Z' }]);
    expect(set.omitted.mfa_factor?.reason).toMatch(/token:software:totp/);
  });

  it('skips DEPROVISIONED users and needs a token', async () => {
    expect(mapOktaUser({ id: 'x', status: 'DEPROVISIONED', profile: { email: 'a@b.example' } })).toBeNull();
    await expect(exportOkta({ domain: 'acme.okta.com' })).rejects.toThrow(/API token/);
  });
});
