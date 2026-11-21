import { createRequest, type AtlasClientConfig, type AtlasRequestSettings, type DryRunResult } from './request';
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
import { actorTokensResource, impersonationsResource } from './actor-tokens';
import { invitationsResource } from './invitations';
import { webhooksResource } from './webhooks';
import { appEventsResource } from './app-events';
import { signInTokensResource } from './sign-in-tokens';
import { auditLogsResource } from './audit-logs';
import { jwtTemplatesResource } from './jwt-templates';
import { apiKeysResource } from './api-keys';
import { atlasIdAppsResource } from './atlas-id-apps';
import { appRolesResource } from './app-roles';
import { groupsResource } from './groups';
import { machinesResource } from './machines';
import { grantUsageResource } from './grant-usage';
import { approvalsResource } from './approvals';
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
import { authzExplainResource, fgaSyncResource } from './authz-explain';
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
import { billingDepthResource, entitlementConsumeResource } from './billing-depth';
import { connectionActionsDepthResource, connectionAccessRulesResource, connectionProviderChangesResource } from './connections-depth';
import { billingConnectResource, commerceBillingResource, referralRewardsResource } from './commerce';
import { messagingResource } from './messaging';
import { messageLedgerResource, messageReceiversResource, messagingRoutingResource, suppressionsResource } from './message-ledger';
import { importExportResource } from './import-export';
import { betterAuthImportsResource } from './better-auth-imports';
import { migrationsResource } from './migrations';
import { dataSubjectRequestsResource } from './data-subject-requests';
import { privacyResource } from './privacy';
import { radiusClientsResource } from './radius-clients';
import { mcpGatewaysResource } from './mcp-gateways';
import { agentGovernanceResource, connectionActionsResource, mcpRegistryResource, telemetryExportResource, webBotAuthResource } from './agent-platform';
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
import { gapOpsResources } from './gap-ops';
import { doctor, type DoctorOptions, type DoctorReport } from '../doctor';
import { rateLimitPoliciesResource } from './rate-limit-policies';
import { abuseSignalsResource, orgRoleSetsResource, orgTemplatesResource } from './org-depth';
import { machineTrustPoliciesResource } from './machine-trust-policies';
import { agentDelegationsResource, auditChainResource, sessionBindingsResource, signingKeyScheduleResource } from './trust';
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
import { changesResource } from './changes';
import { stepUpResource } from './step-up';
import { mfaCampaignsResource } from './mfa-campaigns';
import { riskSignalsResource } from './risk-signals';
import { oauthPublishersResource } from './oauth-publishers';
import { usersDepthResource } from './users-depth';
import { complianceDepthResource } from './compliance-depth';
import { configSnapshotsResource } from './devex';
import { dataKeyDrillsResource, deprecationsResource, writeBudgetResource } from './platform-resilience';
import { analyticsResource } from './analytics-reports';
import { appCatalogResource } from './app-catalog';
import { cloudAccessResource, samlIdpResource, wsfedConnectionsResource } from './saml-idp';
import { jwtConnectionsResource } from './jwt-connections';
import { journeysResource } from './journeys';
import { marketingResource } from './marketing';
import { logoutNotifyEndpointsResource } from './logout-notify-endpoints';
import { pcaResource } from './pca';
import { mcpConnectorResource, mcpResource } from './mcp';
import { legacyAuthConnectionResource } from './legacy-auth';
import { redirectUrlsResource } from './redirect-urls';
import { nativeAppsResource } from './native-apps';
import { sessionExchangeAppsResource } from './session-exchange-apps';
import { ticketsResource } from './tickets';
import { testModeResource } from './test-mode';
import { diagnosticsResource } from './diagnostics';
import type { RequestFn } from './request';
import { appCatalogOpsResource } from './app-catalog-ops';
import { ldapServerClientsOpsResource } from './ldap-server-clients-ops';
import { usersOpsResource } from './users-ops';
import { deliveryHealthOpsResource } from './delivery-health-ops';
import { organizationsOpsResource } from './organizations-ops';
import { organizationItAdminResource, ssoConnectionItAdminResource } from './it-admin';
import { instanceOpsResource } from './instance-ops';
import { sessionsOpsResource } from './sessions-ops';
import { sessionsFeedResource } from './sessions-feed';
import { migrationsOpsResource } from './migrations-ops';
import { allowlistIdentifiersOpsResource } from './allowlist-identifiers-ops';
import { blocklistIdentifiersOpsResource } from './blocklist-identifiers-ops';
import { ssoConnectionsOpsResource } from './sso-connections-ops';
import { directoryPullSourcesOpsResource } from './directory-pull-sources-ops';
import { orgLdapConnectionsOpsResource } from './org-ldap-connections-ops';
import { relayAgentsOpsResource } from './relay-agents-ops';
import { oauthClientsOpsResource } from './oauth-clients-ops';
import { oauthClientProfilesOpsResource } from './oauth-client-profiles-ops';
import { listenOpsResource } from './listen-ops';
import { agentRegistrationOpsResource } from './agent-registration-ops';
import { agentsOpsResource } from './agents-ops';
import { agentAccessRequestsOpsResource } from './agent-access-requests-ops';
import { chatIntegrationsOpsResource } from './chat-integrations-ops';
import { administrativeUnitsOpsResource } from './administrative-units-ops';
import { oauthApplicationTypesOpsResource } from './oauth-application-types-ops';
import { organizationConnectionsOpsResource } from './organization-connections-ops';
import { igaOpsResource } from './iga-ops';
import { scimProvisioningPresetsOpsResource } from './scim-provisioning-presets-ops';
import { billingOpsResource } from './billing-ops';
import { connectionsOpsResource } from './connections-ops';
import { connectionLimitsResource, connectionReconnectResource, connectionsActivityResource, providerEventsResource, providerPolicyResource, providerSubscriptionsResource, relayResource } from './connections-extras';
import { fgaOpsResource } from './fga-ops';
import { auditRetentionOpsResource } from './audit-retention-ops';
import { regionOpsResource } from './region-ops';
import { opaOpsResource } from './opa-ops';
import { ssfOpsResource } from './ssf-ops';
import { orgRoleGrantsOpsResource } from './org-role-grants-ops';
import { policyBundlesOpsResource } from './policy-bundles-ops';
import { proxyAppsOpsResource } from './proxy-apps-ops';
import { integrationsOpsResource } from './integrations-ops';

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
    doctor(options: Partial<Omit<DoctorOptions, 'secretKey'>> = {}): Promise<DoctorReport> {
      return doctor({ secretKey: config.secretKey, apiUrl: config.apiUrl, fetch: config.fetch, ...options });
    },
    async dryRun(run: (client: AtlasClient) => Promise<unknown>): Promise<DryRunResult> {
      // Every typed method keeps its own signature; the dry run swaps the answer's type, not the call.
      return (await run(createAtlasClient({ ...config, dryRun: true }))) as DryRunResult;
    },
  };
}

