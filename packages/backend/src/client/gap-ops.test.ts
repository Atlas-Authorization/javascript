import { describe, expect, it, vi } from 'vitest';
import { createAtlasClient } from './index';

type Bapi = ReturnType<typeof createAtlasClient>;

// [method, path+query, expected JSON body (undefined = none), call]
const CASES: Array<[string, string, unknown, (c: Bapi) => Promise<unknown>]> = [
  ['POST', '/v1/migrations/legacy/verify', { token: 't' }, (c) => c.migrations.verifyDualRun('legacy', { token: 't' })],
  ['GET', '/v1/migrations/status?quiet_days=30', undefined, (c) => c.migrations.status({ quiet_days: 30 })],
  ['GET', '/v1/instance/scopes?limit=5', undefined, (c) => c.instance.listScopes({ limit: 5 })],
  ['PUT', '/v1/instance/scopes', { scopes: [{ name: 'read', sensitive: true }] }, (c) => c.instance.putScopes({ scopes: [{ name: 'read', sensitive: true }] })],
  ['GET', '/v1/instance/impersonation_policy', undefined, (c) => c.instance.getImpersonationPolicy()],
  ['PUT', '/v1/instance/impersonation_policy', { require_reason: true }, (c) => c.instance.putImpersonationPolicy({ require_reason: true })],
  ['GET', '/v1/instance/org_role_entitlements', undefined, (c) => c.instance.getOrgRoleEntitlements()],
  ['PUT', '/v1/instance/org_role_entitlements', { roles: { admin: ['sso'] } }, (c) => c.instance.putOrgRoleEntitlements({ roles: { admin: ['sso'] } })],
  ['GET', '/v1/instance/org_departure_policy', undefined, (c) => c.instance.getOrgDeparturePolicy()],
  ['PUT', '/v1/instance/org_departure_policy', { transfer_to: 'user', user_id: 'user_1' }, (c) => c.instance.putOrgDeparturePolicy({ transfer_to: 'user', user_id: 'user_1' })],
  ['GET', '/v1/instance/app_event_types', undefined, (c) => c.instance.listAppEventTypes()],
  ['PUT', '/v1/instance/app_event_types', [{ type: 'call.done', required_scope: 'read' }], (c) => c.instance.putAppEventTypes([{ type: 'call.done', required_scope: 'read' }])],
  ['POST', '/v1/instance/privacy_orchestrator/cases/dismiss', { reason_code: 'email_unverified' }, (c) => c.instance.dismissPrivacyOrchestratorCases({ reason_code: 'email_unverified' })],
  ['POST', '/v1/users/user_1/external_accounts', { provider: 'telegram:bot', provider_user_id: '9' }, (c) => c.users.addExternalAccount('user_1', { provider: 'telegram:bot', provider_user_id: '9' })],
  ['DELETE', '/v1/users/user_1/external_accounts/ea_1', undefined, (c) => c.users.removeExternalAccount('user_1', 'ea_1')],
  ['DELETE', '/v1/users/user_1', { audit_actor_emails: ['ops@example.com'] }, (c) => c.users.delete('user_1', { audit_actor_emails: ['ops@example.com'] })],
  ['GET', '/v1/organizations/org_1/audit_logs?action=org.&limit=10', undefined, (c) => c.organizations.listAuditLogs('org_1', { action: 'org.', limit: 10 })],
  ['GET', '/v1/sessions/sess_1/risk', undefined, (c) => c.sessions.getRisk('sess_1')],
  ['GET', '/v1/oauth_clients/oac_1/usage?days=7', undefined, (c) => c.oauthClients.getUsage('oac_1', { days: 7 })],
  ['GET', '/v1/oauth_clients/oac_1/webhook', undefined, (c) => c.oauthClients.getWebhook('oac_1')],
  ['PUT', '/v1/oauth_clients/oac_1/webhook', { url: 'https://app.example/hook', enabled_events: ['user.updated'] }, (c) => c.oauthClients.putWebhook('oac_1', { url: 'https://app.example/hook', enabled_events: ['user.updated'] })],
  ['DELETE', '/v1/oauth_clients/oac_1/webhook', undefined, (c) => c.oauthClients.deleteWebhook('oac_1')],
  ['POST', '/v1/oauth_grants/import', { grants: [{ user_id: 'u', client_id: 'c', scopes: ['openid'] }] }, (c) => c.oauthGrants.import({ grants: [{ user_id: 'u', client_id: 'c', scopes: ['openid'] }] })],
  ['POST', '/v1/passkey_campaigns', { name: 'q1', frequency_cap_days: 7 }, (c) => c.passkeyCampaigns.create({ name: 'q1', frequency_cap_days: 7 })],
  ['GET', '/v1/passkey_campaigns', undefined, (c) => c.passkeyCampaigns.list()],
  ['GET', '/v1/passkey_campaigns/pkc_1', undefined, (c) => c.passkeyCampaigns.get('pkc_1')],
  ['DELETE', '/v1/passkey_campaigns/pkc_1', undefined, (c) => c.passkeyCampaigns.end('pkc_1')],
  ['GET', '/v1/diagnostics/traces/trc_1', undefined, (c) => c.diagnostics.getTrace('trc_1')],
  ['GET', '/v1/diagnostics/traces?code=RATE_LIMITED', undefined, (c) => c.diagnostics.listTraces({ code: 'RATE_LIMITED' })],
  ['GET', '/v1/security_advisories/adv_1', undefined, (c) => c.securityAdvisories.get('adv_1')],
  ['POST', '/v1/connections/conn_1/sign', { url: 'https://api.example.com/x' }, (c) => c.connections.sign('conn_1', { url: 'https://api.example.com/x' })],
  ['GET', '/v1/dev/emails?to=a%40example.com', undefined, (c) => c.dev.listEmails({ to: 'a@example.com' })],
  ['DELETE', '/v1/dev/emails', undefined, (c) => c.dev.clearEmails()],
  ['POST', '/v1/instance/integrations/forumulate/test?wait=10s', undefined, (c) => c.integrations.test('forumulate', { wait: '10s' })],
];

describe('gap operations', () => {
  it.each(CASES)('%s %s', async (method, path, body, call) => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body });
      return new Response(JSON.stringify({ object: 'x' }), { status: 200 });
    });
    await call(createAtlasClient({ secretKey: 'sk_test_1', apiUrl: 'https://api.example.test', fetch: impl as unknown as typeof fetch }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe(method);
    expect(calls[0]!.url).toBe(`https://api.example.test${path}`);
    expect(calls[0]!.body === undefined ? undefined : JSON.parse(String(calls[0]!.body))).toEqual(body);
  });
});
