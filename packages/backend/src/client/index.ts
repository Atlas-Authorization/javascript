import { createRequest, type AtlasClientConfig, type AtlasRequestSettings } from './request';
import { usersResource } from './users';
import { sessionsResource } from './sessions';
import { organizationsResource } from './organizations';
import { permissionsResource, rolesResource } from './roles';
import { oauthClientsResource } from './oauth-clients';
import { passkeyApiResource } from './passkey-api';
import { vcResource } from './vc';
import { resourceServersResource } from './resource-servers';
import { ssoConnectionsResource } from './sso-connections';
import { scimResourceTypesResource, scimTokensResource } from './scim-tokens';
import { domainsResource } from './domains';
import { waitlistResource } from './waitlist';
import { allowlistResource, blocklistResource } from './restrictions';
import { attackProtectionResource } from './attack-protection';
import { mfaFactorsResource } from './mfa-factors';
import { actorTokensResource } from './actor-tokens';
import { invitationsResource } from './invitations';
import { webhooksResource } from './webhooks';
import { appEventsResource } from './app-events';
import { signInTokensResource } from './sign-in-tokens';
import { auditLogsResource } from './audit-logs';
import { jwtTemplatesResource } from './jwt-templates';
import { apiKeysResource } from './api-keys';
import { appRolesResource } from './app-roles';
import { groupsResource } from './groups';
import { machinesResource } from './machines';
import { oauthProvidersResource } from './oauth-providers';
import { ssoOnboardingResource } from './sso-onboarding';
import { scimProvisioningResource } from './scim-provisioning';
import { fgaResource } from './fga';
import { rateLimitPolicyResource } from './rate-limit';
import { riskBasedMfaResource, riskEventsResource } from './risk-based-mfa';
import { ssfResource } from './ssf';
import { oauthProtocolsResource } from './oauth-protocols';
import { managedGrantsResource } from './managed-grants';
import { leastPrivilegeResource } from './least-privilege';
import { botSignalsResource } from './bot-signals';
import { networkAclsResource } from './network-acls';
import { networkZonesResource } from './network-zones';
import { accessPoliciesResource } from './access-policies';
import { abacResource } from './abac';
import { authzDecisionsResource } from './authz-decisions';
import { policyBundlesResource } from './policy-bundles';
import { resourcesResource } from './resources';
import { orgRoleGrantsResource } from './org-role-grants';
import { deviceAssurancePoliciesResource, deviceIntegrationsResource, devicesResource } from './devices';
import { authenticatorPoliciesResource, emailRiskResource, riskResource, temporaryAccessResource } from './risk-containment';
import { managedWafResource } from './managed-waf';
import { logStreamsResource } from './log-streams';
import { auditExportsResource, noticesResource, securityAdvisoriesResource, subProcessorsResource } from './compliance';
import { brandingResource } from './branding';
import { emailTemplatesResource } from './email-templates';
import { smsTemplatesResource } from './sms-templates';
import { localizationsResource } from './localizations';
import { actionsResource } from './actions';
import { workflowsResource } from './workflows';
import { pageTemplatesResource } from './page-templates';
import { actionGalleryResource, actionTemplatesResource } from './action-gallery';
import { billingResource } from './billing-plans';
import { messagingResource } from './messaging';
import { importExportResource } from './import-export';
import { betterAuthImportsResource } from './better-auth-imports';
import { migrationsResource } from './migrations';
import { dataSubjectRequestsResource } from './data-subject-requests';
import { privacyResource } from './privacy';
import { radiusClientsResource } from './radius-clients';
import { mcpGatewaysResource } from './mcp-gateways';
import { agentGovernanceResource, connectionActionsResource, mcpRegistryResource, telemetryExportResource } from './agent-platform';
import { ltiPlatformsResource } from './lti-platforms';
import { instanceResource } from './instance';
import { integrationsResource } from './integrations';
import { instanceSecurityResource } from './instance-security';
import { referralsResource } from './referrals';
import { policiesResource, policySourceResource } from './policies';
import { statusResource } from './status';
import { userHooksResource } from './user-hooks';
import { tokensResource } from './tokens';
import { captchaResource } from './captcha';
import { designResource } from './design';
import { entitlementOverridesResource, entitlementsResource } from './entitlement-overrides';
import { orgLdapConnectionsResource } from './org-ldap-connections';
import { organizationSettingsSchemaResource } from './organization-settings-schema';
import { emailAddressesResource } from './email-addresses';
import { openfgaResource } from './openfga';
import { connectorsResource } from './connectors';
import { connectionsResource } from './connections';
import { customOAuthProvidersResource } from './custom-oauth-providers';
import { notificationsResource } from './notifications';
import { auditEventsResource, auditEventSchemasResource } from './audit-events';
import { vaultResource } from './vault';
import { serviceConnectorsResource } from './service-connectors';
import { desktopMfaResource } from './desktop-mfa';
import { identityVerificationResource } from './identity-verification';
import { igaResource } from './iga';
import { flagsResource } from './flags';
import {
  atlasIdGrantsResource,
  keysResource,
  partnerLinksResource,
  secretKeysResource,
  whoamiResource,
} from './credentials';
import { partnerPlatformsResource } from './partner-platforms';
import { configChangelogResource, eventsResource, usageResource } from './activity';
import { analyticsResource } from './analytics-reports';
import { appCatalogResource } from './app-catalog';
import { cloudAccessResource, samlIdpResource, wsfedConnectionsResource } from './saml-idp';
import { journeysResource } from './journeys';
import { marketingResource } from './marketing';
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
    passkeyApi: passkeyApiResource(request),
    vc: vcResource(request),
    resourceServers: resourceServersResource(request),
    ssoConnections: ssoConnectionsResource(request),
    scimTokens: scimTokensResource(request),
    scimResourceTypes: scimResourceTypesResource(request),
    domains: domainsResource(request),
    waitlist: waitlistResource(request),
    allowlist: allowlistResource(request),
    blocklist: blocklistResource(request),
    attackProtection: attackProtectionResource(request),
    // HOTP, Yubico OTP, Duo, smart card and security-question administration.
    mfaFactors: mfaFactorsResource(request),
    actorTokens: actorTokensResource(request),
    invitations: invitationsResource(request),
    webhooks: webhooksResource(request),
    // Application webhooks: your own events, sent to your customers' (organizations') endpoints.
    appEvents: appEventsResource(request),
    signInTokens: signInTokensResource(request),
    auditLogs: auditLogsResource(request),
    jwtTemplates: jwtTemplatesResource(request),
    apiKeys: apiKeysResource(request),
    // App-level (instance-wide) user roles and permissions.
    appRoles: appRolesResource(request),
    groups: groupsResource(request),
    // §9.3 / §P1-7 named machine identities + device registry + enrolment tokens.
    machines: machinesResource(request),
    oauthProviders: oauthProvidersResource(request),
    ssoOnboarding: ssoOnboardingResource(request),
    scimProvisioning: scimProvisioningResource(request),
    fga: fgaResource(request),
    rateLimitPolicy: rateLimitPolicyResource(request),
    riskBasedMfa: riskBasedMfaResource(request),
    riskEvents: riskEventsResource(request),
    ssf: ssfResource(request),
    ...oauthProtocolsResource(request),
    managedGrants: managedGrantsResource(request),
    leastPrivilege: leastPrivilegeResource(request),
    botSignals: botSignalsResource(request),
    networkAcls: networkAclsResource(request),
    networkZones: networkZonesResource(request),
    accessPolicies: accessPoliciesResource(request),
    abac: abacResource(request),
    authzDecisions: authzDecisionsResource(request),
    policyBundles: policyBundlesResource(request),
    resources: resourcesResource(request),
    orgRoleGrants: orgRoleGrantsResource(request),
    devices: devicesResource(request),
    deviceAssurancePolicies: deviceAssurancePoliciesResource(request),
    deviceIntegrations: deviceIntegrationsResource(request),
    // Risky users, account containment and risky-factor quarantine.
    ...riskResource(request),
    temporaryAccess: temporaryAccessResource(request),
    emailRisk: emailRiskResource(request),
    authenticatorPolicies: authenticatorPoliciesResource(request),
    managedWaf: managedWafResource(request),
    logStreams: logStreamsResource(request),
    // Instance audit export: CloudEvents to a webhook or an S3-compatible bucket.
    auditExports: auditExportsResource(request),
    // Behaviour changes that affect this instance, and security advisories.
    notices: noticesResource(request),
    securityAdvisories: securityAdvisoriesResource(request),
    // Who processes this instance's end-user data, in which role.
    subProcessors: subProcessorsResource(request),
    branding: brandingResource(request),
    emailTemplates: emailTemplatesResource(request),
    smsTemplates: smsTemplatesResource(request),
    localizations: localizationsResource(request),
    actions: actionsResource(request),
    workflows: workflowsResource(request),
    pageTemplates: pageTemplatesResource(request),
    actionGallery: actionGalleryResource(request),
    actionTemplates: actionTemplatesResource(request),
    billing: billingResource(request),
    messaging: messagingResource(request),
    importExport: importExportResource(request),
    // Migrate from Better Auth: sealed-bundle upload, dry run and resumable apply.
    betterAuthImports: betterAuthImportsResource(request),
    // Migrate from any source: /v1/migrations/{source}/imports, the zero-logout bridge, the source catalog.
    migrations: migrationsResource(request),
    dataSubjectRequests: dataSubjectRequestsResource(request),
    /** The data-rights executor protocol and the instance's orchestrator. */
    privacy: privacyResource(request),
    radiusClients: radiusClientsResource(request),
    /** MCP tool gateway: per-tool policy in front of an MCP server. */
    mcpGateways: mcpGatewaysResource(request),
    /** Typed actions over connections, provider event triggers, scoped relay tokens, usage records. */
    connectionActions: connectionActionsResource(request),
    /** Agent sponsors, expiry and renewal, activity log, access reviews. */
    agentGovernance: agentGovernanceResource(request),
    /** Approved upstream MCP servers and admin-MCP write elevations. */
    mcpRegistry: mcpRegistryResource(request),
    /** OTLP export of gateway and relay calls. */
    telemetryExport: telemetryExportResource(request),
    ltiPlatforms: ltiPlatformsResource(request),
    instance: instanceResource(request),
    // Identity integrations, the integration-facing side: verify-error reports, sidebar cards, public metadata.
    integrations: integrationsResource(request),
    instanceSecurity: instanceSecurityResource(request),
    // Referral attribution: the instance's referral platform connection and call log.
    referrals: referralsResource(request),
    // Policy acceptance: policies, versions, acceptances, settings, and the external policy source.
    policies: policiesResource(request),
    policySource: policySourceResource(request),
    // Atlas service status: the incident subscription, incidents that concern you, upstream status pages.
    status: statusResource(request),
    // The before_user_create hook (sets external_id before the user exists).
    userHooks: userHooksResource(request),
    tokens: tokensResource(request),
    // §5 "captcha anywhere" — verify any CAPTCHA token against the instance's
    // centrally-configured provider, server-side, with the secret held by Atlas.
    captcha: captchaResource(request),
    // Sign-in page design: instance + per-organization overrides, images, catalog.
    design: designResource(request),
    entitlementOverrides: entitlementOverridesResource(request),
    entitlements: entitlementsResource(request),
    orgLdapConnections: orgLdapConnectionsResource(request),
    organizationSettingsSchema: organizationSettingsSchemaResource(request),
    emailAddresses: emailAddressesResource(request),
    // OpenFGA-wire ReBAC stores, models and tuples.
    openfga: openfgaResource(request),
    connectors: connectorsResource(request),
    // Org- or user-owned provider connections that own their tokens, per-owner OAuth clients, token reads.
    connections: connectionsResource(request),
    customOAuthProviders: customOAuthProvidersResource(request),
    notifications: notificationsResource(request),
    // The tenant's own custom audit events (distinct from Atlas's auditLogs).
    auditEvents: auditEventsResource(request),
    auditEventSchemas: auditEventSchemasResource(request),
    vault: vaultResource(request),
    // Typed connectors to messaging, CRM, analytics, fraud and identity-verification services.
    serviceConnectors: serviceConnectorsResource(request),
    desktopMfa: desktopMfaResource(request),
    // Document and selfie identity checks through your own verification service.
    identityVerification: identityVerificationResource(request),
    // Identity governance: catalog, access requests and approvals, certification campaigns, separation of duties, joiner/mover/leaver.
    iga: igaResource(request),
    flags: flagsResource(request),
    // The key this client uses, the instance's secret keys, and every credential on it.
    whoami: whoamiResource(request),
    secretKeys: secretKeysResource(request),
    keys: keysResource(request),
    // Partner links: products allowed to call this instance, and links partners granted Atlas.
    partnerLinks: partnerLinksResource(request),
    // This instance as a partner platform of another product (signed consent deliveries in).
    partnerPlatforms: partnerPlatformsResource(request),
    // Sign in with Atlas grants of apps this instance manages (DSAR erasure).
    atlasIdGrants: atlasIdGrantsResource(request),
    events: eventsResource(request),
    usage: usageResource(request),
    analytics: analyticsResource(request),
    appCatalog: appCatalogResource(request),
    samlIdp: samlIdpResource(request),
    cloudAccess: cloudAccessResource(request),
    wsfedConnections: wsfedConnectionsResource(request),
    journeys: journeysResource(request),
    marketing: marketingResource(request),
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
  DryRunChange,
  DryRunResult,
} from './request';
export { DEFAULT_API_URL } from './request';
export { API_BASE_ENV_NAMES, apiBaseFromEnv, atlasConfigFromEnv, createAtlasClientFromEnv } from './env';
export { AtlasErrorCodes, type AtlasErrorCode } from './error';
export { createAtlasPlatformClient } from './platform';
export type { AtlasPlatformClient, AtlasPlatformClientConfig } from './platform';
export { AtlasApiError, type AtlasErrorItem } from './error';
export { paginate, collect } from './paginate';