function buildNamespaces(request: RequestFn) {
  const gap = gapOpsResources(request);
  return {
    users: { ...usersResource(request), ...usersOpsResource(request), ...gap.users },
    sessions: { ...sessionsResource(request), ...sessionsOpsResource(request), ...sessionsFeedResource(request), ...gap.sessions },
    organizations: { ...organizationsResource(request), ...organizationsOpsResource(request), ...organizationItAdminResource(request), ...gap.organizations },
    roles: rolesResource(request),
    permissions: permissionsResource(request),
    oauthClients: { ...oauthClientsResource(request), ...oauthClientsOpsResource(request), ...gap.oauthClients },
    passkeyApi: passkeyApiResource(request),
    vc: vcResource(request),
    resourceServers: resourceServersResource(request),
    ssoConnections: { ...ssoConnectionsResource(request), ...ssoConnectionsOpsResource(request), ...ssoConnectionItAdminResource(request) },
    scimTokens: scimTokensResource(request),
    scimResourceTypes: scimResourceTypesResource(request),
    domains: domainsResource(request),
    waitlist: waitlistResource(request),
    allowlist: { ...allowlistResource(request), ...allowlistIdentifiersOpsResource(request) },
    blocklist: { ...blocklistResource(request), ...blocklistIdentifiersOpsResource(request) },
    attackProtection: attackProtectionResource(request),
    // HOTP, Yubico OTP, Duo, smart card and security-question administration.
    mfaFactors: mfaFactorsResource(request),
    actorTokens: actorTokensResource(request),
    impersonations: impersonationsResource(request),
    invitations: invitationsResource(request),
    webhooks: webhooksResource(request),
    // Application webhooks: your own events, sent to your customers' (organizations') endpoints.
    appEvents: appEventsResource(request),
    signInTokens: signInTokensResource(request),
    auditLogs: auditLogsResource(request),
    jwtTemplates: jwtTemplatesResource(request),
    apiKeys: apiKeysResource(request),
    // Sign in with Atlas apps this instance manages; adopt one with a code its owner issued.
    atlasIdApps: atlasIdAppsResource(request),
    // App-level (instance-wide) user roles and permissions.
    appRoles: appRolesResource(request),
    groups: groupsResource(request),
    // §9.3 / §P1-7 named machine identities + device registry + enrolment tokens.
    machines: machinesResource(request),
    // Atomic usage counters on machine and agent grants.
    grantUsage: grantUsageResource(request),
    // Approval requests v2: lifetime, N-of-M approvers, signed receipts.
    approvals: approvalsResource(request),
    oauthProviders: oauthProvidersResource(request),
    ssoOnboarding: ssoOnboardingResource(request),
    scimProvisioning: scimProvisioningResource(request),
    fga: { ...fgaResource(request), ...fgaOpsResource(request), ...fgaSyncResource(request) },
    rateLimitPolicy: rateLimitPolicyResource(request),
    riskBasedMfa: riskBasedMfaResource(request),
    riskEvents: riskEventsResource(request),
    ssf: { ...ssfResource(request), ...ssfOpsResource(request) },
    ...oauthProtocolsResource(request),
    managedGrants: managedGrantsResource(request),
    leastPrivilege: leastPrivilegeResource(request),
    botSignals: botSignalsResource(request),
    networkAcls: networkAclsResource(request),
    networkZones: networkZonesResource(request),
    accessPolicies: accessPoliciesResource(request),
    abac: abacResource(request),
    authzDecisions: authzDecisionsResource(request),
    authz: authzExplainResource(request),
    policyBundles: { ...policyBundlesResource(request), ...policyBundlesOpsResource(request) },
    resources: resourcesResource(request),
    orgRoleGrants: { ...orgRoleGrantsResource(request), ...orgRoleGrantsOpsResource(request) },
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
    securityAdvisories: { ...securityAdvisoriesResource(request), ...gap.securityAdvisories },
    oauthGrants: gap.oauthGrants,
    passkeyCampaigns: gap.passkeyCampaigns,
    dev: gap.dev,
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
    messages: messageLedgerResource(request),
    suppressions: suppressionsResource(request),
    messageReceivers: messageReceiversResource(request),
    billing: { ...billingResource(request), ...billingOpsResource(request), ...billingDepthResource(request), ...commerceBillingResource(request) },
    billingConnect: billingConnectResource(request),
    referralRewards: referralRewardsResource(request),
    messaging: { ...messagingResource(request), ...messagingRoutingResource(request) },
    importExport: importExportResource(request),
    // Migrate from Better Auth: sealed-bundle upload, dry run and resumable apply.
    betterAuthImports: betterAuthImportsResource(request),
    // Migrate from any source: /v1/migrations/{source}/imports, the zero-logout bridge, the source catalog.
    migrations: { ...migrationsResource(request), ...migrationsOpsResource(request), ...gap.migrations },
    dataSubjectRequests: dataSubjectRequestsResource(request),
    /** The data-rights executor protocol and the instance's orchestrator. */
    privacy: privacyResource(request),
    radiusClients: radiusClientsResource(request),
    /** MCP tool gateway: per-tool policy in front of an MCP server. */
    mcpGateways: mcpGatewaysResource(request),
    /** Typed actions over connections, provider event triggers, scoped relay tokens, usage records. */
    connectionActions: { ...connectionActionsResource(request), ...connectionActionsDepthResource(request) },
    connectionProviderChanges: connectionProviderChangesResource(request),
    connectionAccessRules: connectionAccessRulesResource(request),
    /** Agent sponsors, expiry and renewal, activity log, access reviews. */
    agentGovernance: agentGovernanceResource(request),
    webBotAuth: webBotAuthResource(request),
    /** Approved upstream MCP servers and admin-MCP write elevations. */
    mcpRegistry: mcpRegistryResource(request),
    /** OTLP export of gateway and relay calls. */
    telemetryExport: telemetryExportResource(request),
    ltiPlatforms: ltiPlatformsResource(request),
    instance: { ...instanceResource(request), ...instanceOpsResource(request), ...gap.instance },
    // Identity integrations, the integration-facing side: verify-error reports, sidebar cards, public metadata.
    integrations: { ...integrationsResource(request), ...integrationsOpsResource(request), ...gap.integrations },
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
    rateLimitPolicies: rateLimitPoliciesResource(request),
    orgRoleSets: orgRoleSetsResource(request),
    orgTemplates: orgTemplatesResource(request),
    abuseSignals: abuseSignalsResource(request),
    machineTrustPolicies: machineTrustPoliciesResource(request),
    signingKeySchedule: signingKeyScheduleResource(request),
    auditChain: auditChainResource(request),
    sessionBindings: sessionBindingsResource(request),
    agentDelegations: agentDelegationsResource(request),
    entitlements: { ...entitlementsResource(request), ...entitlementConsumeResource(request) },
    orgLdapConnections: { ...orgLdapConnectionsResource(request), ...orgLdapConnectionsOpsResource(request) },
    organizationSettingsSchema: organizationSettingsSchemaResource(request),
    emailAddresses: emailAddressesResource(request),
    // OpenFGA-wire ReBAC stores, models and tuples.
    openfga: openfgaResource(request),
    connectors: connectorsResource(request),
    // Org- or user-owned provider connections that own their tokens, per-owner OAuth clients, token reads.
    connections: { ...connectionsResource(request), ...connectionsOpsResource(request), ...connectionsActivityResource(request), ...gap.connections },
    /** `POST /v1/connections/{id}/relay`, its size limits and the on-prem relay agents. */
    relay: relayResource(request),
    /** Business topics and per-connection provider subscriptions. */
    providerSubscriptions: providerSubscriptionsResource(request),
    /** Per-provider connection policy (one account per owner, the notice secret). */
    providerPolicy: providerPolicyResource(request),
    /** Persisted provider events: read back and replay. */
    providerEvents: providerEventsResource(request),
    /** Relay size limits and token-read rate limits. */
    connectionLimits: connectionLimitsResource(request),
    /** Hosted reconnect settings and links. */
    connectionReconnect: connectionReconnectResource(request),
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
    iga: { ...igaResource(request), ...igaOpsResource(request) },
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
    /** The change feed: ordered changes to users, organizations, memberships, keys and machines. */
    changes: changesResource(request),
    /** Named step-up policies and the assertion a resource server asks before a sensitive action. */
    stepUp: stepUpResource(request),
    /** MFA rollout campaigns: target, deadline, nag interval, enforcement. */
    mfaCampaigns: mfaCampaignsResource(request),
    /** Your own risk signals for users and IPs, and the risk-policy what-if replay. */
    riskSignals: riskSignalsResource(request),
    /** Bulk user actions, legal holds, deletion receipts and deadlines, deleted-address import, tenant export and import. */
    ...usersDepthResource(request),
    /** Age assurance, signed compliance reports, the data rights console, downstream erasure connectors, the cookie consent store, policy audience and translations, and translation review. */
    ...complianceDepthResource(request),
    /** Config time travel: save, list, diff and restore snapshots of the instance's configuration. */
    configSnapshots: configSnapshotsResource(request),
    /** Per-instance write budgets: limits, observe/enforce mode, and recent overruns. */
    writeBudget: writeBudgetResource(request),
    /** Deprecated routes and fields with their sunset dates, and which ones this instance still uses. */
    deprecations: deprecationsResource(request),
    /** Rotation drills for the customer-managed data key (a dry-run re-wrap). */
    dataKeyDrills: dataKeyDrillsResource(request),
    usage: usageResource(request),
    analytics: analyticsResource(request),
    appCatalog: { ...appCatalogResource(request), ...appCatalogOpsResource(request) },
    samlIdp: samlIdpResource(request),
    cloudAccess: cloudAccessResource(request),
    wsfedConnections: wsfedConnectionsResource(request),
    jwtConnections: jwtConnectionsResource(request),
    journeys: journeysResource(request),
    marketing: marketingResource(request),
    configChangelog: configChangelogResource(request),
    pca: pcaResource(request),
    mcp: mcpResource(request),
    mcpConnector: mcpConnectorResource(request),
    legacyAuthConnection: legacyAuthConnectionResource(request),
    redirectUrls: redirectUrlsResource(request),
    nativeApps: nativeAppsResource(request),
    sessionExchangeApps: sessionExchangeAppsResource(request),
    tickets: ticketsResource(request),
    // Development-instance helpers: the paired test instance, test users, testing tokens.
    testMode: testModeResource(request),
    diagnostics: { ...diagnosticsResource(request), ...gap.diagnostics },
    // Downstream services that get the same logout_token as your OIDC apps.
    logoutNotifyEndpoints: logoutNotifyEndpointsResource(request),
    // Operations added for full Backend API coverage (new areas; existing areas gained methods in place).
    ldapServerClients: ldapServerClientsOpsResource(request),
    deliveryHealth: deliveryHealthOpsResource(request),
    directoryPullSources: directoryPullSourcesOpsResource(request),
    relayAgents: relayAgentsOpsResource(request),
    oauthClientProfiles: oauthClientProfilesOpsResource(request),
    listen: listenOpsResource(request),
    agentRegistration: agentRegistrationOpsResource(request),
    agents: agentsOpsResource(request),
    agentAccessRequests: agentAccessRequestsOpsResource(request),
    chatIntegrations: chatIntegrationsOpsResource(request),
    administrativeUnits: administrativeUnitsOpsResource(request),
    oauthApplicationTypes: oauthApplicationTypesOpsResource(request),
    organizationConnections: organizationConnectionsOpsResource(request),
    scimProvisioningPresets: scimProvisioningPresetsOpsResource(request),
    auditRetention: auditRetentionOpsResource(request),
    region: regionOpsResource(request),
    opa: opaOpsResource(request),
    proxyApps: proxyAppsOpsResource(request),
    oauthPublishers: oauthPublishersResource(request),
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
  /**
   * Run any typed write as a dry run and get a typed {@link DryRunResult} instead of the method's
   * own return type: `const plan = await atlas.dryRun((c) => c.users.update(id, { first_name: 'A' }))`.
   * Nothing changes; `plan.changes` lists what would, and `plan.would_return` is what the real call returns.
   */
  dryRun(run: (client: AtlasClient) => Promise<unknown>): Promise<DryRunResult>;
  /** Check the key, the clock, the Backend API, the JWKS, the service status and the configuration. Never throws. */
  doctor(options?: Partial<Omit<DoctorOptions, 'secretKey'>>): Promise<DoctorReport>;
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
export * from './org-depth';
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
export * from './atlas-id-apps';
export * from './machines';
export * from './machine-trust-policies';
export * from './trust';
export * from './grant-usage';
export * from './approvals';
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
export * from './authz-explain';
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
export * from './message-ledger';
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
export * from './jwt-connections';
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
export * from './changes';
export * from './step-up';
export * from './mfa-campaigns';
export * from './risk-signals';
export * from './users-depth';
export * from './compliance-depth';
export * from './devex';
export * from './platform-resilience';
export * from './app-catalog-ops';
export * from './ldap-server-clients-ops';
export * from './users-ops';
export * from './delivery-health-ops';
export * from './organizations-ops';
export * from './it-admin';
export * from './instance-ops';
export * from './sessions-ops';
export * from './sessions-feed';
export * from './migrations-ops';
export * from './allowlist-identifiers-ops';
export * from './blocklist-identifiers-ops';
export * from './sso-connections-ops';
export * from './directory-pull-sources-ops';
export * from './org-ldap-connections-ops';
export * from './relay-agents-ops';
export * from './oauth-clients-ops';
export * from './oauth-client-profiles-ops';
export * from './listen-ops';
export * from './agent-registration-ops';
export * from './agents-ops';
export * from './agent-access-requests-ops';
export * from './chat-integrations-ops';
export * from './administrative-units-ops';
export * from './oauth-application-types-ops';
export * from './organization-connections-ops';
export * from './iga-ops';
export * from './scim-provisioning-presets-ops';
export * from './billing-ops';
export * from './billing-depth';
export * from './commerce';
export * from './connections-depth';
export * from './connections-ops';
export * from './connections-extras';
export * from './fga-ops';
export * from './audit-retention-ops';
export * from './region-ops';
export * from './opa-ops';
export * from './ssf-ops';
export * from './org-role-grants-ops';
export * from './policy-bundles-ops';
export * from './proxy-apps-ops';
export * from './integrations-ops';
export * from './oauth-publishers';
export * from './gap-ops';
export * from './gap-fields';
export * from './resilience';
