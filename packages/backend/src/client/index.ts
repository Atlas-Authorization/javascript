import { createRequest, type AtlasClientConfig, type AtlasRequestSettings } from './request';
import { usersResource } from './users';
import { sessionsResource } from './sessions';
import { organizationsResource } from './organizations';
import { permissionsResource, rolesResource } from './roles';
import { oauthClientsResource } from './oauth-clients';
import { resourceServersResource } from './resource-servers';
import { ssoConnectionsResource } from './sso-connections';
import { scimTokensResource } from './scim-tokens';
import { domainsResource } from './domains';
import { waitlistResource } from './waitlist';
import { allowlistResource, blocklistResource } from './restrictions';
import { attackProtectionResource } from './attack-protection';
import { actorTokensResource } from './actor-tokens';
import { invitationsResource } from './invitations';
import { webhooksResource } from './webhooks';
import { signInTokensResource } from './sign-in-tokens';
import { auditLogsResource } from './audit-logs';
import { jwtTemplatesResource } from './jwt-templates';
import { apiKeysResource } from './api-keys';
import { machinesResource } from './machines';
import { oauthProvidersResource } from './oauth-providers';
import { ssoOnboardingResource } from './sso-onboarding';
import { scimProvisioningResource } from './scim-provisioning';
import { fgaResource } from './fga';
import { rateLimitPolicyResource } from './rate-limit';
import { riskBasedMfaResource } from './risk-based-mfa';
import { botSignalsResource } from './bot-signals';
import { networkAclsResource } from './network-acls';
import { managedWafResource } from './managed-waf';
import { logStreamsResource } from './log-streams';
import { brandingResource } from './branding';
import { emailTemplatesResource } from './email-templates';
import { smsTemplatesResource } from './sms-templates';
import { localizationsResource } from './localizations';
import { actionsResource } from './actions';
import { billingResource } from './billing-plans';
import { messagingResource } from './messaging';
import { importExportResource } from './import-export';
import { dataSubjectRequestsResource } from './data-subject-requests';
import { radiusClientsResource } from './radius-clients';
import { ltiPlatformsResource } from './lti-platforms';
import { instanceResource } from './instance';
import { instanceSecurityResource } from './instance-security';
import { referralsResource } from './referrals';
import { userHooksResource } from './user-hooks';
import { tokensResource } from './tokens';
import { captchaResource } from './captcha';
import { designResource } from './design';
import { entitlementOverridesResource } from './entitlement-overrides';
import { orgLdapConnectionsResource } from './org-ldap-connections';
import { organizationSettingsSchemaResource } from './organization-settings-schema';
import { emailAddressesResource } from './email-addresses';
import { openfgaResource } from './openfga';
import { connectorsResource } from './connectors';
import { notificationsResource } from './notifications';
import { auditEventsResource } from './audit-events';
import { configChangelogResource, eventsResource, usageResource } from './activity';
import { logoutNotifyEndpointsResource } from './logout-notify-endpoints';
import { pcaResource } from './pca';
import { mcpConnectorResource, mcpResource } from './mcp';
import { legacyAuthConnectionResource } from './legacy-auth';
import { redirectUrlsResource } from './redirect-urls';
import { sessionExchangeAppsResource } from './session-exchange-apps';
import { ticketsResource } from './tickets';
import { testModeResource } from './test-mode';
import { diagnosticsResource } from './diagnostics';
import type { RequestFn } from './request';

/**
 * The typed management client for the Atlas Backend API — the secret-key
 * surface, the peer of `@clerk/backend`'s `createClerkClient`.
 *
 * Each namespace is one line: it hands the shared, config-bound `request`
 * function to a resource factory. That factory is where the method↔endpoint
 * mapping and the wire types live, so this file stays a table of contents you
 * can read top to bottom to see the whole surface.
 */
export function createAtlasClient(config: AtlasClientConfig): AtlasClient {
  const request = createRequest(config);
  return {
    ...buildNamespaces(request),
    withOptions(overrides: AtlasRequestSettings): AtlasClient {
      return createAtlasClient({ ...config, ...overrides });
    },
  };
}