// Resource types — exported so callers can annotate their own code.
export * from './types';
export * from './compliance';
export * from './vault';
export * from './service-connectors';
export * from './desktop-mfa';
export * from './identity-verification';
export * from './iga';
export * from './flags';
export * from './users';
export * from './sessions';
export * from './organizations';
export * from './app-events';
export * from './roles';
export * from './app-roles';
export * from './groups';
export * from './oauth-clients';
export * from './resource-servers';
export * from './sso-connections';
export * from './scim-tokens';
export * from './domains';
export * from './waitlist';
export * from './restrictions';
export * from './attack-protection';
export * from './mfa-factors';
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
export * from './ssf';
export * from './oauth-protocols';
export * from './managed-grants';
export * from './least-privilege';
export * from './bot-signals';
export * from './network-acls';
export * from './network-zones';
export * from './access-policies';
export * from './abac';
export * from './authz-decisions';
export * from './policy-bundles';
export * from './resources';
export * from './org-role-grants';
export * from './devices';
export * from './risk-containment';
export * from './managed-waf';
export * from './log-streams';
export * from './branding';
export * from './email-templates';
export * from './sms-templates';
export * from './localizations';
export * from './actions';
export * from './page-templates';
export * from './workflows';
export * from './action-gallery';
export * from './billing-plans';
export * from './messaging';
export * from './import-export';
export * from './better-auth-imports';
export * from './migrations';
export * from './data-subject-requests';
export * from './privacy';
export * from './radius-clients';
export * from './mcp-gateways';
export * from './agent-platform';
export * from './lti-platforms';
export * from './instance';
export * from './integrations';
export * from './instance-security';
export * from './referrals';
export * from './policies';
export * from './status';
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
export * from './connections';
export * from './passkey-api';
export * from './delegated-ui-proxy';
export * from './vc';
export * from './custom-oauth-providers';
export * from './notifications';
export * from './audit-events';
export * from './activity';
export * from './analytics-reports';
export * from './app-catalog';
export * from './saml-idp';
export * from './journeys';
export * from './marketing';
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
export * from './credentials';
export * from './partner-platforms';
export * from './operator';
