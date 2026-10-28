import { describe, expect, it } from 'vitest';
import { graphHttp } from './azure';
import { fetchAzureConfig, parsePolicyProfiles, relyingPartySubject, translateAzureConfig, type AzureConfigSnapshot } from './azure-config';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';

/** A TrustFrameworkExtensions.xml in the shape of the B2C custom policy starter pack (SocialAndLocalAccounts). */
const EXTENSIONS = `<?xml version="1.0" encoding="utf-8" ?>
<TrustFrameworkPolicy xmlns="http://schemas.microsoft.com/online/cpim/schemas/2013/06" PolicyId="B2C_1A_TrustFrameworkExtensions">
  <ClaimsProviders>
    <ClaimsProvider>
      <Domain>google.com</Domain>
      <DisplayName>Google</DisplayName>
      <TechnicalProfiles>
        <TechnicalProfile Id="Google-OAuth2">
          <DisplayName>Google</DisplayName>
          <Protocol Name="OAuth2" />
          <Metadata>
            <Item Key="ProviderName">google</Item>
            <Item Key="client_id">1234-goog.apps.googleusercontent.com</Item>
            <Item Key="scope">email profile</Item>
          </Metadata>
        </TechnicalProfile>
      </TechnicalProfiles>
    </ClaimsProvider>
    <ClaimsProvider>
      <Domain>contoso.com</Domain>
      <DisplayName>Contoso Entra ID</DisplayName>
      <TechnicalProfiles>
        <TechnicalProfile Id="Contoso-OpenIdConnect">
          <DisplayName>Contoso Employee</DisplayName>
          <Protocol Name="OpenIdConnect" />
          <Metadata>
            <Item Key="METADATA">https://login.microsoftonline.com/contoso.com/v2.0/.well-known/openid-configuration</Item>
            <Item Key="client_id">aaaa-bbbb</Item>
          </Metadata>
        </TechnicalProfile>
        <TechnicalProfile Id="Fabrikam-SAML2">
          <DisplayName>Fabrikam</DisplayName>
          <Protocol Name="SAML2" />
          <Metadata>
            <Item Key="PartnerEntity">https://idp.fabrikam.example/metadata</Item>
          </Metadata>
        </TechnicalProfile>
      </TechnicalProfiles>
    </ClaimsProvider>
    <ClaimsProvider>
      <DisplayName>REST APIs</DisplayName>
      <TechnicalProfiles>
        <TechnicalProfile Id="REST-ValidateLoyalty">
          <DisplayName>Check loyalty</DisplayName>
          <Protocol Name="Proprietary" Handler="Web.TPEngine.Providers.RestfulProvider, Web.TPEngine, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null" />
          <Metadata>
            <Item Key="ServiceUrl">https://api.example.com/loyalty?a=1&amp;b=2</Item>
          </Metadata>
        </TechnicalProfile>
        <TechnicalProfile Id="AAD-UserReadUsingObjectId">
          <Protocol Name="Proprietary" Handler="Web.TPEngine.Providers.AzureActiveDirectoryProvider, Web.TPEngine, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null" />
        </TechnicalProfile>
      </TechnicalProfiles>
    </ClaimsProvider>
    <ClaimsProvider>
      <DisplayName>Token Issuer</DisplayName>
      <TechnicalProfiles>
        <TechnicalProfile Id="JwtIssuer">
          <Protocol Name="None" />
          <Metadata>
            <Item Key="token_lifetime_secs">3600</Item>
            <Item Key="refresh_token_lifetime_secs">1209600</Item>
          </Metadata>
        </TechnicalProfile>
      </TechnicalProfiles>
    </ClaimsProvider>
  </ClaimsProviders>
</TrustFrameworkPolicy>
`;

const SIGNUP_SIGNIN = `<TrustFrameworkPolicy PolicyId="B2C_1A_signup_signin">
  <RelyingParty>
    <DefaultUserJourney ReferenceId="SignUpOrSignIn" />
    <TechnicalProfile Id="PolicyProfile">
      <Protocol Name="OpenIdConnect" />
      <OutputClaims>
        <OutputClaim ClaimTypeReferenceId="email" />
        <OutputClaim ClaimTypeReferenceId="signInName" PartnerClaimType="sub" />
      </OutputClaims>
    </TechnicalProfile>
  </RelyingParty>
</TrustFrameworkPolicy>
`;

