import type { FapiClient } from './fapi';

/**
 * Connected accounts: the connections an app defined for the signed-in user or
 * their active organization (an API key or client-credentials the org entered, or
 * an OAuth account a member shared), with live status. Authorizing an OAuth
 * connection uses `connectExternalAccount` / `reauthorizeExternalAccount`.
 */
export type ConnectionStatus = 'connected' | 'not_connected' | 'needs_reauth' | 'revoked' | 'error';

export interface AppConnection {
  object: 'connection';
  id: string;
  owner: { type: 'organization' | 'user'; id: string };
  kind: 'oauth' | 'api_key' | 'client_credentials' | 'bearer' | 'basic' | 'custom_header' | 'hmac_secret' | 'jwt_bearer' | 'oauth1' | 'github_app_installation' | 'admin_consent';
  provider: string;
  name: string;
  allowed_hosts: string[];
  status: ConnectionStatus;
  /** Always `data`: a connection is never a sign-in method. */
  purpose?: 'data';
  environment?: 'production' | 'sandbox';
  sandbox?: boolean;
  /** The provider-side account the connection covers (a company, a workspace, a user id). */
  external_id?: string | null;
  host_params?: Record<string, string>;
  scopes?: string[];
  expires_at?: number | null;
  /** Non-secret provider handles captured with the token (realmId, instance_url, team_id...). */
  metadata?: Record<string, string>;
  /** The provider's own error behind the status (`invalid_grant`, ...), with the HTTP status it answered. */
  last_error?: { code: string; message: string; httpStatus?: number | null; at: number } | null;
  /** Consecutive failed refreshes; 0 when healthy. */
  refresh_failures?: number;
  /** @deprecated Always null: a connection owns its tokens. */
  external_account_id: string | null;
  has_secret: boolean;
  /** When the entered credential expires (epoch ms). The credential itself is never readable from the browser. */
  secret_expires_at?: number | null;
}

/** What the provider said when a connection was disconnected. The stored token is cleared in every case. */
export interface ConnectionRevokeResult {
  /** `true` the provider confirmed; `'unsupported'` it has no revoke endpoint; `false` it refused or was unreachable (see `provider_error`). */
  provider_revoked: boolean | 'unsupported' | 'not_connected';
  provider_status: number | null;
  provider_error: { code: string; description: string | null } | null;
  local_cleared: true;
}

/** What to send when starting the provider authorization of a connection. */
export interface ConnectConnectionInput {
  /** Where the owner lands afterwards; the URL carries `__atlas_status=connected` and `__atlas_connection=<id>`. */
  redirectUrl: string;
  /** Values for the provider's host templates, e.g. `{ subdomain: 'acme' }` or `{ tenant: 'contoso.onmicrosoft.com' }`. */
  hostParams?: Record<string, string>;
  environment?: 'production' | 'sandbox';
  additionalScopes?: string[];
  loginHint?: string;
  display?: 'redirect' | 'popup';
  /** A different provider account than the connection holds creates a sibling instead of failing with 409. */
  createIfNew?: boolean;
}

export interface ConnectionAuthorization {
  object: 'connection_authorization';
  connection_id: string;
  authorization_url: string;
  attempt_id: string;
}

/** An organization's own OAuth client for a provider (the secret is write-only). */
export interface ConnectionOAuthClient {
  object: 'connection_oauth_client';
  id: string;
  provider: string;
  environment: 'production' | 'sandbox';
  client_id: string;
  has_secret: true;
  scopes: string[];
  host_params: Record<string, string>;
  enabled: boolean;
  callback_url: string;
}

export interface SetConnectionOAuthClientInput {
  provider: string;
  environment?: 'production' | 'sandbox';
  clientId: string;
  /** Required the first time; omit to keep the stored secret. */
  clientSecret?: string;
  scopes?: string[];
  hostParams?: Record<string, string>;
  enabled?: boolean;
}

