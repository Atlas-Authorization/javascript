import { describe, expect, it, vi } from 'vitest';
import { createAtlasClient, createAtlasPlatformClient } from './index';

const API_URL = 'https://api.example.test';

function mockFetch(body: unknown = { object: 'x' }) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }> =
    [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = v as string;
    calls.push({ url: String(url), method: init?.method ?? 'GET', headers, body: init?.body });
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

type Bapi = ReturnType<typeof createAtlasClient>;
type Plat = ReturnType<typeof createAtlasPlatformClient>;

const MOVE = { from: 'https://old.example.com', to: 'https://new.example.com', dry_run: true };

// [method, path+query, expected JSON body (undefined = none), call]
const BAPI: Array<[string, string, unknown, (c: Bapi) => Promise<unknown>]> = [
  ['POST', '/v1/instance/move_origin', MOVE, (c) => c.instance.moveOrigin(MOVE)],
  ['GET', '/v1/instance/sign_in_with_atlas', undefined, (c) => c.instance.signInWithAtlas.get()],
  ['PATCH', '/v1/instance/sign_in_with_atlas', { enabled: true, connection_id: 'ssoc_1' }, (c) => c.instance.signInWithAtlas.update({ enabled: true, connection_id: 'ssoc_1' })],
  ['GET', '/v1/instance/hosted_pages', undefined, (c) => c.instance.hostedPages.get()],
  ['PATCH', '/v1/instance/hosted_pages', { sign_in_url: 'https://app.example.com/login' }, (c) => c.instance.hostedPages.update({ sign_in_url: 'https://app.example.com/login' })],
  ['GET', '/v1/federation', undefined, (c) => c.federation.get()],
  ['POST', '/v1/federation/resolve', { entity_id: 'https://rp.example.com' }, (c) => c.federation.resolve({ entity_id: 'https://rp.example.com' })],
  ['GET', '/v1/vc/deferred?status=pending', undefined, (c) => c.vc.deferred.list({ status: 'pending' })],
  ['POST', '/v1/vc/deferred/vcdef_1/approve', {}, (c) => c.vc.deferred.approve('vcdef_1')],
  ['POST', '/v1/vc/deferred/vcdef_1/deny', { reason: 'no' }, (c) => c.vc.deferred.deny('vcdef_1', { reason: 'no' })],
  ['GET', '/v1/vc/presentation_requests/vcpr_1/dc_api_request', undefined, (c) => c.vc.presentationRequests.dcApiRequest('vcpr_1')],
  ['GET', '/v1/grant_management/grants?user_id=user_1&status=active', undefined, (c) => c.managedGrants.list({ user_id: 'user_1', status: 'active' })],
  ['GET', '/v1/grant_management/grants/gnt_1', undefined, (c) => c.managedGrants.get('gnt_1')],
  ['PATCH', '/v1/grant_management/grants/gnt_1', { scopes: ['openid'] }, (c) => c.managedGrants.narrow('gnt_1', { scopes: ['openid'] })],
  ['DELETE', '/v1/grant_management/grants/gnt_1', undefined, (c) => c.managedGrants.revoke('gnt_1')],
  ['GET', '/v1/least_privilege/report?days=14&only_unused=true', undefined, (c) => c.leastPrivilege.report({ days: 14, only_unused: true })],
  ['GET', '/v1/least_privilege/report/api_key/key_1?days=30', undefined, (c) => c.leastPrivilege.get('api_key', 'key_1', { days: 30 })],
  ['GET', '/v1/least_privilege/report?format=csv', undefined, (c) => c.leastPrivilege.exportCsv()],
  ['POST', '/v1/least_privilege/apply', { subject_type: 'api_key', subject_id: 'key_1', digest: 'd' }, (c) => c.leastPrivilege.apply({ subject_type: 'api_key', subject_id: 'key_1', digest: 'd' })],
  ['POST', '/v1/least_privilege/apply?dry_run=true', { subject_type: 'api_key', subject_id: 'key_1', digest: 'd' }, (c) => c.leastPrivilege.apply({ subject_type: 'api_key', subject_id: 'key_1', digest: 'd' }, { dryRun: true })],
  ['GET', '/v1/mcp_gateways/mgw_1/budgets', undefined, (c) => c.mcpGateways.budgets.list('mgw_1')],
  ['POST', '/v1/mcp_gateways/mgw_1/budgets', { name: 'n', metric: 'calls', limit: 3 }, (c) => c.mcpGateways.budgets.create('mgw_1', { name: 'n', metric: 'calls', limit: 3 })],
  ['PATCH', '/v1/mcp_gateways/mgw_1/budgets/mgb_1', { limit: 9 }, (c) => c.mcpGateways.budgets.update('mgw_1', 'mgb_1', { limit: 9 })],
  ['DELETE', '/v1/mcp_gateways/mgw_1/budgets/mgb_1', undefined, (c) => c.mcpGateways.budgets.delete('mgw_1', 'mgb_1')],
  ['GET', '/v1/mcp_gateways/mgw_1/budgets/mgb_1/usage?agent_id=mch_1', undefined, (c) => c.mcpGateways.budgets.usage('mgw_1', 'mgb_1', { agent_id: 'mch_1' })],
  ['PATCH', '/v1/mcp_gateways/mgw_1', { abac: { enabled: true } }, (c) => c.mcpGateways.update('mgw_1', { abac: { enabled: true } })],
  ['GET', '/v1/status', undefined, (c) => c.status.service()],
  ['GET', '/v1/instance/status_subscription', undefined, (c) => c.status.getSubscription()],
  ['PUT', '/v1/instance/status_subscription', { regions: ['eu'], min_impact: 'major' }, (c) => c.status.updateSubscription({ regions: ['eu'], min_impact: 'major' })],
  ['DELETE', '/v1/instance/status_subscription', undefined, (c) => c.status.disableSubscription()],
  ['POST', '/v1/instance/status_subscription/rotate_feed', undefined, (c) => c.status.rotateFeed()],
  ['GET', '/v1/instance/status_incidents?open=true&limit=5', undefined, (c) => c.status.listIncidents({ open: true, limit: 5 })],
  ['GET', '/v1/instance/status_dependencies', undefined, (c) => c.status.listDependencies()],
  ['POST', '/v1/instance/status_dependencies', { name: 'Mail', url: 'https://status.example.com' }, (c) => c.status.createDependency({ name: 'Mail', url: 'https://status.example.com' })],
  ['GET', '/v1/instance/status_dependencies/sdep_1', undefined, (c) => c.status.getDependency('sdep_1')],
  ['PATCH', '/v1/instance/status_dependencies/sdep_1', { component_filter: ['SMTP'] }, (c) => c.status.updateDependency('sdep_1', { component_filter: ['SMTP'] })],
  ['DELETE', '/v1/instance/status_dependencies/sdep_1', undefined, (c) => c.status.deleteDependency('sdep_1')],
  ['POST', '/v1/instance/status_dependencies/sdep_1/refresh', undefined, (c) => c.status.refreshDependency('sdep_1')],
  ['GET', '/v1/integration-health', undefined, (c) => c.instance.integrationHealth()],
  ['GET', '/v1/integration-health?only=webhooks%2Cemail&probe=false', undefined, (c) => c.instance.integrationHealth({ only: ['webhooks', 'email'], probe: false })],
  ['GET', '/v1/integration-health/providers', undefined, (c) => c.instance.integrationHealthProviders()],
  ['GET', '/v1/embed?instance=ins_1&shape=button', undefined, (c) => c.instance.embed({ instance: 'ins_1', shape: 'button' })],
  ['PUT', '/v1/instance/design', { brand_url: 'https://example.com/brand.json' }, (c) => c.design.importBrand({ brandUrl: 'https://example.com/brand.json' })],
  ['PUT', '/v1/instance/design', { brand: null }, (c) => c.design.importBrand({ brand: null })],
  ['GET', '/v1/instance/signing_keys', undefined, (c) => c.instanceSecurity.listSigningKeys()],
  ['POST', '/v1/instance/signing_keys/rotate', { alg: 'ES256', grace_period_seconds: 600 }, (c) => c.instanceSecurity.rotateSigningKey({ alg: 'ES256', grace_period_seconds: 600 })],
  ['PUT', '/v1/oauth_clients/oac_1/delegated_ui', { login_url: 'https://a.test/l' }, (c) => c.oauthClients.setDelegatedUi('oac_1', { login_url: 'https://a.test/l' })],
  ['GET', '/v1/oauth_login_requests?login_challenge=lc', undefined, (c) => c.oauthClients.loginRequests.get('lc')],
  ['PUT', '/v1/oauth_login_requests/accept?login_challenge=lc', { subject: 'usr_1' }, (c) => c.oauthClients.loginRequests.accept('lc', { subject: 'usr_1' })],
  ['PUT', '/v1/oauth_consent_requests/reject?consent_challenge=cc', {}, (c) => c.oauthClients.consentRequests.reject('cc')],
  ['POST', '/v1/passkey_api/login/init', { user_id: 'u1' }, (c) => c.passkeyApi.loginInit({ user_id: 'u1' })],
  ['GET', '/v1/passkey_api/users/u1/passkeys', undefined, (c) => c.passkeyApi.list('u1')],
  ['DELETE', '/v1/passkey_api/users/u1/passkeys/pk_1', undefined, (c) => c.passkeyApi.delete('u1', 'pk_1')],
  ['POST', '/v1/vc/offers', { credential_type_id: 'vct_1', user_id: 'u1' }, (c) => c.vc.createOffer({ credential_type_id: 'vct_1', user_id: 'u1' })],
  ['POST', '/v1/vc/credentials/vcr_1/revoke', undefined, (c) => c.vc.credentials.revoke('vcr_1')],
  ['GET', '/v1/vc/presentation_requests/vpr_1', undefined, (c) => c.vc.presentationRequests.get('vpr_1')],
  ['GET', '/v1/oauth_initial_access_tokens', undefined, (c) => c.oauthClients.initialAccessTokens.list()],
  ['POST', '/v1/oauth_initial_access_tokens', { max_uses: 3 }, (c) => c.oauthClients.initialAccessTokens.create({ max_uses: 3 })],
  ['DELETE', '/v1/oauth_initial_access_tokens/oiat_1', undefined, (c) => c.oauthClients.initialAccessTokens.revoke('oiat_1')],
  ['GET', '/v1/instance/proxy_secret', undefined, (c) => c.instanceSecurity.getProxySecret()],
  ['POST', '/v1/instance/proxy_secret', { overlap_seconds: 600 }, (c) => c.instanceSecurity.createProxySecret({ overlap_seconds: 600 })],
  ['DELETE', '/v1/instance/proxy_secret', undefined, (c) => c.instanceSecurity.deleteProxySecret()],
  ['POST', '/v1/connections', { owner: { type: 'organization', id: 'org_1' }, kind: 'oauth', provider: 'zendesk', allowed_hosts: ['acme.zendesk.com'], host_params: { subdomain: 'acme' } }, (c) => c.connections.create({ owner: { type: 'organization', id: 'org_1' }, kind: 'oauth', provider: 'zendesk', allowed_hosts: ['acme.zendesk.com'], host_params: { subdomain: 'acme' } })],
  ['GET', '/v1/connections?owner_id=org_1&provider=zendesk&environment=sandbox', undefined, (c) => c.connections.list({ owner_id: 'org_1', provider: 'zendesk', environment: 'sandbox' })],
  ['PATCH', '/v1/connections/cnx_1', { owner: { type: 'organization', id: 'org_2' } }, (c) => c.connections.update('cnx_1', { owner: { type: 'organization', id: 'org_2' } })],
  ['POST', '/v1/connections/cnx_1/connect', { redirect_url: 'https://a.test/done', create_if_new: true }, (c) => c.connections.connect('cnx_1', { redirect_url: 'https://a.test/done', create_if_new: true })],
  ['POST', '/v1/connections/cnx_1/revoke', undefined, (c) => c.connections.revoke('cnx_1')],
  ['GET', '/v1/connections/cnx_1/token?refresh=true', undefined, (c) => c.connections.token('cnx_1', { refresh: true })],
  ['GET', '/v1/connections/cnx_1/token?subject=ann%40example.com', undefined, (c) => c.connections.token('cnx_1', { subject: 'ann@example.com' })],
  ['PUT', '/v1/connections/cnx_1/credentials', { api_key: 'k', expires_at: 1900000000000 }, (c) => c.connections.setCredentials('cnx_1', { api_key: 'k', expires_at: 1900000000000 })],
  ['POST', '/v1/connections/cnx_1/credentials/rotate', { token: 't2', overlap_seconds: 600 }, (c) => c.connections.rotateCredentials('cnx_1', { token: 't2', overlap_seconds: 600 })],
  ['GET', '/v1/connections/cnx_1/credentials/versions', undefined, (c) => c.connections.secretVersions('cnx_1')],
  ['GET', '/v1/connections/cnx_1/secret?version=previous', undefined, (c) => c.connections.secret('cnx_1', { version: 'previous' })],
  ['GET', '/v1/organizations/org_1/connections/cnx_1/secret', undefined, (c) => c.connections.secret('cnx_1', { organizationId: 'org_1' })],
  ['POST', '/v1/connections/cnx_1/oauth1/sign', { method: 'GET', url: 'https://x.example.com/a' }, (c) => c.connections.oauth1Sign('cnx_1', { method: 'GET', url: 'https://x.example.com/a' })],
  ['POST', '/v1/connections/cnx_1/webhooks/verify', { scheme: 'slack_v0', headers: { 'x-slack-signature': 'v0=a' }, raw_body: '{}' }, (c) => c.connections.webhooks.verify('cnx_1', { scheme: 'slack_v0', headers: { 'x-slack-signature': 'v0=a' }, raw_body: '{}' })],
  ['POST', '/v1/connections/cnx_1/webhook_endpoints', { scheme: 'zoom', forward_url: 'https://h.example.com/in' }, (c) => c.connections.webhooks.createEndpoint('cnx_1', { scheme: 'zoom', forward_url: 'https://h.example.com/in' })],
  ['GET', '/v1/connections/cnx_1/webhook_endpoints', undefined, (c) => c.connections.webhooks.listEndpoints('cnx_1')],
  ['PATCH', '/v1/connections/cnx_1/webhook_endpoints/cwh_1', { enabled: false }, (c) => c.connections.webhooks.updateEndpoint('cnx_1', 'cwh_1', { enabled: false })],
  ['DELETE', '/v1/connections/cnx_1/webhook_endpoints/cwh_1', undefined, (c) => c.connections.webhooks.deleteEndpoint('cnx_1', 'cwh_1')],
  ['PUT', '/v1/connections/oauth_clients', { owner: { type: 'organization', id: 'org_1' }, provider: 'salesforce', client_id: 'cid', client_secret: 'sec' }, (c) => c.connections.oauthClients.set({ owner: { type: 'organization', id: 'org_1' }, provider: 'salesforce', client_id: 'cid', client_secret: 'sec' })],
  ['GET', '/v1/connections/oauth_clients?owner_id=org_1', undefined, (c) => c.connections.oauthClients.list({ owner_id: 'org_1' })],
  ['DELETE', '/v1/connections/oauth_clients/cnc_1', undefined, (c) => c.connections.oauthClients.delete('cnc_1')],
  ['GET', '/v1/instance/connections', undefined, (c) => c.instance.connections()],
  ['GET', '/v1/instance/integrations', undefined, (c) => c.instance.integrations.list()],
  ['GET', '/v1/instance/integrations/helpdesk', undefined, (c) => c.instance.integrations.get('helpdesk')],
  ['PUT', '/v1/instance/integrations/helpdesk', { name: 'Helpdesk', audience: 'helpdesk:acme' }, (c) => c.instance.integrations.set('helpdesk', { name: 'Helpdesk', audience: 'helpdesk:acme' })],
  ['PUT', '/v1/instance/integrations/cookiemunch?dry_run=true', { audience: 'cookiemunch:cb1' }, (c) => c.instance.integrations.set('cookiemunch', { audience: 'cookiemunch:cb1' }, { dryRun: true })],
  ['DELETE', '/v1/instance/integrations/helpdesk', undefined, (c) => c.instance.integrations.remove('helpdesk')],
  ['GET', '/v1/instance/integrations/chatly/deliveries?trace=01J00000000000000000000000', undefined, (c) => c.instance.integrations.deliveries('chatly', { trace: '01J00000000000000000000000' })],
  ['POST', '/v1/instance/integrations/chatly/events_secret', undefined, (c) => c.instance.integrations.revealEventsSecret('chatly')],
  ['POST', '/v1/instance/integrations/chatly/atlas_id_tokens', { access_token: 'at_1' }, (c) => c.instance.integrations.atlasIdToken('chatly', 'at_1')],
  ['POST', '/v1/sessions/sess_1/integration_tokens/chatly', undefined, (c) => c.sessions.getToken('sess_1', { for: 'chatly' })],
  ['POST', '/v1/sessions/sess_1/integration_tokens/cookiemunch?cbid=dv-1', undefined, (c) => c.sessions.getToken('sess_1', { for: 'cookiemunch', cbid: 'dv-1' })],
  ['POST', '/v1/sessions/sess_1/integration_tokens/acme?tenant=t2', undefined, (c) => c.sessions.getToken('sess_1', { for: 'acme', audienceParams: { tenant: 't2' } })],
  ['POST', '/v1/sessions/sess_1/tokens/custom', undefined, (c) => c.sessions.getToken('sess_1', 'custom')],
  ['POST', '/v1/integrations/verify_errors', { integration: 'chatly', error: 'expired' }, (c) => c.integrations.reportVerifyError({ integration: 'chatly', error: 'expired' })],
  ['GET', '/v1/integrations/chatly/card?sub=user_1', undefined, (c) => c.integrations.card('chatly', { sub: 'user_1' })],
  ['POST', '/v1/integrations/chatly/card/actions/revoke_sessions', { sub: 'user_1' }, (c) => c.integrations.revokeSessions('chatly', { sub: 'user_1' })],
  ['GET', '/v1/public/instances/ins_1', undefined, (c) => c.integrations.instanceMetadata('ins_1')],
  ['GET', '/v1/instance/integrations/chatly', undefined, (c) => c.instance.integrations.chatly.get()],
  ['PUT', '/v1/instance/integrations/chatly', { channel: 'support' }, (c) => c.instance.integrations.chatly.set({ channel: 'support' })],
  ['DELETE', '/v1/instance/integrations/chatly', undefined, (c) => c.instance.integrations.chatly.delete()],
  ['GET', '/v1/instance/integrations/forumulate', undefined, (c) => c.instance.integrations.forumulate.get()],
  [
    'PUT',
    '/v1/instance/integrations/forumulate',
    { org_id: 'org_1', spaces: ['sp_1', { id: 'sp_2', redeem_url: 'https://docs.example.com/r' }] },
    (c) =>
      c.instance.integrations.forumulate.set({
        org_id: 'org_1',
        spaces: ['sp_1', { id: 'sp_2', redeem_url: 'https://docs.example.com/r' }],
      }),
  ],
  ['DELETE', '/v1/instance/integrations/forumulate', undefined, (c) => c.instance.integrations.forumulate.delete()],
  ['GET', '/v1/logout_notify_endpoints', undefined, (c) => c.logoutNotifyEndpoints.list()],
  [
    'POST',
    '/v1/logout_notify_endpoints',
    { url: 'https://hooks.example.com/logout', oauth_client_id: 'client_1' },
    (c) => c.logoutNotifyEndpoints.create({ url: 'https://hooks.example.com/logout', oauth_client_id: 'client_1' }),
  ],
  ['GET', '/v1/logout_notify_endpoints/lne_1', undefined, (c) => c.logoutNotifyEndpoints.get('lne_1')],
  ['PATCH', '/v1/logout_notify_endpoints/lne_1', { description: 'x' }, (c) => c.logoutNotifyEndpoints.update('lne_1', { description: 'x' })],
  ['DELETE', '/v1/logout_notify_endpoints/lne_1', undefined, (c) => c.logoutNotifyEndpoints.delete('lne_1')],
  ['GET', '/v1/logout_notify_endpoints/lne_1/deliveries?limit=5', undefined, (c) => c.logoutNotifyEndpoints.listDeliveries('lne_1', { limit: 5 })],
  ['GET', '/v1/messaging_providers/email/managed', undefined, (c) => c.messaging.managedEmail.get()],
  [
    'POST',
    '/v1/messaging_providers/email/managed',
    { from_address: 'Acme <no-reply@example.com>', dns: { provider: 'cloudflare', api_token: 'tok' } },
    (c) =>
      c.messaging.managedEmail.create({
        from_address: 'Acme <no-reply@example.com>',
        dns: { provider: 'cloudflare', api_token: 'tok' },
      }),
  ],
  ['POST', '/v1/messaging_providers/email/managed/verify', undefined, (c) => c.messaging.managedEmail.verify()],
  ['DELETE', '/v1/messaging_providers/email/managed?force=true', undefined, (c) => c.messaging.managedEmail.delete({ force: true })],
  ['GET', '/v1/oauth_clients/oac_1/backchannel_deliveries?limit=10', undefined, (c) => c.oauthClients.listBackchannelDeliveries('oac_1', { limit: 10 })],
  ['POST', '/v1/oauth_clients/oac_1/backchannel_logout/test', undefined, (c) => c.oauthClients.testBackchannelLogout('oac_1')],
  ['POST', '/v1/users/user_1/sessions/revoke', { revoke_grants: true }, (c) => c.users.revokeSessions('user_1', { revoke_grants: true })],
  ['POST', '/v1/domains', { host: 'auth.example.com', dns: { provider: 'cloudflare', api_token: 'tok' } }, (c) => c.domains.create({ host: 'auth.example.com', dns: { provider: 'cloudflare', api_token: 'tok' } })],
  ['GET', '/v1/partner_platforms', undefined, (c) => c.partnerPlatforms.list()],
  ['GET', '/v1/partner_platforms/cookiemunch', undefined, (c) => c.partnerPlatforms.get('cookiemunch')],
  ['PUT', '/v1/partner_platforms/cookiemunch', { allowed_sources: ['dv-1'] }, (c) => c.partnerPlatforms.set('cookiemunch', { allowed_sources: ['dv-1'] })],
  ['DELETE', '/v1/partner_platforms/cookiemunch', undefined, (c) => c.partnerPlatforms.remove('cookiemunch')],
  ['GET', '/v1/partner_platforms/cookiemunch/registration', undefined, (c) => c.partnerPlatforms.registration('cookiemunch')],
  ['POST', '/v1/partner_platforms/cookiemunch/token', { token: 'cmpt_0123456789abcdef' }, (c) => c.partnerPlatforms.storeToken('cookiemunch', { token: 'cmpt_0123456789abcdef' })],
  ['GET', '/v1/partner_platforms/cookiemunch/deliveries?limit=10', undefined, (c) => c.partnerPlatforms.deliveries('cookiemunch', { limit: 10 })],
  ['GET', '/v1/audit_event_schemas', undefined, (c) => c.auditEventSchemas.list()],
  ['POST', '/v1/audit_event_schemas', { action: 'invoice.sent', metadata_schema: { type: 'object' } }, (c) => c.auditEventSchemas.register({ action: 'invoice.sent', metadata_schema: { type: 'object' } })],
  ['POST', '/v1/audit_events/cae_1/redact', { fields: ['metadata.email'], reason: 'erasure request' }, (c) => c.auditEventSchemas.redact('cae_1', { fields: ['metadata.email'], reason: 'erasure request' })],
  ['GET', '/v1/audit_events/cae_1/redactions', undefined, (c) => c.auditEventSchemas.redactions('cae_1')],
  ['GET', '/v1/marketing_settings', undefined, (c) => c.marketing.getSettings()],
  ['PUT', '/v1/marketing_settings', { capture: { enabled: true } }, (c) => c.marketing.updateSettings({ capture: { enabled: true } })],
  ['GET', '/v1/leads?form=newsletter&limit=10', undefined, (c) => c.marketing.listLeads({ form: 'newsletter', limit: 10 })],
  ['DELETE', '/v1/leads/mlead_1', undefined, (c) => c.marketing.deleteLead('mlead_1')],
  ['GET', '/v1/analytics/funnel?kind=sign_up&days=7', undefined, (c) => c.analytics.funnel({ kind: 'sign_up', days: 7 })],
  ['GET', '/v1/analytics/failures', undefined, (c) => c.analytics.failures()],
  ['GET', '/v1/analytics/breakdown?dimension=country&organization_id=org_1', undefined, (c) => c.analytics.breakdown({ dimension: 'country', organization_id: 'org_1' })],
  ['GET', '/v1/analytics/active_users?granularity=week', undefined, (c) => c.analytics.activeUsers({ granularity: 'week' })],
  ['GET', '/v1/analytics/passkey_adoption', undefined, (c) => c.analytics.passkeyAdoption()],
  ['GET', '/v1/analytics/api_usage', undefined, (c) => c.analytics.apiUsage()],
  ['GET', '/v1/app_catalog', undefined, (c) => c.appCatalog.presets()],
  ['GET', '/v1/flows', undefined, (c) => c.journeys.list()],
  ['POST', '/v1/flows/jrny_1/simulate', { user_id: 'usr_1' }, (c) => c.journeys.simulate('jrny_1', { user_id: 'usr_1' })],
  ['POST', '/v1/flows/jrny_1/activate', { version: 2 }, (c) => c.journeys.activate('jrny_1', 2)],
  ['GET', '/v1/app_catalog/installed', undefined, (c) => c.appCatalog.installed()],
  ['POST', '/v1/app_catalog/slack/install', { params: { workspace: 'acme' } }, (c) => c.appCatalog.install('slack', { params: { workspace: 'acme' } })],
  ['PATCH', '/v1/app_catalog/installed/slack', { assignment: { mode: 'assigned', groups: ['eng'] } }, (c) => c.appCatalog.update('slack', { assignment: { mode: 'assigned', groups: ['eng'] } })],
  ['DELETE', '/v1/app_catalog/installed/slack', undefined, (c) => c.appCatalog.uninstall('slack')],
  ['GET', '/v1/app_catalog?q=slack&protocol=saml', undefined, (c) => c.appCatalog.presets({ q: 'slack', protocol: 'saml' })],
  ['POST', '/v1/app_catalog/custom_presets', { preset: { id: 'x' } }, (c) => c.appCatalog.saveCustomPreset({ id: 'x' })],
  ['GET', '/v1/app_catalog/requests?status=open', undefined, (c) => c.appCatalog.requests('open')],
  ['POST', '/v1/app_catalog/requests', { name: 'Acme' }, (c) => c.appCatalog.requestApp({ name: 'Acme' })],
  ['PATCH', '/v1/app_catalog/requests/acr_1', { status: 'building' }, (c) => c.appCatalog.updateRequest('acr_1', { status: 'building' })],
  ['GET', '/v1/cloud_access/targets?provider=aws', undefined, (c) => c.cloudAccess.list('aws')],
  ['POST', '/v1/cloud_access/targets', { provider: 'gcp', name: 'n', config: {} }, (c) => c.cloudAccess.create({ provider: 'gcp', name: 'n', config: {} })],
  ['GET', '/v1/cloud_access/targets/cat_1/setup', undefined, (c) => c.cloudAccess.setup('cat_1')],
  ['DELETE', '/v1/cloud_access/targets/cat_1', undefined, (c) => c.cloudAccess.delete('cat_1')],
  ['GET', '/v1/wsfed_connections', undefined, (c) => c.wsfedConnections.list()],
  ['POST', '/v1/wsfed_connections', { realm: 'urn:x', metadata_url: 'https://adfs.example/fm.xml' }, (c) => c.wsfedConnections.create({ realm: 'urn:x', metadata_url: 'https://adfs.example/fm.xml' })],
  ['PATCH', '/v1/wsfed_connections/ssoc_1', { status: 'active' }, (c) => c.wsfedConnections.update('ssoc_1', { status: 'active' })],
  ['DELETE', '/v1/wsfed_connections/ssoc_1', undefined, (c) => c.wsfedConnections.delete('ssoc_1')],
  ['GET', '/v1/scim_resource_types', undefined, (c) => c.scimResourceTypes.list()],
  ['POST', '/v1/scim_resource_types', { name: 'Device', endpoint: 'Devices', schema_uri: 'urn:x:y' }, (c) => c.scimResourceTypes.create({ name: 'Device', endpoint: 'Devices', schema_uri: 'urn:x:y' })],
  ['DELETE', '/v1/scim_resource_types/srt_1', undefined, (c) => c.scimResourceTypes.delete('srt_1')],
  ['GET', '/v1/provisioning_connectors', undefined, (c) => c.scimProvisioning.connectors()],
  ['POST', '/v1/provisioning/preview', { target_id: 't1', user_id: 'u1' }, (c) => c.scimProvisioning.preview({ target_id: 't1', user_id: 'u1' })],
  ['GET', '/v1/scim_provisioning_targets/t1/logs?failures=true', undefined, (c) => c.scimProvisioning.logs('t1', { failures: true })],
  ['GET', '/v1/scim_provisioning_targets/t1/failures', undefined, (c) => c.scimProvisioning.failures('t1')],
  ['POST', '/v1/scim_provisioning_targets/t1/retry_failed', {}, (c) => c.scimProvisioning.retryFailed('t1')],
  ['GET', '/v1/saml_idp/service_providers', undefined, (c) => c.samlIdp.list()],
  ['GET', '/v1/saml_idp/service_providers/acme', undefined, (c) => c.samlIdp.get('acme')],
  ['PATCH', '/v1/saml_idp/service_providers/acme', { name_id_format: 'persistent' }, (c) => c.samlIdp.update('acme', { name_id_format: 'persistent' })],
  ['POST', '/v1/saml_idp/service_providers/import_metadata', { metadata_url: 'https://sp.example.test/metadata', save_as: 'acme' }, (c) => c.samlIdp.importMetadata({ metadata_url: 'https://sp.example.test/metadata', save_as: 'acme' })],
  ['GET', '/v1/analytics/reports/inactive_users?inactive_days=60', undefined, (c) => c.analytics.reports.inactiveUsers({ inactive_days: 60 })],
  ['GET', '/v1/analytics/reports/mfa_coverage', undefined, (c) => c.analytics.reports.mfaCoverage()],
  ['GET', '/v1/analytics/reports/access_by_app', undefined, (c) => c.analytics.reports.accessByApp()],
  ['GET', '/v1/analytics/alert_rules', undefined, (c) => c.analytics.alertRules.list()],
  ['POST', '/v1/analytics/alert_rules', { name: 'n', metric: 'failed_sign_ins', comparator: 'gt', threshold: 5, email_contacts: ['a@b.co'] }, (c) => c.analytics.alertRules.create({ name: 'n', metric: 'failed_sign_ins', comparator: 'gt', threshold: 5, email_contacts: ['a@b.co'] })],
  ['PATCH', '/v1/analytics/alert_rules/aar_1', { enabled: false }, (c) => c.analytics.alertRules.update('aar_1', { enabled: false })],
  ['POST', '/v1/analytics/alert_rules/aar_1/test', { notify: true }, (c) => c.analytics.alertRules.test('aar_1', { notify: true })],
  ['DELETE', '/v1/analytics/alert_rules/aar_1', undefined, (c) => c.analytics.alertRules.delete('aar_1')],
];

const PLATFORM: Array<[string, string, unknown, (c: Plat) => Promise<unknown>]> = [
  ['GET', '/v1/platform/atlas_id_apps/app_1/backchannel_deliveries', undefined, (c) => c.atlasIdApps.listBackchannelDeliveries('app_1')],
  ['POST', '/v1/platform/atlas_id_apps/app_1/backchannel_logout/test', undefined, (c) => c.atlasIdApps.testBackchannelLogout('app_1')],
  ['GET', '/v1/platform/atlas_id_apps/app_1/preflight', undefined, (c) => c.atlasIdApps.preflight('app_1')],
  ['GET', '/v1/platform/atlas_id_apps/app_1/users?email=a%40example.com', undefined, (c) => c.atlasIdApps.findUsers('app_1', 'a@example.com')],
  ['DELETE', '/v1/platform/atlas_id_apps/app_1/grants/gr_1', undefined, (c) => c.atlasIdApps.revokeGrant('app_1', 'gr_1')],
  ['PUT', '/v1/platform/atlas_id_apps/app_1/managed_by', { instance_id: 'ins_1' }, (c) => c.atlasIdApps.setManagedBy('app_1', 'ins_1')],
  ['PUT', '/v1/platform/atlas_id_apps/app_1/managed_by', { instance_id: null }, (c) => c.atlasIdApps.setManagedBy('app_1', null)],
  ['POST', '/v1/platform/atlas_id_apps/app_1/move_origin', MOVE, (c) => c.atlasIdApps.moveOrigin('app_1', MOVE)],
  ['POST', '/v1/platform/atlas_id_apps/app_1/webhook/rotate_secret', undefined, (c) => c.atlasIdApps.rotateWebhookSecret('app_1')],
  ['POST', '/v1/platform/atlas_id_apps/app_1/webhook/rotate_secret', { overlap_seconds: 600 }, (c) => c.atlasIdApps.rotateWebhookSecret('app_1', { overlap_seconds: 600 })],
  ['PATCH', '/v1/platform/atlas_id_apps/app_1', { webhook_url: null }, (c) => c.atlasIdApps.update('app_1', { webhook_url: null })],
  ['GET', '/v1/platform/atlas_id_publisher', undefined, (c) => c.atlasIdPublisher.get()],
  ['PUT', '/v1/platform/atlas_id_publisher', { name: 'Acme', domain: 'example.com' }, (c) => c.atlasIdPublisher.set({ name: 'Acme', domain: 'example.com' })],
  ['PATCH', '/v1/platform/atlas_id_publisher', { skip_consent: true }, (c) => c.atlasIdPublisher.update({ skip_consent: true })],
  ['DELETE', '/v1/platform/atlas_id_publisher', undefined, (c) => c.atlasIdPublisher.delete()],
  ['POST', '/v1/platform/atlas_id_publisher/verify', undefined, (c) => c.atlasIdPublisher.verify()],
  ['GET', '/v1/platform/config_changelog?action=atlas_id_app.updated&limit=5', undefined, (c) => c.configChangelog.list({ action: 'atlas_id_app.updated', limit: 5 })],
];

describe('added Backend API operations', () => {
  it.each(BAPI)('%s %s', async (method, path, body, call) => {
    const { impl, calls } = mockFetch();
    await call(createAtlasClient({ secretKey: 'sk_test_x', apiUrl: API_URL, fetch: impl }));
    const c = calls[calls.length - 1]!;
    expect([c.method, c.url]).toEqual([method, `${API_URL}${path}`]);
    expect(c.body === undefined ? undefined : JSON.parse(c.body as string)).toEqual(body);
  });

  it('sends Atlas-Strict on the new writes when strict', async () => {
    const { impl, calls } = mockFetch();
    const atlas = createAtlasClient({ secretKey: 'sk_test_x', apiUrl: API_URL, fetch: impl, strict: true });
    await atlas.instance.moveOrigin(MOVE);
    expect(calls[0]!.headers['atlas-strict']).toBe('true');
  });

  it('decodes an origin move, managed email, connections and the new fields', async () => {
    const move = {
      object: 'origin_move',
      ...MOVE,
      applied: false,
      changes: [{ object: 'oauth_client', id: 'oac_1', field: 'redirect_uris', before: ['https://old.example.com/cb'], after: ['https://new.example.com/cb'] }],
      problems: [],
    };
    let m = mockFetch(move);
    const r = await createAtlasClient({ secretKey: 'sk_test_x', apiUrl: API_URL, fetch: m.impl }).instance.moveOrigin(MOVE);
    expect(r.changes[0]!.after).toEqual(['https://new.example.com/cb']);

    m = mockFetch({ object: 'cookie_consent', enabled: true, culture: 'page', declared_cookies: [{ name: '__session', pattern: null, store: 'cookie', domain: '.example.com', lifetime_seconds: null, lifetime: 'session', http_only: true, category: 'necessary', purpose: 'p', written_when: 'w', set_by: 'atlas_frontend_api' }] });
    const cc = await createAtlasClient({ secretKey: 'sk_test_x', apiUrl: API_URL, fetch: m.impl }).instance.cookieConsent.get();
    expect(cc.declared_cookies![0]!.store).toBe('cookie');
    expect(cc.culture).toBe('page');
  });
});

describe('added Platform API operations', () => {
  it.each(PLATFORM)('%s %s', async (method, path, body, call) => {
    const { impl, calls } = mockFetch();
    await call(createAtlasPlatformClient({ platformKey: 'psk_test_x', apiUrl: API_URL, fetch: impl }));
    const c = calls[calls.length - 1]!;
    expect([c.method, c.url]).toEqual([method, `${API_URL}${path}`]);
    expect(c.body === undefined ? undefined : JSON.parse(c.body as string)).toEqual(body);
  });

  it('decodes the publisher and the app user lookup', async () => {
    const m = mockFetch({ object: 'list', data: [{ object: 'atlas_id_user', atlas_id_user: true, sub: 'u_1', grant_id: 'gr_1', scopes: ['openid'], granted_at: 1 }] });
    const r = await createAtlasPlatformClient({ platformKey: 'psk_test_x', apiUrl: API_URL, fetch: m.impl }).atlasIdApps.findUsers('app_1', 'a@example.com');
    expect(r.data[0]!.grant_id).toBe('gr_1');
  });
});
