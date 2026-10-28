import { describe, expect, it } from 'vitest';
import { CognitoApi } from './cognito';
import { fetchCognitoConfig, translateCognitoConfig, validityMs, type CognitoConfigSnapshot } from './cognito-config';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';

/** DescribeUserPool / DescribeUserPoolClient / DescribeIdentityProvider shapes as AWS documents them. */
const POOL = {
  Id: 'eu-west-1_Abc',
  Name: 'customers',
  Policies: {
    PasswordPolicy: { MinimumLength: 6, RequireUppercase: true, RequireLowercase: true, RequireNumbers: true, RequireSymbols: false, TemporaryPasswordValidityDays: 7, PasswordHistorySize: 3 },
  },
  UsernameAttributes: ['email'],
  AutoVerifiedAttributes: ['email'],
  MfaConfiguration: 'OPTIONAL',
  SmsConfiguration: { SnsCallerArn: 'arn:aws:iam::123:role/sns' },
  AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
  UserPoolAddOns: { AdvancedSecurityMode: 'ENFORCED' },
  SchemaAttributes: [{ Name: 'email' }, { Name: 'custom:plan' }, { Name: 'custom:tenant_id' }],
  LambdaConfig: { PreSignUp: 'arn:aws:lambda:eu-west-1:123:function:pre', UserMigration: 'arn:aws:lambda:eu-west-1:123:function:migrate', KMSKeyID: 'arn:kms' },
};
const WEB = {
  ClientId: 'webclient1',
  ClientName: 'web',
  CallbackURLs: ['https://app.example.com/callback', 'https://*.preview.example.com/cb'],
  LogoutURLs: ['https://app.example.com/'],
  ExplicitAuthFlows: ['ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
  RefreshTokenValidity: 60,
  IdTokenValidity: 30,
  TokenValidityUnits: { IdToken: 'minutes', RefreshToken: 'days' },
  SupportedIdentityProviders: ['COGNITO', 'Google', 'Corp'],
};
const LAZY = { ClientId: 'lazyclient', ClientName: 'migration', ExplicitAuthFlows: ['ALLOW_USER_PASSWORD_AUTH'] };
const SERVER = { ClientId: 'm2m', ClientName: 'backend', ClientSecret: 's3cret', AllowedOAuthFlows: ['client_credentials'] };

function snapshot(over: Partial<CognitoConfigSnapshot> = {}): CognitoConfigSnapshot {
  return {
    poolId: 'eu-west-1_Abc',
    region: 'eu-west-1',
    pool: POOL,
    clients: [WEB, LAZY, SERVER],
    idps: [
      { ProviderName: 'Google', ProviderType: 'Google', ProviderDetails: { client_id: 'goog.apps.googleusercontent.com', authorize_scopes: 'openid email profile' } },
      { ProviderName: 'Corp', ProviderType: 'SAML', ProviderDetails: { MetadataURL: 'https://idp.corp.example/md' } },
      { ProviderName: 'Weird', ProviderType: 'Twitch' },
    ],
    resourceServers: [{ Identifier: 'https://api.example.com', Name: 'API', Scopes: [{ ScopeName: 'read' }, { ScopeName: 'write' }] }],
    groups: [{ GroupName: 'Admins', Description: 'admins', RoleArn: 'arn:aws:iam::123:role/admin' }, { GroupName: 'Billing Team' }],
    ...over,
  };
}

const find = (r: ReturnType<typeof translateCognitoConfig>, setting: string) => r.report.find((e) => e.setting === setting);

describe('translateCognitoConfig', () => {
  it('translates the pool, clients, providers, APIs and groups with a line per setting', () => {
    const r = translateCognitoConfig(snapshot());
    const instance = r.documents.instance as { auth_config: Record<string, unknown> };
    expect(instance.auth_config).toMatchObject({
      strategies: { password: true },
      requireEmailVerification: true,
      signUpMode: 'restricted',
      passwordPolicy: { minLength: 8, checkBreaches: true },
      mfaPolicy: 'optional',
      mfa: { factors: { totp: true } },
      session: { absoluteMs: 60 * 86_400_000 },
    });
    expect(find(r, 'Policies.PasswordPolicy.MinimumLength')).toMatchObject({ status: 'differs', atlas: 'auth_config.passwordPolicy.minLength' });
    expect(find(r, 'Policies.PasswordPolicy.PasswordHistorySize')?.status).toBe('manual');
    expect(find(r, 'UsernameAttributes email')?.status).toBe('mapped');
    expect(find(r, 'LambdaConfig.PreSignUp')).toMatchObject({ status: 'manual', atlas: 'actions' });
    expect(find(r, 'LambdaConfig.UserMigration')).toMatchObject({ status: 'differs', atlas: 'legacy_auth_connection' });
    expect(r.report.some((e) => e.setting === 'LambdaConfig.KMSKeyID')).toBe(false);
    expect(find(r, 'SchemaAttributes custom:*')?.note).toContain('custom:plan, custom:tenant_id');
    expect(find(r, 'UserPoolAddOns.AdvancedSecurityMode ENFORCED')?.status).toBe('differs');

    expect(r.documents.redirect_urls).toEqual([{ url: 'https://app.example.com/callback' }, { url: 'https://app.example.com/' }]);
    expect(find(r, 'CallbackURLs https://*.preview.example.com/cb')?.status).toBe('differs');
    expect(find(r, 'IdTokenValidity')?.note).toContain('30 minutes');
    expect(find(r, 'AllowedOAuthFlows client_credentials')?.status).toBe('manual');
    expect(find(r, 'SupportedIdentityProviders Corp')).toBeUndefined();

    expect(r.documents.oauth_providers).toEqual([
      { provider: 'google', enabled: true, allow_sign_in: true, allow_sign_up: true, client_id: 'goog.apps.googleusercontent.com', client_secret: '${GOOGLE_CLIENT_SECRET}', scopes: ['openid', 'email', 'profile'] },
    ]);
    expect(r.env).toContainEqual({ name: 'GOOGLE_CLIENT_SECRET', for: 'Google client secret' });
    expect(find(r, 'Corp (SAML)')).toMatchObject({ status: 'mapped', atlas: 'sso_connections' });
    expect(find(r, 'Weird (Twitch)')?.status).toBe('manual');
    expect(r.documents.resource_servers).toEqual([{ identifier: 'https://api.example.com', name: 'API', scopes: ['read', 'write'] }]);

    expect(r.documents.roles).toEqual([
      { key: 'admins', name: 'Admins', description: 'admins', permissions: [] },
      { key: 'billing_team', name: 'Billing Team', description: '', permissions: [] },
    ]);
    expect(r.mappings.roles).toEqual({ Admins: 'admins', 'Billing Team': 'billing_team' });
    expect(find(r, 'RoleArn')?.status).toBe('manual');

    expect(r.bridge).toEqual({ preset: 'cognito', vars: { region: 'eu-west-1', user_pool_id: 'eu-west-1_Abc', client_id: 'webclient1' } });
    expect(r.lazy).toEqual({ preset: 'cognito', config: { region: 'eu-west-1', user_pool_id: 'eu-west-1_Abc', client_id: 'lazyclient' } });
    expect(r.origin).toBe('Cognito user pool eu-west-1_Abc');
  });

  it('asks for a USER_PASSWORD_AUTH client when none exists, and reads username pools and passwordless factors', () => {
    const r = translateCognitoConfig(
      snapshot({
        pool: { Policies: { SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD', 'EMAIL_OTP', 'WEB_AUTHN'] } }, AliasAttributes: ['preferred_username', 'phone_number'], MfaConfiguration: 'ON', UsernameConfiguration: { CaseSensitive: true } },
        clients: [WEB],
        idps: [],
        resourceServers: [],
        groups: [],
      }),
    );
    const auth = (r.documents.instance as { auth_config: Record<string, unknown> }).auth_config;
    expect(auth).toMatchObject({ strategies: { password: true, username: true, emailCode: true, passkey: true }, mfaPolicy: 'required' });
    expect(find(r, 'ExplicitAuthFlows ALLOW_USER_PASSWORD_AUTH')?.status).toBe('manual');
    expect(find(r, 'AliasAttributes phone_number')?.status).toBe('differs');
    expect(find(r, 'UsernameConfiguration.CaseSensitive')?.status).toBe('differs');
    expect(r.lazy?.config.client_id).toBeUndefined();
  });

  it('computes token validity in the client\'s units', () => {
    expect(validityMs({ RefreshTokenValidity: 30 }, 'RefreshToken')).toBe(30 * 86_400_000);
    expect(validityMs({ AccessTokenValidity: 2 }, 'AccessToken')).toBe(2 * 3_600_000);
    expect(validityMs({ IdTokenValidity: 300, TokenValidityUnits: { IdToken: 'seconds' } }, 'IdToken')).toBe(300_000);
    expect(validityMs({}, 'IdToken')).toBeUndefined();
  });
});

describe('fetchCognitoConfig', () => {
  it('describes the pool, every client and identity provider, tolerating denied optional reads', async () => {
    const api = fakeVendor('https://cognito-idp.eu-west-1.amazonaws.com', {
      'POST /': ({ headers, body }: { headers: Headers; body: unknown }) => {
        const action = (headers.get('x-amz-target') ?? '').split('.').pop();
        const b = body as Record<string, unknown>;
        switch (action) {
          case 'DescribeUserPool':
            return { UserPool: POOL };
          case 'ListUserPoolClients':
            return { UserPoolClients: [{ ClientId: 'webclient1' }] };
          case 'DescribeUserPoolClient':
            return { UserPoolClient: { ...WEB, ClientId: b.ClientId } };
          case 'ListIdentityProviders':
            return { Providers: [{ ProviderName: 'Google', ProviderType: 'Google' }] };
          case 'DescribeIdentityProvider':
            return { IdentityProvider: { ProviderName: 'Google', ProviderType: 'Google', ProviderDetails: { client_id: 'g' } } };
          case 'ListResourceServers':
            return { status: 400, body: { __type: 'AccessDeniedException', message: 'no' } };
          case 'ListGroups':
            return { Groups: [{ GroupName: 'Admins' }] };
          default:
            return { status: 400, body: { __type: 'UnknownOperationException' } };
        }
      },
    });
    const client = new CognitoApi({ region: 'eu-west-1', credentials: { accessKeyId: 'AKID', secretAccessKey: 's' }, fetchImpl: api.fetchImpl, sleep: noSleep });
    const snap = await fetchCognitoConfig(client, 'eu-west-1_Abc', 'eu-west-1');
    expect(snap.clients.map((c) => c.ClientId)).toEqual(['webclient1']);
    expect(snap.idps).toHaveLength(1);
    expect(snap.resourceServers).toEqual([]);
    expect(snap.groups).toEqual([{ GroupName: 'Admins' }]);
  });
});