/**
 * Credential to enter for a non-OAuth connection. Write-only: it is sealed server-side and no browser call can read it
 * back. Which fields apply depends on the connection's kind.
 */
export interface ConnectionCredentialsInput {
  /** api_key */
  apiKey?: string;
  /** bearer */
  token?: string;
  /** basic */
  username?: string;
  password?: string;
  /** custom_header */
  value?: string;
  /** hmac_secret */
  secret?: string;
  /** client_credentials */
  clientId?: string;
  clientSecret?: string;
  tokenUrl?: string;
  /** jwt_bearer / github_app_installation: a PEM private key, or (jwt_bearer) a Google service-account JSON key. */
  privateKey?: string;
  serviceAccountJson?: string;
  /** oauth1 */
  consumerKey?: string;
  consumerSecret?: string;
  tokenSecret?: string;
  /** Epoch milliseconds or an ISO date; reminders go out 30, 7 and 1 days before. */
  expiresAt?: number | string;
  /** Non-secret settings of the kind (placement, header name, algorithm...). */
  config?: Record<string, unknown>;
}

export class ConnectionRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConnectionRequestError';
  }
}

async function call<T>(client: FapiClient, path: string, init: RequestInit): Promise<T> {
  const res = await client.request<T>(path, init);
  if (!res.ok || !res.data) {
    const first = res.errors[0];
    throw new ConnectionRequestError(res.status, first?.code ?? 'UNKNOWN', first?.message ?? 'The request failed.');
  }
  return res.data;
}

const orgBase = (organizationId: string) => `/v1/client/organizations/${encodeURIComponent(organizationId)}/connections`;

/** The signed-in user's own connections. */
export async function listMyConnections(client: FapiClient): Promise<AppConnection[]> {
  return (await call<{ data: AppConnection[] }>(client, '/v1/client/me/connections', { method: 'GET' })).data ?? [];
}

/** The active organization's connections. */
export async function listOrganizationConnections(client: FapiClient, organizationId: string): Promise<AppConnection[]> {
  return (await call<{ data: AppConnection[] }>(client, orgBase(organizationId), { method: 'GET' })).data ?? [];
}

/** Enter the organization's credential for a connection (needs the org profile-manage permission). */
export function setOrganizationConnectionCredentials(
  client: FapiClient,
  organizationId: string,
  connectionId: string,
  input: ConnectionCredentialsInput,
): Promise<AppConnection> {
  const map: Array<[keyof ConnectionCredentialsInput, string]> = [
    ['apiKey', 'api_key'], ['token', 'token'], ['username', 'username'], ['password', 'password'], ['value', 'value'], ['secret', 'secret'],
    ['clientId', 'client_id'], ['clientSecret', 'client_secret'], ['tokenUrl', 'token_url'], ['privateKey', 'private_key'],
    ['serviceAccountJson', 'service_account_json'], ['consumerKey', 'consumer_key'], ['consumerSecret', 'consumer_secret'],
    ['tokenSecret', 'token_secret'], ['expiresAt', 'expires_at'], ['config', 'config'],
  ];
  const body: Record<string, unknown> = {};
  for (const [from, to] of map) if (input[from] !== undefined) body[to] = input[from];
  return call<AppConnection>(client, `${orgBase(organizationId)}/${encodeURIComponent(connectionId)}/credentials`, { method: 'PUT', body: JSON.stringify(body) });
}

/** Share the signed-in admin's own linked provider account with the organization. */
export function shareOrganizationConnection(client: FapiClient, organizationId: string, connectionId: string): Promise<AppConnection> {
  return call<AppConnection>(client, `${orgBase(organizationId)}/${encodeURIComponent(connectionId)}/share`, { method: 'POST', body: '{}' });
}

