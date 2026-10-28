import { describe, expect, it } from 'vitest';
import {
  CognitoApi,
  cognitoIdentities,
  exportCognito,
  mapCognitoUser,
  parseListUsersOutput,
  regionOfPool,
  sigV4Key,
  signAwsRequest,
} from './cognito';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';

/**
 * Cognito user-pool API responses as AWS returns them (UserType with
 * Attributes[{Name, Value}], epoch-second dates, the `identities` attribute
 * as a JSON string), and AWS's own SigV4 test vectors.
 */

describe('AWS Signature Version 4', () => {
  // AWS General Reference, "Examples of how to derive a signing key for Signature Version 4".
  it('derives the documented signing key', () => {
    expect(sigV4Key('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20120215', 'us-east-1', 'iam').toString('hex')).toBe(
      'f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d',
    );
  });

  // The aws-sig-v4-test-suite "get-vanilla" case.
  it('reproduces the get-vanilla test-suite signature', () => {
    const headers = signAwsRequest({
      method: 'GET',
      url: 'https://example.amazonaws.com/',
      headers: {},
      body: '',
      region: 'us-east-1',
      service: 'service',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
      now: new Date('2015-08-30T12:36:00Z'),
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
    expect(headers['x-amz-date']).toBe('20150830T123600Z');
  });

  it('signs the session token of temporary credentials', () => {
    const headers = signAwsRequest({
      method: 'POST',
      url: 'https://cognito-idp.eu-west-1.amazonaws.com/',
      headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': 'AWSCognitoIdentityProviderService.ListUsers' },
      body: '{}',
      region: 'eu-west-1',
      service: 'cognito-idp',
      credentials: { accessKeyId: 'ASIAEXAMPLE', secretAccessKey: 'secret', sessionToken: 'tok' },
      now: new Date('2026-01-02T03:04:05Z'),
    });
    expect(headers['x-amz-security-token']).toBe('tok');
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=ASIAEXAMPLE\/20260102\/eu-west-1\/cognito-idp\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target, Signature=[0-9a-f]{64}$/);
  });
});

describe('regionOfPool', () => {
  it('reads the region prefix of a pool id', () => {
    expect(regionOfPool('us-east-1_AbC123xyz')).toBe('us-east-1');
    expect(regionOfPool('ap-southeast-2_x9')).toBe('ap-southeast-2');
    expect(regionOfPool('us-gov-west-1_Abc')).toBe('us-gov-west-1');
    expect(regionOfPool('not-a-pool')).toBeUndefined();
  });
});

const POOL = 'us-east-1_Pool';
const ORIGIN = 'https://cognito-idp.us-east-1.amazonaws.com';
const JANE_SUB = '11111111-2222-3333-4444-555555555555';
const FED_SUB = '66666666-7777-8888-9999-000000000000';
const BOB_SUB = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const attrs = (o: Record<string, string>) => Object.entries(o).map(([Name, Value]) => ({ Name, Value }));

const JANE = {
  Username: JANE_SUB,
  Attributes: attrs({
    sub: JANE_SUB,
    email: 'Jane@Example.com',
    email_verified: 'true',
    phone_number: '+14155550101',
    phone_number_verified: 'true',
    given_name: 'Jane',
    family_name: 'Doe',
    picture: 'https://cdn.example.com/jane.png',
    locale: 'en-US',
    'custom:plan': 'pro',
    'custom:tenant_id': 't_42',
  }),
  UserCreateDate: 1700000000.25,
  UserLastModifiedDate: 1700000100,
  Enabled: true,
  UserStatus: 'CONFIRMED',
  MFAOptions: [{ DeliveryMedium: 'SMS', AttributeName: 'phone_number' }],
};
const FED = {
  Username: 'Google_109876543210',
  Attributes: attrs({
    sub: FED_SUB,
    email: 'fed@gmail.example',
    email_verified: 'false',
    identities: '[{"userId":"109876543210","providerName":"Google","providerType":"Google","issuer":null,"primary":true,"dateCreated":1701125599632}]',
  }),
  UserCreateDate: 1701125599.6,
  Enabled: true,
  UserStatus: 'EXTERNAL_PROVIDER',
};
const BOB = {
  Username: 'bobby',
  Attributes: attrs({ sub: BOB_SUB, email: 'bob@example.com', email_verified: 'false' }),
  UserCreateDate: 1600000000,
  Enabled: false,
  UserStatus: 'FORCE_CHANGE_PASSWORD',
};
const NOSUB = { Username: 'ghost', Attributes: [], Enabled: true, UserStatus: 'CONFIRMED' };

function cognitoApi(over: Record<string, (body: Record<string, unknown>) => unknown> = {}) {
  const handlers: Record<string, (body: Record<string, unknown>) => unknown> = {
    ListGroups: () => ({ Groups: [{ GroupName: 'Admins', Description: 'Pool admins', Precedence: 0 }] }),
    ListIdentityProviders: () => ({ Providers: [{ ProviderName: 'Google', ProviderType: 'Google' }, { ProviderName: 'AcmeSAML', ProviderType: 'SAML' }] }),
    DescribeIdentityProvider: (b) =>
      b.ProviderName === 'AcmeSAML'
        ? {
            IdentityProvider: {
              ProviderName: 'AcmeSAML',
              ProviderType: 'SAML',
              ProviderDetails: { MetadataURL: 'https://idp.acme.example/metadata' },
              AttributeMapping: { email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress' },
              IdpIdentifiers: ['acme.example', 'AcmeCorp'],
            },
          }
        : { status: 400, body: { __type: 'ResourceNotFoundException', message: 'no' } },
    ListUsers: (b) => (b.PaginationToken === 'p2' ? { Users: [BOB, NOSUB] } : { Users: [JANE, FED], PaginationToken: 'p2' }),
    ListUsersInGroup: (b) => (b.GroupName === 'Admins' ? { Users: [JANE] } : { Users: [] }),
    ...over,
  };
  return fakeVendor(ORIGIN, {
    'POST /': ({ headers, body }: { headers: Headers; body: unknown }) => {
      const action = (headers.get('x-amz-target') ?? '').split('.').pop()!;
      const handler = handlers[action];
      if (!handler) return { status: 400, body: { __type: 'UnknownOperationException' } };
      return handler((body ?? {}) as Record<string, unknown>);
    },
    [`GET /${POOL}/.well-known/jwks.json`]: { keys: [{ kid: 'k1', kty: 'RSA', alg: 'RS256', e: 'AQAB', n: 'abc', use: 'sig' }] },
  });
}

const CREDS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' };

describe('exportCognito', () => {
  it('maps users by sub, groups as roles, federated links, SAML connections, SMS factors and the pool keys', async () => {
    const api = cognitoApi();
    const set = await exportCognito({ userPoolId: POOL, credentials: CREDS, fetchImpl: api.fetchImpl, sleep: noSleep, now: () => new Date('2026-10-25T00:00:00Z') });

    const signed = api.calls.filter((c) => c.method === 'POST');
    expect(signed.every((c) => c.headers.get('authorization')?.startsWith('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261025/us-east-1/cognito-idp/aws4_request'))).toBe(true);
    expect(signed.every((c) => c.headers.get('content-type') === 'application/x-amz-json-1.1')).toBe(true);
    const listUsers = signed.filter((c) => c.headers.get('x-amz-target') === 'AWSCognitoIdentityProviderService.ListUsers').map((c) => c.body);
    expect(listUsers).toEqual([
      { UserPoolId: POOL, Limit: 60 },
      { UserPoolId: POOL, Limit: 60, PaginationToken: 'p2' },
    ]);

    expect(set.list('user').map((u) => u.id)).toEqual([JANE_SUB, FED_SUB, BOB_SUB]);
    const [jane, fed, bob] = set.list('user');
    expect(jane).toEqual({
      id: JANE_SUB,
      emails: [{ email: 'jane@example.com', verified: true, primary: true }],
      phones: [{ phone: '+14155550101', verified: true, primary: false }],
      first_name: 'Jane',
      last_name: 'Doe',
      image_url: 'https://cdn.example.com/jane.png',
      roles: ['admins'],
      public_metadata: { plan: 'pro', tenant_id: 't_42' },
      private_metadata: { cognito_username: JANE_SUB, cognito_status: 'CONFIRMED', cognito_attributes: { locale: 'en-US' } },
      created_at: 1700000000250,
    });
    expect(fed!.username).toBeUndefined();
    expect(fed!.emails).toEqual([{ email: 'fed@gmail.example', verified: false, primary: true }]);
    expect(bob).toMatchObject({ id: BOB_SUB, username: 'bobby', banned: true, created_at: 1600000000000 });
    expect(set.omitted.user).toEqual({ count: 1, reason: 'no sub, or no email, phone number or username' });

    expect(set.list('role')).toEqual([{ key: 'admins', name: 'Admins', description: 'Pool admins', scope: 'app' }]);
    expect(set.list('identity')).toEqual([{ user_id: FED_SUB, provider: 'google', provider_user_id: '109876543210', kind: 'oauth' }]);
    expect(set.list('sso_connection')).toEqual([
      {
        id: 'AcmeSAML',
        name: 'AcmeSAML',
        protocol: 'saml',
        domains: ['acme.example'],
        saml: { idp_metadata_url: 'https://idp.acme.example/metadata', attribute_mapping: { email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress' } },
        enabled: true,
      },
    ]);
    expect(set.list('mfa_factor')).toEqual([{ user_id: JANE_SUB, type: 'phone', phone: '+14155550101', verified: true }]);
    expect(set.list('jwks')).toEqual([{ kid: 'k1', jwk: { kid: 'k1', kty: 'RSA', alg: 'RS256', e: 'AQAB', n: 'abc', use: 'sig' } }]);

    expect(set.manifest.origin).toBe(`Cognito user pool ${POOL}`);
    expect(set.manifest.providers).toEqual(['AcmeSAML', 'google']);
    expect(set.warnings.some((w) => w.includes('never exports password hashes'))).toBe(true);
    expect(set.warnings.some((w) => w.includes('1 user(s) still have an admin-set temporary password'))).toBe(true);
    expect(set.omitted.password?.count).toBe(2);
  });

  it('reads every user\'s MFA settings with AdminGetUser when asked, counting TOTP users', async () => {
    const api = cognitoApi({
      ListUsers: () => ({ Users: [JANE, BOB] }),
      AdminGetUser: (b) => (b.Username === 'bobby' ? { UserMFASettingList: ['SOFTWARE_TOKEN_MFA', 'EMAIL_OTP'] } : { UserMFASettingList: ['SMS_MFA'] }),
    });
    const set = await exportCognito({ userPoolId: POOL, credentials: CREDS, mfa: true, groups: 'skip', fetchImpl: api.fetchImpl, sleep: noSleep });
    expect(set.list('mfa_factor')).toEqual([
      { user_id: JANE_SUB, type: 'phone', phone: '+14155550101', verified: true },
      { user_id: BOB_SUB, type: 'email', verified: true },
    ]);
    expect(set.omitted.mfa_factor).toEqual({ count: 1, reason: 'Cognito never exports TOTP secrets: these users enrol an authenticator app again in Atlas' });
    expect(api.calls.some((c) => c.headers.get('x-amz-target')?.endsWith('.ListGroups'))).toBe(false);
  });

  it('retries throttling and reports other Cognito errors with their type', async () => {
    let calls = 0;
    const throttled = cognitoApi({
      ListUsers: () => (++calls === 1 ? { status: 400, body: { __type: 'TooManyRequestsException', message: 'Rate exceeded' } } : { Users: [JANE] }),
    });
    const set = await exportCognito({ userPoolId: POOL, credentials: CREDS, groups: 'skip', fetchImpl: throttled.fetchImpl, sleep: noSleep });
    expect(set.count('user')).toBe(1);

    const denied = cognitoApi({ ListUsers: () => ({ status: 400, body: { __type: 'com.amazonaws#NotAuthorizedException', message: 'not allowed' } }) });
    await expect(exportCognito({ userPoolId: POOL, credentials: CREDS, groups: 'skip', fetchImpl: denied.fetchImpl, sleep: noSleep })).rejects.toThrow('Cognito API 400 on ListUsers: NotAuthorizedException: not allowed');
  });

  it('exports users from `aws cognito-idp list-users` output without calling the Cognito API', async () => {
    const api = cognitoApi();
    const cli = JSON.stringify({ Users: [{ ...JANE, UserCreateDate: '2023-11-14T22:13:20.250000+00:00' }, FED] });
    const set = await exportCognito({ userPoolId: POOL, usersText: cli, fetchImpl: api.fetchImpl, sleep: noSleep });
    expect(set.list('user').map((u) => u.id)).toEqual([JANE_SUB, FED_SUB]);
    expect(set.list('user')[0]!.created_at).toBe('2023-11-14T22:13:20.250000+00:00');
    expect(api.calls.map((c) => c.method)).toEqual(['GET']); // the public JWKS only
    expect(set.count('role')).toBe(0);
  });

  it('refuses a pool id without a region and an export without credentials or a file', async () => {
    await expect(exportCognito({ userPoolId: 'nope', credentials: CREDS })).rejects.toThrow('Not a Cognito user pool id');
    await expect(exportCognito({ userPoolId: POOL })).rejects.toThrow('needs AWS credentials');
  });
});

describe('Cognito mapping helpers', () => {
  it('reads the identities attribute in its ID-token form too (string primary / dateCreated)', () => {
    const raw = '[{"userId":"amzn1.account.EXAMPLE","providerName":"LoginWithAmazon","providerType":"LoginWithAmazon","issuer":null,"primary":"true","dateCreated":"1642699117273"},{"userId":"u@corp.example","providerName":"Corp","providerType":"SAML"}]';
    expect(cognitoIdentities('sub-1', raw)).toEqual([
      { user_id: 'sub-1', provider: 'amazon', provider_user_id: 'amzn1.account.EXAMPLE', kind: 'oauth' },
      { user_id: 'sub-1', provider: 'Corp', provider_user_id: 'u@corp.example', kind: 'saml', sso_connection_id: 'Corp' },
    ]);
    expect(cognitoIdentities('sub-1', 'not json')).toEqual([]);
  });

  it('keeps a typed username, prefers preferred_username, and never uses the generated id or an email as one', () => {
    expect(mapCognitoUser({ Username: 'alice', Attributes: attrs({ sub: 's1', email: 'a@x.example' }) })!.username).toBe('alice');
    expect(mapCognitoUser({ Username: 'alice', Attributes: attrs({ sub: 's1', preferred_username: 'ally' }) })!.username).toBe('ally');
    expect(mapCognitoUser({ Username: 'a@x.example', Attributes: attrs({ sub: 's1', email: 'a@x.example' }) })!.username).toBeUndefined();
    expect(mapCognitoUser({ Username: 'x', Attributes: [] })).toBeNull();
  });

  it('parses list-users output and refuses anything else', () => {
    expect(parseListUsersOutput('{"Users":[{"Username":"a"}]}')).toEqual([{ Username: 'a' }]);
    expect(parseListUsersOutput('[{"Username":"a"}]')).toEqual([{ Username: 'a' }]);
    expect(() => parseListUsersOutput('{"users":1}')).toThrow('no "Users" list');
    expect(() => parseListUsersOutput('nope')).toThrow('not `aws cognito-idp list-users');
  });

  it('pages token lists until the token is gone', async () => {
    const api = cognitoApi({ ListGroups: (b) => (b.NextToken ? { Groups: [{ GroupName: 'B' }] } : { Groups: [{ GroupName: 'A' }], NextToken: 'n1' }) });
    const client = new CognitoApi({ region: 'us-east-1', credentials: CREDS, fetchImpl: api.fetchImpl, sleep: noSleep });
    expect((await client.all('ListGroups', { UserPoolId: POOL }, 'Groups', 'NextToken')).map((g) => g.GroupName)).toEqual(['A', 'B']);
  });
});