describe('B2C custom policies', () => {
  it('finds every technical profile with its file, line, protocol, handler and metadata', () => {
    const profiles = parsePolicyProfiles('TrustFrameworkExtensions.xml', EXTENSIONS);
    expect(profiles.map((p) => [p.id, p.line, p.protocol])).toEqual([
      ['Google-OAuth2', 8, 'OAuth2'],
      ['Contoso-OpenIdConnect', 23, 'OpenIdConnect'],
      ['Fabrikam-SAML2', 31, 'SAML2'],
      ['REST-ValidateLoyalty', 43, 'Proprietary'],
      ['AAD-UserReadUsingObjectId', 50, 'Proprietary'],
      ['JwtIssuer', 58, 'None'],
    ]);
    expect(profiles[0]).toMatchObject({ domain: 'google.com', metadata: { ProviderName: 'google', client_id: '1234-goog.apps.googleusercontent.com', scope: 'email profile' } });
    expect(profiles[3]!.metadata.ServiceUrl).toBe('https://api.example.com/loyalty?a=1&b=2');
    expect(profiles[3]!.handler).toMatch(/^Web\.TPEngine\.Providers\.RestfulProvider/);
  });

  it('finds the relying party\'s sub claim', () => {
    expect(relyingPartySubject('SignUpOrSignin.xml', SIGNUP_SIGNIN)).toEqual({ claim: 'signInName', line: 8 });
    expect(relyingPartySubject('x.xml', EXTENSIONS)).toBeUndefined();
    expect(parsePolicyProfiles('SignUpOrSignin.xml', SIGNUP_SIGNIN)).toMatchObject([{ id: 'PolicyProfile', line: 4, relyingParty: true }]);
  });
});

function snapshot(over: Partial<AzureConfigSnapshot> = {}): AzureConfigSnapshot {
  return {
    kind: 'b2c',
    tenant: 'contoso.onmicrosoft.com',
    tenantId: '11111111-2222-3333-4444-555555555555',
    tenantName: 'contoso',
    identityProviders: [
      { '@odata.type': '#microsoft.graph.socialIdentityProvider', id: 'Facebook-OAUTH', displayName: 'Facebook', identityProviderType: 'Facebook', clientId: 'fb-app', clientSecret: '******' },
      { '@odata.type': '#microsoft.graph.appleManagedIdentityProvider', id: 'Apple-Managed-OIDC', displayName: 'Sign in with Apple', developerId: 'TEAM', serviceId: 'com.contoso.web' },
      { '@odata.type': '#microsoft.graph.openIdConnectIdentityProvider', id: 'Partner-OIDC', displayName: 'Partner', metadataUrl: 'https://login.partner.example/.well-known/openid-configuration' },
      { '@odata.type': '#microsoft.graph.socialIdentityProvider', id: 'Weibo-OAUTH', displayName: 'Weibo', identityProviderType: 'Weibo' },
    ],
    userFlows: [
      { id: 'B2C_1_signupsignin', userFlowType: 'signUpOrSignIn', userFlowTypeVersion: 3, userAttributeAssignments: [{ id: 'extension_0123456789abcdef0123456789abcdef_loyaltyTier' }, { id: 'city' }], apiConnectorConfiguration: { postAttributeCollection: { id: 'conn1' } } },
      { id: 'B2C_1_ROPC_Auth', userFlowType: 'resourceOwner', userFlowTypeVersion: 1 },
      { id: 'B2C_1_reset', userFlowType: 'passwordReset', userFlowTypeVersion: 3 },
    ],
    eventsFlows: [],
    userFlowAttributes: [
      { id: 'city', displayName: 'City', userFlowAttributeType: 'builtIn' },
      { id: 'extension_0123456789abcdef0123456789abcdef_loyaltyTier', displayName: 'loyaltyTier', userFlowAttributeType: 'custom' },
    ],
    applications: [
      { appId: 'b2c-ext', displayName: 'b2c-extensions-app. Do not modify. Used by AADB2C for storing user data.', web: { redirectUris: [] } },
      { appId: 'web-app-id', displayName: 'Contoso Web', web: { redirectUris: ['https://app.contoso.com/auth/callback'] }, spa: { redirectUris: ['https://app.contoso.com/', 'https://*.contoso.dev/'] }, isFallbackPublicClient: true },
      { appId: 'mobile', displayName: 'Mobile', publicClient: { redirectUris: ['msalmobile://auth', 'msal0000-1111://auth'] } },
    ],
    groups: [{ id: 'g1', displayName: 'VIP Customers' }],
    policies: [],
    ...over,
  };
}

const entry = (r: ReturnType<typeof translateAzureConfig>, setting: string) => r.report.find((e) => e.setting === setting);

