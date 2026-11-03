import type { FapiClient } from './fapi';
import { OrganizationRequestError } from './organizations';

/**
 * The org-admin Frontend API behind the in-app admin widgets
 * (`<OrganizationSsoConnection/>`, `<OrganizationDirectory/>`,
 * `<OrganizationDomains/>`, `<OrganizationLogStreams/>`, `<OrganizationApiKeys/>`,
 * `<OrganizationIpAllowlist/>`, `<OrganizationWebhooks/>`, `<AppWebhookEndpoints/>`). Every call is scoped
 * to the ACTIVE organization and needs the manage-members permission; a refused
 * call throws {@link OrganizationRequestError} (404 for another organization,
 * 403 for a member without the permission).
 */

export interface OrganizationSsoConnection {
  id: string;
  type: 'oidc' | 'saml';
  status: string;
  oidc_issuer: string | null;
  oidc_client_id: string | null;
  has_secret: boolean;
  saml_idp_entity_id: string | null;
  saml_idp_sso_url: string | null;
  has_saml_certificate: boolean;
  saml_single_logout: boolean;
  saml_idp_slo_url: string | null;
}

/** The service-provider details an IdP admin copies into their identity provider. */
export interface OrganizationSsoServiceProvider {
  acs_url: string;
  oidc_redirect_uri: string;
  sp_entity_id: string | null;
  saml_metadata_url: string | null;
  saml_slo_url: string | null;
}

export interface OrganizationSsoView {
  object: 'organization_sso_connection';
  connection: OrganizationSsoConnection | null;
  sp: OrganizationSsoServiceProvider;
}

export interface OrganizationSsoInput {
  type: 'oidc' | 'saml';
  oidc_issuer?: string;
  oidc_client_id?: string;
  /** Write-only; leave blank to keep the stored secret. */
  oidc_client_secret?: string;
  saml_metadata_xml?: string;
  saml_idp_entity_id?: string;
  saml_idp_sso_url?: string;
  /** Write-only PEM; leave blank to keep the stored certificate. */
  saml_idp_certificate?: string;
  saml_idp_slo_url?: string;
  saml_single_logout?: boolean;
}

export interface OrganizationScimToken {
  object: 'scim_token';
  id: string;
  name: string | null;
  prefix: string;
  last_used_at: number | null;
  expires_at: number | null;
  created_at: number;
}

export interface OrganizationDirectory {
  object: 'organization_directory';
  base_url: string;
  tokens: OrganizationScimToken[];
}

export interface OrganizationDomain {
  object: 'org_domain';
  id: string;
  domain: string;
  status: string;
  verification: { record_type: 'TXT'; record_name: string; record_value: string };
}

export interface OrganizationLogStream {
  object: 'org_audit_stream';
  id: string;
  organization_id: string;
  url: string;
  format: string;
  active: boolean;
  has_secret: boolean;
  created_at: number;
}

export interface OrganizationApiKey {
  object: 'api_key';
  id: string;
  name: string | null;
  prefix: string;
  expires_at: number | null;
  last_used_at: number | null;
  created_at: number;
}

export interface OrganizationIpAllowlist {
  object: 'organization_ip_allowlist';
  entries: string[];
  /** The caller's own address, so a UI can offer "add my IP". */
  your_ip: string;
}

export interface OrganizationWebhookEndpoint {
  object: 'webhook_endpoint';
  id: string;
  url: string;
  description: string | null;
  enabled_events: string[];
  active: boolean;
  health: 'healthy' | 'failing' | 'disabled' | string;
  created_at: number;
}

export interface OrganizationWebhookDelivery {
  object: 'webhook_delivery';
  id: string;
  event_type: string | null;
  status: string;
  http_status: number | null;
  attempt_number: number;
  created_at: number;
}

export interface OrganizationAppEventType {
  object: 'app_event_type';
  id: string;
  type: string;
  description: string | null;
}

export interface OrganizationWebhookTestResult {
  object: 'webhook_test_result';
  delivery_id: string;
  status: 'success' | 'failed';
  http_status: number | null;
  error: string | null;
}

const enc = encodeURIComponent;
const base = (organizationId: string) => `/v1/client/organizations/${enc(organizationId)}`;

async function call<T>(client: FapiClient, path: string, init: RequestInit = {}): Promise<T> {
  const res = await client.request<T>(path, init);
  if (!res.ok || !res.data) {
    const first = res.errors[0];
    throw new OrganizationRequestError(
      res.status,
      first?.code ?? 'UNKNOWN',
      first?.message ?? 'The request failed.',
      first?.param,
      first?.reason,
      first?.meta,
    );
  }
  return res.data;
}

