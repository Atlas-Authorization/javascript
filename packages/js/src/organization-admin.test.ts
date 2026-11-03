import { describe, expect, it } from 'vitest';
import type { FapiClient, FapiResponse } from './fapi';
import { organizationAdmin as admin } from './organization-admin';
import { OrganizationRequestError } from './organizations';

function fakeClient(respond: (path: string, init: RequestInit) => FapiResponse<unknown>) {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const client = {
    async request<T>(path: string, init: RequestInit = {}): Promise<FapiResponse<T>> {
      calls.push({ path, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
      return respond(path, init) as FapiResponse<T>;
    },
  } as unknown as FapiClient;
  return { client, calls };
}
const ok = (data: unknown): FapiResponse<unknown> => ({ ok: true, status: 200, data, errors: [] });

describe('organizationAdmin', () => {
  it('hits the right paths and bodies', async () => {
    const { client, calls } = fakeClient(() => ok({ data: [] }));
    await admin.getSso(client, 'org_1');
    await admin.saveSso(client, 'org_1', { type: 'oidc', oidc_client_id: 'x' });
    await admin.createDirectoryToken(client, 'org_1');
    await admin.revokeDirectoryToken(client, 'org_1', 'sct_1');
    await admin.addDomain(client, 'org_1', 'acme.com');
    await admin.verifyDomain(client, 'org_1', 'dom_1');
    await admin.addLogStream(client, 'org_1', { url: 'https://s.example.com' });
    await admin.createApiKey(client, 'org_1', { name: 'ci' });
    await admin.revokeApiKey(client, 'org_1', 'k_1');
    await admin.setIpAllowlist(client, 'org_1', ['10.0.0.0/8']);
    await admin.createWebhook(client, 'org_1', { url: 'https://h.example.com' });
    await admin.rotateWebhookSecret(client, 'org_1', 'we_1');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /v1/client/organizations/org_1/sso_connection',
      'PATCH /v1/client/organizations/org_1/sso_connection',
      'POST /v1/client/organizations/org_1/directory/tokens',
      'DELETE /v1/client/organizations/org_1/directory/tokens/sct_1',
      'POST /v1/client/organizations/org_1/domains',
      'POST /v1/client/organizations/org_1/domains/dom_1/verify',
      'POST /v1/client/organizations/org_1/log_streams',
      'POST /v1/client/organizations/org_1/api_keys',
      'DELETE /v1/client/organizations/org_1/api_keys/k_1',
      'PATCH /v1/client/organizations/org_1/ip_allowlist',
      'POST /v1/client/organizations/org_1/webhook_endpoints',
      'POST /v1/client/organizations/org_1/webhook_endpoints/we_1/rotate_secret',
    ]);
    expect(calls[1]!.body).toEqual({ type: 'oidc', oidc_client_id: 'x' });
    expect(calls[9]!.body).toEqual({ entries: ['10.0.0.0/8'] });
  });

  it('unwraps lists and throws a typed error on refusal', async () => {
    const { client } = fakeClient(() => ok({ data: [{ id: 'dom_1' }] }));
    expect(await admin.listDomains(client, 'org_1')).toEqual([{ id: 'dom_1' }]);
    const denied = fakeClient(() => ({ ok: false, status: 404, data: null, errors: [{ code: 'NOT_FOUND', message: 'nope' }] }));
    await expect(admin.getDirectory(denied.client, 'org_2')).rejects.toBeInstanceOf(OrganizationRequestError);
  });

  it('application webhooks: the app_webhook_endpoints calls and the picker catalog', async () => {
    const { client, calls } = fakeClient(() => ok({ data: [] }));
    await admin.listAppEventTypes(client, 'org_1');
    await admin.createAppWebhook(client, 'org_1', { url: 'https://h.example.com', enabled_events: ['call.completed'] });
    await admin.updateAppWebhook(client, 'org_1', 'wh_1', { active: true });
    await admin.revealAppWebhookSecret(client, 'org_1', 'wh_1');
    await admin.testAppWebhook(client, 'org_1', 'wh_1');
    await admin.appWebhookDeliveries(client, 'org_1', 'wh_1');
    await admin.redeliverAppWebhook(client, 'org_1', 'wh_1', 'whd_1');
    await admin.replayAppWebhook(client, 'org_1', 'wh_1');
    const base = '/v1/client/organizations/org_1';
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET ${base}/app_event_types`,
      `POST ${base}/app_webhook_endpoints`,
      `PATCH ${base}/app_webhook_endpoints/wh_1`,
      `POST ${base}/app_webhook_endpoints/wh_1/reveal_secret`,
      `POST ${base}/app_webhook_endpoints/wh_1/test?wait=10s`,
      `GET ${base}/app_webhook_endpoints/wh_1/deliveries`,
      `POST ${base}/app_webhook_endpoints/wh_1/deliveries/whd_1/redeliver`,
      `POST ${base}/app_webhook_endpoints/wh_1/replay`,
    ]);
    expect(calls[1]!.body).toEqual({ url: 'https://h.example.com', enabled_events: ['call.completed'] });
    expect(calls[7]!.body).toEqual({ since: 'failing_since' });
  });
});