describe('translateAzureConfig', () => {
  it('translates a B2C tenant: providers, user flows, attributes, redirect URIs, groups, and the bridge and lazy variables', () => {
    const r = translateAzureConfig(snapshot());
    expect(r.documents.oauth_providers).toEqual([
      { provider: 'facebook', enabled: true, allow_sign_in: true, allow_sign_up: true, client_id: 'fb-app', client_secret: '${FACEBOOK_CLIENT_SECRET}' },
      { provider: 'apple', enabled: true, allow_sign_in: true, allow_sign_up: true, client_id: 'com.contoso.web', client_secret: '${APPLE_CLIENT_SECRET}' },
    ]);
    expect(entry(r, 'Partner (openIdConnectIdentityProvider)')).toMatchObject({ status: 'mapped', atlas: 'sso_connections' });
    expect(entry(r, 'Weibo (socialIdentityProvider)')?.status).toBe('manual');
    expect(entry(r, 'Local accounts')).toMatchObject({ status: 'differs', atlas: 'auth_config.strategies.password' });
    expect((r.documents.instance as { auth_config: Record<string, unknown> }).auth_config).toMatchObject({ strategies: { password: true } });

    expect(entry(r, 'userFlowType resourceOwner')?.area).toBe('user flow B2C_1_ROPC_Auth');
    expect(entry(r, 'userFlowType passwordReset')?.status).toBe('mapped');
    expect(entry(r, 'userAttributeAssignments extension_0123456789abcdef0123456789abcdef_loyaltyTier')?.status).toBe('differs');
    expect(entry(r, 'userAttributeAssignments city')).toBeUndefined();
    expect(entry(r, 'apiConnectorConfiguration')?.status).toBe('manual');
    expect(entry(r, 'userFlowAttributes (custom)')?.note).toContain('loyaltyTier');

    expect(r.documents.redirect_urls).toEqual([{ url: 'https://app.contoso.com/auth/callback' }, { url: 'https://app.contoso.com/' }, { url: 'msalmobile://auth' }]);
    expect(entry(r, 'redirectUris https://*.contoso.dev/')?.status).toBe('differs');
    expect(r.documents.roles).toEqual([{ key: 'vip_customers', name: 'VIP Customers', description: '', permissions: [] }]);

    expect(r.bridge).toEqual({ preset: 'azure_ad_b2c', vars: { tenant: 'contoso', tenant_id: '11111111-2222-3333-4444-555555555555', client_id: 'web-app-id', policy: 'B2C_1_signupsignin' } });
    expect(r.lazy).toEqual({ preset: 'azure_ad_b2c', config: { tenant: 'contoso', client_id: 'web-app-id', policy: 'B2C_1_ROPC_Auth' } });
    expect(r.origin).toBe('Azure AD B2C tenant contoso.onmicrosoft.com');
  });

  it('reports custom policies with file and line', () => {
    const r = translateAzureConfig(
      snapshot({ identityProviders: [], userFlows: [], policies: [{ file: 'TrustFrameworkExtensions.xml', text: EXTENSIONS }, { file: 'SignUpOrSignin.xml', text: SIGNUP_SIGNIN }] }),
    );
    const google = entry(r, 'TechnicalProfile Google-OAuth2');
    expect(google).toMatchObject({ status: 'differs', file: 'TrustFrameworkExtensions.xml', line: 8, atlas: 'oauth_providers google' });
    expect((r.documents.oauth_providers as Array<{ client_id: string; scopes: string[] }>)[0]).toMatchObject({ client_id: '1234-goog.apps.googleusercontent.com', scopes: ['email', 'profile'] });
    expect(entry(r, 'TechnicalProfile Contoso-OpenIdConnect')).toMatchObject({ status: 'mapped', line: 23, atlas: 'sso_connections' });
    expect(entry(r, 'TechnicalProfile Fabrikam-SAML2')).toMatchObject({ status: 'mapped', line: 31 });
    expect(entry(r, 'TechnicalProfile REST-ValidateLoyalty')).toMatchObject({ status: 'manual', line: 43, atlas: 'actions' });
    expect(entry(r, 'TechnicalProfile AAD-UserReadUsingObjectId')).toBeUndefined();
    expect(entry(r, 'TechnicalProfile JwtIssuer refresh_token_lifetime_secs')).toMatchObject({ status: 'mapped', line: 58 });
    expect((r.documents.instance as { auth_config: { session: { absoluteMs: number } } }).auth_config.session.absoluteMs).toBe(1_209_600_000);
    expect(entry(r, 'TechnicalProfile PolicyProfile')).toBeUndefined();
    expect(entry(r, 'RelyingParty OutputClaim signInName → sub')).toMatchObject({ status: 'differs', file: 'SignUpOrSignin.xml', line: 8 });
    expect(entry(r, 'resourceOwner user flow')?.status).toBe('manual');
    expect(r.lazy?.config.policy).toBeUndefined();
  });

  it('translates an External ID tenant: built-in providers, sign-up flows and native authentication', () => {
    const r = translateAzureConfig(
      snapshot({
        kind: 'entra',
        tenant: '11111111-2222-3333-4444-555555555555',
        identityProviders: [
          { '@odata.type': '#microsoft.graph.builtInIdentityProvider', id: 'EmailPassword', displayName: 'Email with password', identityProviderType: 'EmailPassword' },
          { '@odata.type': '#microsoft.graph.builtInIdentityProvider', id: 'EmailOtpSignup-OAUTH', displayName: 'Email one-time passcode', identityProviderType: 'EmailOTP' },
          { '@odata.type': '#microsoft.graph.socialIdentityProvider', id: 'Google-OAUTH', displayName: 'Google', identityProviderType: 'Google', clientId: 'g-client' },
        ],
        userFlows: [],
        eventsFlows: [
          {
            '@odata.type': '#microsoft.graph.externalUsersSelfServiceSignUpEventsFlow',
            id: 'flow1',
            displayName: 'SignUpSignIn',
            onAuthenticationMethodLoadStart: { identityProviders: [{ id: 'EmailPassword-OAUTH' }] },
            onAttributeCollection: { attributes: [{ id: 'email' }, { id: 'extension_abc_favoriteColor', displayName: 'favoriteColor' }] },
          },
        ],
      }),
    );
    const auth = (r.documents.instance as { auth_config: Record<string, unknown> }).auth_config;
    expect(auth).toMatchObject({ strategies: { password: true, emailCode: true } });
    expect(entry(r, 'Email with password (builtInIdentityProvider)')).toBeUndefined();
    expect(entry(r, 'EmailPassword')).toMatchObject({ status: 'differs' });
    expect(entry(r, 'onAttributeCollection extension_abc_favoriteColor')?.status).toBe('differs');
    expect(entry(r, 'onAttributeCollection email')).toBeUndefined();
    expect(entry(r, 'native authentication')?.status).toBe('manual');
    expect(r.bridge).toEqual({ preset: 'entra_external_id', vars: { tenant: 'contoso', tenant_id: '11111111-2222-3333-4444-555555555555', client_id: 'web-app-id' } });
    expect(r.lazy).toEqual({ preset: 'entra_external_id', config: { tenant: 'contoso', client_id: 'web-app-id' } });
  });
});