const send = (method: string, body?: unknown): RequestInit =>
  body === undefined ? { method } : { method, body: JSON.stringify(body) };

type Page<T> = { data: T[] };

export const organizationAdmin = {
  /* SSO connection */
  getSso: (c: FapiClient, org: string) => call<OrganizationSsoView>(c, `${base(org)}/sso_connection`, send('GET')),
  saveSso: (c: FapiClient, org: string, input: OrganizationSsoInput) =>
    call<OrganizationSsoView>(c, `${base(org)}/sso_connection`, send('PATCH', input)),

  /* Directory sync (SCIM) */
  getDirectory: (c: FapiClient, org: string) => call<OrganizationDirectory>(c, `${base(org)}/directory`, send('GET')),
  /** The returned `token` is shown once. */
  createDirectoryToken: (c: FapiClient, org: string) =>
    call<OrganizationScimToken & { token: string }>(c, `${base(org)}/directory/tokens`, send('POST')),
  revokeDirectoryToken: (c: FapiClient, org: string, tokenId: string) =>
    call<{ id: string; revoked: true }>(c, `${base(org)}/directory/tokens/${enc(tokenId)}`, send('DELETE')),

  /* Domains */
  listDomains: async (c: FapiClient, org: string) =>
    (await call<Page<OrganizationDomain>>(c, `${base(org)}/domains`, send('GET'))).data,
  addDomain: (c: FapiClient, org: string, domain: string) =>
    call<OrganizationDomain>(c, `${base(org)}/domains`, send('POST', { domain })),
  verifyDomain: (c: FapiClient, org: string, domainId: string) =>
    call<OrganizationDomain & { verified: boolean }>(c, `${base(org)}/domains/${enc(domainId)}/verify`, send('POST')),
  removeDomain: (c: FapiClient, org: string, domainId: string) =>
    call<{ id: string; deleted: true }>(c, `${base(org)}/domains/${enc(domainId)}`, send('DELETE')),

  /* Log streams */
  listLogStreams: async (c: FapiClient, org: string) =>
    (await call<Page<OrganizationLogStream>>(c, `${base(org)}/log_streams`, send('GET'))).data,
  /** The returned `secret` signs deliveries and is shown once. */
  addLogStream: (c: FapiClient, org: string, input: { url: string; format?: string }) =>
    call<OrganizationLogStream & { secret: string }>(c, `${base(org)}/log_streams`, send('POST', input)),
  removeLogStream: (c: FapiClient, org: string, streamId: string) =>
    call<{ id: string; deleted: true }>(c, `${base(org)}/log_streams/${enc(streamId)}`, send('DELETE')),

  /* API keys */
  listApiKeys: async (c: FapiClient, org: string) =>
    (await call<Page<OrganizationApiKey>>(c, `${base(org)}/api_keys`, send('GET'))).data,
  /** The returned `secret` is shown once. */
  createApiKey: (c: FapiClient, org: string, input: { name?: string; expires_in_seconds?: number } = {}) =>
    call<OrganizationApiKey & { secret: string }>(c, `${base(org)}/api_keys`, send('POST', input)),
  revokeApiKey: (c: FapiClient, org: string, keyId: string) =>
    call<{ id: string; revoked: true }>(c, `${base(org)}/api_keys/${enc(keyId)}`, send('DELETE')),

  /* Sign-in IP allowlist */
  getIpAllowlist: (c: FapiClient, org: string) =>
    call<OrganizationIpAllowlist>(c, `${base(org)}/ip_allowlist`, send('GET')),
  /** An empty list clears it; a list that excludes the caller's own IP is refused. */
  setIpAllowlist: (c: FapiClient, org: string, entries: string[]) =>
    call<OrganizationIpAllowlist>(c, `${base(org)}/ip_allowlist`, send('PATCH', { entries })),

  /* Webhook endpoints */
  listWebhooks: async (c: FapiClient, org: string) =>
    (await call<Page<OrganizationWebhookEndpoint>>(c, `${base(org)}/webhook_endpoints`, send('GET'))).data,
  /** The returned `secret` is shown once. */
  createWebhook: (c: FapiClient, org: string, input: { url: string; enabled_events?: string[]; description?: string }) =>
    call<OrganizationWebhookEndpoint & { secret: string }>(c, `${base(org)}/webhook_endpoints`, send('POST', input)),
  updateWebhook: (
    c: FapiClient,
    org: string,
    endpointId: string,
    input: { url?: string; enabled_events?: string[]; description?: string | null; active?: boolean },
  ) => call<OrganizationWebhookEndpoint>(c, `${base(org)}/webhook_endpoints/${enc(endpointId)}`, send('PATCH', input)),
  deleteWebhook: (c: FapiClient, org: string, endpointId: string) =>
    call<{ id: string; deleted: true }>(c, `${base(org)}/webhook_endpoints/${enc(endpointId)}`, send('DELETE')),
  rotateWebhookSecret: (c: FapiClient, org: string, endpointId: string) =>
    call<{ secret: string; overlap_seconds: number }>(c, `${base(org)}/webhook_endpoints/${enc(endpointId)}/rotate_secret`, send('POST')),
  webhookDeliveries: async (c: FapiClient, org: string, endpointId: string) =>
    (await call<Page<OrganizationWebhookDelivery>>(c, `${base(org)}/webhook_endpoints/${enc(endpointId)}/deliveries`, send('GET'))).data,

  /* Application webhooks: the app's own events, sent to this organization's endpoints (Standard Webhooks signed) */
  /** The app's event catalog for the picker (deprecated types left out). */
  listAppEventTypes: async (c: FapiClient, org: string) =>
    (await call<Page<OrganizationAppEventType>>(c, `${base(org)}/app_event_types`, send('GET'))).data,
  listAppWebhooks: async (c: FapiClient, org: string) =>
    (await call<Page<OrganizationWebhookEndpoint>>(c, `${base(org)}/app_webhook_endpoints`, send('GET'))).data,
  /** The returned `whsec_` secret is shown once (or with `revealAppWebhookSecret`). */
  createAppWebhook: (c: FapiClient, org: string, input: { url: string; enabled_events?: string[]; description?: string }) =>
    call<OrganizationWebhookEndpoint & { secret: string }>(c, `${base(org)}/app_webhook_endpoints`, send('POST', input)),
  updateAppWebhook: (
    c: FapiClient,
    org: string,
    endpointId: string,
    input: { url?: string; enabled_events?: string[]; description?: string | null; active?: boolean },
  ) => call<OrganizationWebhookEndpoint>(c, `${base(org)}/app_webhook_endpoints/${enc(endpointId)}`, send('PATCH', input)),
  deleteAppWebhook: (c: FapiClient, org: string, endpointId: string) =>
    call<{ id: string; deleted: true }>(c, `${base(org)}/app_webhook_endpoints/${enc(endpointId)}`, send('DELETE')),
  revealAppWebhookSecret: (c: FapiClient, org: string, endpointId: string) =>
    call<{ secret: string }>(c, `${base(org)}/app_webhook_endpoints/${enc(endpointId)}/reveal_secret`, send('POST')),
  rotateAppWebhookSecret: (c: FapiClient, org: string, endpointId: string) =>
    call<{ secret: string; overlap_seconds: number }>(c, `${base(org)}/app_webhook_endpoints/${enc(endpointId)}/rotate_secret`, send('POST')),
  /** Sends a signed `webhook.test` now and returns the attempt (status, http_status, error). */
  testAppWebhook: (c: FapiClient, org: string, endpointId: string) =>
    call<OrganizationWebhookTestResult>(c, `${base(org)}/app_webhook_endpoints/${enc(endpointId)}/test?wait=10s`, send('POST')),
  appWebhookDeliveries: async (c: FapiClient, org: string, endpointId: string) =>
    (await call<Page<OrganizationWebhookDelivery>>(c, `${base(org)}/app_webhook_endpoints/${enc(endpointId)}/deliveries`, send('GET'))).data,
  redeliverAppWebhook: (c: FapiClient, org: string, endpointId: string, deliveryId: string) =>
    call<{ id: string; event_id: string; status: string }>(
      c,
      `${base(org)}/app_webhook_endpoints/${enc(endpointId)}/deliveries/${enc(deliveryId)}/redeliver`,
      send('POST'),
    ),
  /** Re-send what the endpoint missed since it started failing (after re-enabling it). */
  replayAppWebhook: (c: FapiClient, org: string, endpointId: string, since: number | 'failing_since' = 'failing_since') =>
    call<{ queued: number; has_more: boolean }>(c, `${base(org)}/app_webhook_endpoints/${enc(endpointId)}/replay`, send('POST', { since })),
};