const connectBody = (i: ConnectConnectionInput) => ({
  redirect_url: i.redirectUrl,
  ...(i.hostParams ? { host_params: i.hostParams } : {}),
  ...(i.environment ? { environment: i.environment } : {}),
  ...(i.additionalScopes ? { additional_scopes: i.additionalScopes } : {}),
  ...(i.loginHint ? { login_hint: i.loginHint } : {}),
  ...(i.display ? { display: i.display } : {}),
  ...(i.createIfNew ? { create_if_new: true } : {}),
});

/**
 * Connect (or reconnect) one of the signed-in user's own connections. Navigate to `authorization_url`. This stores the
 * tokens on the connection: it adds no sign-in method and needs no step-up.
 */
export function connectMyConnection(client: FapiClient, connectionId: string, input: ConnectConnectionInput): Promise<ConnectionAuthorization> {
  return call<ConnectionAuthorization>(client, `/v1/client/me/connections/${encodeURIComponent(connectionId)}/connect`, { method: 'POST', body: JSON.stringify(connectBody(input)) });
}

/** Disconnect one of the signed-in user's own connections. The answer says whether the provider confirmed the revoke. */
export function revokeMyConnection(client: FapiClient, connectionId: string): Promise<AppConnection & ConnectionRevokeResult> {
  return call<AppConnection & ConnectionRevokeResult>(client, `/v1/client/me/connections/${encodeURIComponent(connectionId)}/revoke`, { method: 'POST', body: '{}' });
}

/** Connect (or reconnect) an organization's connection (needs the org profile-manage permission, not a step-up). */
export function connectOrganizationConnection(client: FapiClient, organizationId: string, connectionId: string, input: ConnectConnectionInput): Promise<ConnectionAuthorization> {
  return call<ConnectionAuthorization>(client, `${orgBase(organizationId)}/${encodeURIComponent(connectionId)}/connect`, { method: 'POST', body: JSON.stringify(connectBody(input)) });
}

/** Disconnect an organization's connection. */
export function revokeOrganizationConnection(client: FapiClient, organizationId: string, connectionId: string): Promise<AppConnection & ConnectionRevokeResult> {
  return call<AppConnection & ConnectionRevokeResult>(client, `${orgBase(organizationId)}/${encodeURIComponent(connectionId)}/revoke`, { method: 'POST', body: '{}' });
}

const clientsBase = (organizationId: string) => `/v1/client/organizations/${encodeURIComponent(organizationId)}/connection_oauth_clients`;

/** The organization's own OAuth clients. */
export async function listOrganizationOAuthClients(client: FapiClient, organizationId: string): Promise<ConnectionOAuthClient[]> {
  return (await call<{ data: ConnectionOAuthClient[] }>(client, clientsBase(organizationId), { method: 'GET' })).data ?? [];
}

/** Set the organization's own OAuth client for a provider; it overrides the instance client for its connections. */
export function setOrganizationOAuthClient(client: FapiClient, organizationId: string, input: SetConnectionOAuthClientInput): Promise<ConnectionOAuthClient> {
  return call<ConnectionOAuthClient>(client, clientsBase(organizationId), {
    method: 'PUT',
    body: JSON.stringify({
      provider: input.provider,
      ...(input.environment ? { environment: input.environment } : {}),
      client_id: input.clientId,
      ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
      ...(input.scopes ? { scopes: input.scopes } : {}),
      ...(input.hostParams ? { host_params: input.hostParams } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    }),
  });
}

/** Delete the organization's OAuth client (refused while its connections hold tokens it issued). */
export async function deleteOrganizationOAuthClient(client: FapiClient, organizationId: string, clientId: string): Promise<void> {
  const res = await client.request<unknown>(`${clientsBase(organizationId)}/${encodeURIComponent(clientId)}`, { method: 'DELETE' });
  if (!res.ok) {
    const first = res.errors[0];
    throw new ConnectionRequestError(res.status, first?.code ?? 'UNKNOWN', first?.message ?? 'The request failed.');
  }
}