function buildNamespaces(request: RequestFn) {
  return {
    users: usersResource(request),
    sessions: sessionsResource(request),
    organizations: organizationsResource(request),
    roles: rolesResource(request),
    permissions: permissionsResource(request),
    oauthClients: oauthClientsResource(request),
    resourceServers: resourceServersResource(request),
    ssoConnections: ssoConnectionsResource(request),
    scimTokens: scimTokensResource(request),
    domains: domainsResource(request),
    waitlist: waitlistResource(request),
    allowlist: allowlistResource(request),
    blocklist: blocklistResource(request),
    attackProtection: attackProtectionResource(request),
    actorTokens: actorTokensResource(request),
    invitations: invitationsResource(request),
    webhooks: webhooksResource(request),
    signInTokens: signInTokensResource(request),
    auditLogs: auditLogsResource(request),
    jwtTemplates: jwtTemplatesResource(request),
    apiKeys: apiKeysResource(request),
    // §9.3 / §P1-7 named machine identities + device registry + enrolment tokens.
    machines: machinesResource(request),
    oauthProviders: oauthProvidersResource(request),
    ssoOnboarding: ssoOnboardingResource(request),
    scimProvisioning: scimProvisioningResource(request),
    fga: fgaResource(request),
    rateLimitPolicy: rateLimitPolicyResource(request),
    riskBasedMfa: riskBasedMfaResource(request),
    botSignals: botSignalsResource(request),
    networkAcls: networkAclsResource(request),
    managedWaf: managedWafResource(request),
    logStreams: logStreamsResource(request),
    branding: brandingResource(request),
    emailTemplates: emailTemplatesResource(request),
    smsTemplates: smsTemplatesResource(request),
    localizations: localizationsResource(request),
    actions: actionsResource(request),
    billing: billingResource(request),
    messaging: messagingResource(request),
    importExport: importExportResource(request),
    dataSubjectRequests: dataSubjectRequestsResource(request),
    radiusClients: radiusClientsResource(request),
    ltiPlatforms: ltiPlatformsResource(request),
    instance: instanceResource(request),
    instanceSecurity: instanceSecurityResource(request),
    // Referral attribution: the instance's referral platform connection and call log.
    referrals: referralsResource(request),
    // The before_user_create hook (sets external_id before the user exists).
    userHooks: userHooksResource(request),
    tokens: tokensResource(request),
    // §5 "captcha anywhere" — verify any CAPTCHA token against the instance's
    // centrally-configured provider, server-side, with the secret held by Atlas.
    captcha: captchaResource(request),
    // Sign-in page design: instance + per-organization overrides, images, catalog.
    design: designResource(request),
    entitlementOverrides: entitlementOverridesResource(request),
    orgLdapConnections: orgLdapConnectionsResource(request),
    organizationSettingsSchema: organizationSettingsSchemaResource(request),
    emailAddresses: emailAddressesResource(request),
    // OpenFGA-wire ReBAC stores, models and tuples.
    openfga: openfgaResource(request),
    connectors: connectorsResource(request),
    notifications: notificationsResource(request),
    // The tenant's own custom audit events (distinct from Atlas's auditLogs).
    auditEvents: auditEventsResource(request),
    events: eventsResource(request),
    usage: usageResource(request),
    configChangelog: configChangelogResource(request),
    pca: pcaResource(request),
    mcp: mcpResource(request),
    mcpConnector: mcpConnectorResource(request),
    legacyAuthConnection: legacyAuthConnectionResource(request),
    redirectUrls: redirectUrlsResource(request),
    sessionExchangeApps: sessionExchangeAppsResource(request),
    tickets: ticketsResource(request),
    // Development-instance helpers: the paired test instance, test users, testing tokens.
    testMode: testModeResource(request),
    diagnostics: diagnosticsResource(request),
    // Downstream services that get the same logout_token as your OIDC apps.
    logoutNotifyEndpoints: logoutNotifyEndpointsResource(request),
  };
}

/** Every resource namespace of the management client. */
export type AtlasClientNamespaces = ReturnType<typeof buildNamespaces>;

/** The fully typed client instance `createAtlasClient` returns. */
export interface AtlasClient extends AtlasClientNamespaces {
  /**
   * A copy of this client with some settings changed — e.g.
   * `atlas.withOptions({ strict: true }).users.update(...)` for one strict call.
   */
  withOptions(overrides: AtlasRequestSettings): AtlasClient;
}

export type {
  AtlasClientConfig,
  AtlasRequestSettings,
  UnknownFieldsEvent,
  RawBody,
} from './request';
export { DEFAULT_API_URL } from './request';
export { AtlasErrorCodes, type AtlasErrorCode } from './error';
export { createAtlasPlatformClient } from './platform';
export type { AtlasPlatformClient, AtlasPlatformClientConfig } from './platform';
export { AtlasApiError, type AtlasErrorItem } from './error';
export { paginate, collect } from './paginate';

// Resource types — exported so callers can annotate their own code.
export * from './types';
export * from './users';
export * from './sessions';
export * from './organizations';
export * from './roles';
export * from './oauth-clients';
export * from './resource-servers';
export * from './sso-connections';
export * from './scim-tokens';
export * from './domains';
export * from './waitlist';
export * from './restrictions';
export * from './attack-protection';
export * from './actor-tokens';
export * from './invitations';
export * from './webhooks';
export * from './sign-in-tokens';
export * from './audit-logs';
export * from './jwt-templates';
export * from './api-keys';
export * from './machines';
export * from './oauth-providers';
export * from './sso-onboarding';
export * from './scim-provisioning';
export * from './fga';
export * from './rate-limit';
export * from './risk-based-mfa';
export * from './bot-signals';
export * from './network-acls';
export * from './managed-waf';
export * from './log-streams';
export * from './branding';
export * from './email-templates';
export * from './sms-templates';
export * from './localizations';
export * from './actions';
export * from './billing-plans';
export * from './messaging';
export * from './import-export';
export * from './data-subject-requests';
export * from './radius-clients';
export * from './lti-platforms';
export * from './instance';
export * from './instance-security';
export * from './referrals';
export * from './user-hooks';
export * from './tokens';
export * from './captcha';
export * from './design';
export * from './entitlement-overrides';
export * from './org-ldap-connections';
export * from './organization-settings-schema';
export * from './email-addresses';
export * from './openfga';
export * from './connectors';
export * from './notifications';
export * from './audit-events';
export * from './activity';
export * from './pca';
export * from './mcp';
export * from './legacy-auth';
export * from './redirect-urls';
export * from './session-exchange-apps';
export * from './tickets';
export * from './test-mode';
export * from './diagnostics';
export * from './logout-notify-endpoints';
export * from './platform';