describe('fetchAzureConfig', () => {
  it('reads Graph v1.0 and the B2C user flows on beta, tolerating permissions it lacks', async () => {
    const api = fakeVendor('https://graph.microsoft.com', {
      'GET /v1.0/organization': { value: [{ id: 'tid', verifiedDomains: [{ name: 'contoso.onmicrosoft.com', isInitial: true }] }] },
      'GET /beta/identity/b2cUserFlows': { value: [{ id: 'B2C_1_susi', userFlowType: 'signUpOrSignIn' }] },
      'GET /beta/identity/b2cUserFlows/B2C_1_susi/userFlowIdentityProviders': { value: [{ id: 'Facebook-OAUTH' }] },
      'GET /beta/identity/b2cUserFlows/B2C_1_susi/userAttributeAssignments': { status: 403, body: { error: { code: 'Forbidden' } } },
      'GET /v1.0/identity/identityProviders': { value: [{ id: 'Facebook-OAUTH' }] },
      'GET /v1.0/identity/userFlowAttributes': { value: [] },
      'GET /v1.0/applications': { value: [{ appId: 'a' }] },
      'GET /v1.0/groups': { status: 403, body: {} },
    });
    const http = graphHttp({ tenant: 'contoso.onmicrosoft.com', accessToken: 't', fetchImpl: api.fetchImpl, sleep: noSleep });
    const snap = await fetchAzureConfig(http, 'b2c', 'contoso.onmicrosoft.com');
    expect(snap.tenantName).toBe('contoso');
    expect(snap.userFlows).toEqual([{ id: 'B2C_1_susi', userFlowType: 'signUpOrSignIn', identityProviders: [{ id: 'Facebook-OAUTH' }], userAttributeAssignments: [] }]);
    expect(snap.identityProviders).toHaveLength(1);
    expect(snap.applications).toHaveLength(1);
    expect(snap.groups).toEqual([]);
    expect(snap.eventsFlows).toEqual([]);
    expect(api.calls.some((c) => c.url.includes('authenticationEventsFlows'))).toBe(false);
  });
});
