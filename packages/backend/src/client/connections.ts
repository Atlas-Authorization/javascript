import { enc, type RequestFn } from './request';
import type { CursorParams, ListPage } from './types';

export type ConnectionOwnerType = 'organization' | 'user';
export type ConnectionEnvironment = 'production' | 'sandbox';
export type ConnectionRelayMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type ConnectionStatus = 'connected' | 'needs_reauth' | 'revoked' | 'error' | 'not_connected';

/**
 * A connection: one provider account that an organization or a user owns. An OAuth connection holds its own
 * token set (sealed in the vault), independent of any user, and is never a sign-in method.
 */
export interface Connection {
  object: 'connection';
  id: string;
  owner: { type: ConnectionOwnerType; id: string };
  kind: string;
  provider: string;
  name: string;
  allowed_hosts: string[];
  config: Record<string, unknown>;
  status: ConnectionStatus;
  /** Always `data`: connecting adds no sign-in method. */
  purpose: 'data';
  environment: ConnectionEnvironment;
  sandbox: boolean;
  /** The provider-side account this connection covers (a realm, a workspace, a hub, a user id). */
  external_id: string | null;
  host_params: Record<string, string>;
  oauth_client_id: string | null;
  /** Connections from one grant (a Xero split connect) share this id and one token set; null = the connection owns its tokens. */
  token_family_id: string | null;
  scopes: string[];
  /** Epoch ms. */
  expires_at: number | null;
  metadata: Record<string, string>;
  authorized_by_user_id: string | null;
  connected_at: number | null;
  last_refreshed_at: number | null;
  status_changed_at: number | null;
  /** Why the connection left `connected`, or why the last refresh failed: the provider's own error code and HTTP status. */
  last_error: { code: string; message: string; httpStatus?: number | null; at: number } | null;
  /** Consecutive failed refreshes; 0 when healthy. */
  refresh_failures: number;
  /** When the keep-alive worker next refreshes this connection (epoch ms). */
  next_refresh_at: number | null;
  /** @deprecated Always null: a connection owns its tokens. */
  external_account_id: null;
  has_secret: boolean;
  /** When the entered credential expires (epoch ms); `connection.secret_expiring` reminders go out 30, 7 and 1 days before. */
  secret_expires_at: number | null;
  /** While a rotation's overlap window is open: when the replaced version stops being accepted. */
  previous_valid_until: number | null;
  allowed_methods: ConnectionRelayMethod[];
  created_at: number;
  updated_at: number;
}

export interface CreateConnectionBody {
  owner: { type: ConnectionOwnerType; id: string };
  kind: string;
  provider: string;
  name?: string;
  allowed_hosts: string[];
  config?: Record<string, unknown>;
  environment?: ConnectionEnvironment;
  /** Values that fill the provider's host templates, e.g. `{ subdomain: 'acme' }`. Validated per provider. */
  host_params?: Record<string, string>;
  /** Relay verbs this connection may use; GET, HEAD and POST unless set. */
  allowed_methods?: ConnectionRelayMethod[];
}

export interface UpdateConnectionBody {
  name?: string;
  allowed_hosts?: string[];
  config?: Record<string, unknown>;
  /** Transfer to another owner; the stored tokens move with it. */
  owner?: { type: ConnectionOwnerType; id: string };
  environment?: ConnectionEnvironment;
  host_params?: Record<string, string>;
  shared_by_user_id?: string;
  allowed_methods?: ConnectionRelayMethod[];
}

export interface ListConnectionsParams extends CursorParams {
  owner_type?: ConnectionOwnerType;
  owner_id?: string;
  provider?: string;
  environment?: ConnectionEnvironment;
  status?: ConnectionStatus;
}

export interface ConnectConnectionBody {
  redirect_url: string;
  host_params?: Record<string, string>;
  environment?: ConnectionEnvironment;
  additional_scopes?: string[];
  login_hint?: string;
  display?: 'redirect' | 'popup';
  /** A different provider account than the connection holds creates a sibling instead of answering 409. */
  create_if_new?: boolean;
  /** One grant covering several accounts (Xero organisations) becomes one connection per account, sharing one token set. */
  split_tenants?: boolean;
  connect_user_id?: string;
}

export interface ConnectionAuthorization {
  object: 'connection_authorization';
  connection_id: string;
  authorization_url: string;
  attempt_id: string;
}

export interface ConnectionToken {
  object: 'connection_token';
  connection_id: string;
  access_token: string;
  expires_at: number | null;
  scopes: string[];
  metadata: Record<string, string>;
  token_response: Record<string, unknown>;
  /** Further credentials by name (Slack: `user`). */
  credentials: Record<string, { access_token: string; expires_at: number | null; scopes: string[] }>;
  external_id: string | null;
  environment: ConnectionEnvironment;
  host_params: Record<string, string>;
  refreshed: boolean;
  /** jwt_bearer: the user the token acts as (domain-wide delegation). */
  subject?: string;
}

/** What the provider said when a token was revoked. The local token is cleared in every case. */
export interface ProviderRevokeResult {
  /** `true` the provider confirmed; `'unsupported'` it has no revoke endpoint; `false` it refused or was unreachable (see `provider_error`). */
  provider_revoked: boolean | 'unsupported' | 'not_connected';
  provider_status: number | null;
  provider_error: { code: string; description: string | null } | null;
  local_cleared: true;
}

export type ConnectionRevoked = Connection & ProviderRevokeResult;

export interface ConnectionDeletion extends ProviderRevokeResult {
  object: 'connection_deletion';
  id: string;
  deleted: true;
}

export interface ConnectionTokenBatchItem {
  id: string;
  status: 'ok' | 'error';
  token?: ConnectionToken;
  error?: { code: 'connection_required' | 'not_found'; reason?: 'not_connected' | 'needs_reauth' | 'revoked' | 'refresh_failed' | 'unknown_connection' };
}

/** One row of a bulk import. `external_id` is the provider-side account; a re-import of it updates the same connection. */
export interface ImportConnectionRow {
  provider: string;
  owner: { type: ConnectionOwnerType; id: string };
  external_id: string;
  refresh_token?: string;
  access_token?: string;
  /** Epoch ms or ISO 8601. */
  expires_at?: number | string;
  scopes?: string[] | string;
  metadata?: Record<string, string | number | boolean>;
  environment?: ConnectionEnvironment;
  host_params?: Record<string, string>;
  name?: string;
  allowed_hosts?: string[];
}

export interface ImportConnectionsBody {
  /** 1 to 500 rows. */
  connections: ImportConnectionRow[];
  /** Spend each refresh token against the provider and store what it issues (default true). */
  validate?: boolean;
  /** Check shapes only; never calls the provider. */
  dry_run?: boolean;
}

export interface ImportConnectionResult {
  index: number;
  status: 'created' | 'updated' | 'would_create' | 'would_update' | 'failed';
  connection_id: string | null;
  validated: boolean;
  refreshed: boolean;
  error: { code: string; message: string; field?: string; provider_error?: { code: string; description: string | null; http_status: number | null } } | null;
}

export interface ImportConnectionsResult {
  object: 'connection_import';
  total: number;
  dry_run: boolean;
  validated: boolean;
  created: number;
  updated: number;
  would_create: number;
  would_update: number;
  failed: number;
  data: ImportConnectionResult[];
}

export interface ExportConnectionsBody {
  owner_type?: ConnectionOwnerType;
  owner_id?: string;
  provider?: string;
  environment?: ConnectionEnvironment;
  status?: ConnectionStatus;
  limit?: number;
  starting_after?: string;
  /** Include the tokens, sealed to `recipient_public_key`. Needs the `connections:export_secrets` scope. */
  include_secrets?: boolean;
  /** A public JWK: RSA (3072 bits or more) or EC P-256/384/521. Never the private half. */
  recipient_public_key?: Record<string, unknown>;
}

export interface ExportedConnection {
  provider: string;
  owner: { type: ConnectionOwnerType; id: string };
  external_id: string | null;
  environment: ConnectionEnvironment;
  host_params: Record<string, string>;
  scopes: string[];
  metadata: Record<string, string>;
  name: string;
  allowed_hosts: string[];
  status: ConnectionStatus;
  expires_at: number | null;
  refresh_token?: string;
  access_token?: string;
}

export type ExportConnectionsResult =
  | { object: 'connection_export'; sealed: false; count: number; has_more: boolean; next_cursor: string | null; connections: ExportedConnection[] }
  | { object: 'connection_export'; sealed: true; count: number; has_more: boolean; next_cursor: string | null; recipient_key_id: string; bundle: string };

export interface TokenReadOptions {
  /** Refresh first unless at least this many seconds of validity remain (0 to 3600). */
  minTtlSeconds?: number;
  /** Force a refresh now. Prefer {@link refreshToken}, which does not refresh again when a peer already did. */
  refresh?: boolean;
  /** Skip the in-process cache for this call. */
  noCache?: boolean;
  /** jwt_bearer only: act as this user (Google domain-wide delegation). Never cached. */
  subject?: string;
}

/** An owner's own OAuth client (BYOK) for a provider. The secret is write-only. */
export interface ConnectionOAuthClient {
  object: 'connection_oauth_client';
  id: string;
  owner: { type: ConnectionOwnerType; id: string };
  provider: string;
  environment: ConnectionEnvironment;
  client_id: string;
  has_secret: true;
  scopes: string[];
  host_params: Record<string, string>;
  enabled: boolean;
  /** The redirect URI to register on this client at the provider. */
  callback_url: string;
  created_at: number;
  updated_at: number;
}

export interface SetConnectionOAuthClientBody {
  owner: { type: ConnectionOwnerType; id: string };
  provider: string;
  environment?: ConnectionEnvironment;
  client_id: string;
  /** Required when the client is first created; omit to keep the stored secret. */
  client_secret?: string;
  scopes?: string[];
  host_params?: Record<string, string>;
  enabled?: boolean;
}

const SKEW_MS = 60_000;

async function sha256Hex(text: string): Promise<string> {
  const d = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The credential fields of a connection's kind (write-only). api_key `{api_key}`, bearer `{token}`, basic
 * `{username, password}`, custom_header `{value}`, hmac_secret `{secret}`, client_credentials `{client_id,
 * client_secret, token_url...}`, jwt_bearer `{private_key | service_account_json | generate_key | assertion}`,
 * oauth1 `{consumer_key, consumer_secret, token?, token_secret?}`, github_app_installation `{private_key}`.
 * The kind's non-secret settings may ride along or go in `config`.
 */
export interface SetConnectionCredentialsBody {
  [field: string]: unknown;
  /** Epoch milliseconds or an ISO date. Reminders go out at 30, 7 and 1 days before. */
  expires_at?: number | string;
  config?: Record<string, unknown>;
}

export interface RotateConnectionCredentialsBody extends SetConnectionCredentialsBody {
  /** How long the replaced version stays valid, 0 to 30 days. Default 3600. */
  overlap_seconds?: number;
}

export interface ConnectionSecret {
  object: 'connection_secret';
  connection_id: string;
  kind: 'api_key' | 'bearer' | 'basic' | 'custom_header' | 'hmac_secret';
  version: number;
  /** api_key `{api_key}`, bearer `{token}`, basic `{username, password}`, custom_header `{value}`, hmac_secret `{secret}`. */
  secret: Record<string, string>;
  config: Record<string, unknown>;
  expires_at: number | null;
}

export interface ConnectionSecretVersions {
  object: 'list';
  connection_id: string;
  current_version: number | null;
  previous_valid_until: number | null;
  data: Array<{ object: 'connection_secret_version'; version: number; current: boolean; previous: boolean; created_at: number; valid_until: number | null }>;
  has_more: false;
}

export interface ConnectionSignature {
  object: 'connection_signature';
  connection_id: string;
  /** The `Authorization: OAuth ...` header value, valid for this method, URL and body only. */
  authorization: string;
  method: string;
  url: string;
}

export type ConnectionWebhookScheme = 'hubspot_v3' | 'shopify_hmac' | 'intercom' | 'zoom' | 'slack_v0' | 'calendly' | 'stripe' | 'generic_hmac_sha256';

export interface VerifyConnectionWebhookBody {
  scheme: ConnectionWebhookScheme;
  /** The delivery's headers. */
  headers: Record<string, string>;
  /** The body exactly as received. */
  raw_body: string;
  raw_body_encoding?: 'utf8' | 'base64';
  /** hubspot_v3: the method and the full URL the provider posted to. */
  method?: string;
  url?: string;
  /** Use this webhook endpoint's signing secret and options. */
  endpoint_id?: string;
  tolerance_seconds?: number;
  /** generic_hmac_sha256: `signature_header`, `encoding`, `prefix`, `algorithm`. */
  options?: Record<string, string>;
  /** false checks without remembering the delivery for replay protection. */
  record_replay?: boolean;
}

export interface ConnectionWebhookVerification {
  object: 'connection_webhook_verification';
  connection_id: string;
  scheme: ConnectionWebhookScheme;
  valid: boolean;
  reason: 'missing_signature' | 'missing_timestamp' | 'malformed_signature' | 'stale_timestamp' | 'bad_signature' | 'url_required' | 'replayed' | null;
  replayed: boolean;
  timestamp: number | null;
  delivery_id: string | null;
  /** Zoom endpoint.url_validation or Slack url_verification: answer the provider with this body. */
  handshake: Record<string, string> | null;
}

export interface ConnectionWebhookEndpoint {
  object: 'connection_webhook_endpoint';
  id: string;
  connection_id: string;
  scheme: ConnectionWebhookScheme;
  forward_url: string;
  /** Give this URL to the provider. */
  ingress_url: string;
  options: Record<string, string>;
  has_signing_secret: boolean;
  enabled: boolean;
  last_delivery_at: number | null;
  created_at: number;
  updated_at: number;
  /** Only in the create response, once: verifies the Atlas-signed deliveries sent to `forward_url`. */
  forward_secret?: string;
}

export interface CreateConnectionWebhookEndpointBody {
  scheme: ConnectionWebhookScheme;
  /** https URL that receives verified deliveries as Atlas-signed webhooks. */
  forward_url: string;
  /** Write-only provider signing secret for this endpoint. */
  signing_secret?: string;
  options?: Record<string, string>;
}

/** Org- or user-owned provider connections and their stored tokens. */
export function connectionsResource(request: RequestFn) {
  // Tokens read by this client, reused until shortly before the provider's `expires_at`. A token with no expiry is never cached.
  const cache = new Map<string, ConnectionToken>();
  const live = (t: ConnectionToken | undefined, minTtlSeconds: number): t is ConnectionToken =>
    !!t && t.expires_at !== null && t.expires_at - Date.now() > Math.max(minTtlSeconds * 1000, SKEW_MS);
  const remember = (t: ConnectionToken): ConnectionToken => {
    if (t.expires_at !== null) cache.set(t.connection_id, t);
    else cache.delete(t.connection_id);
    return t;
  };
  return {
    create(body: CreateConnectionBody, idempotencyKey?: string): Promise<Connection> {
      return request({ method: 'POST', path: '/v1/connections', body, idempotencyKey });
    },
    list(params: ListConnectionsParams = {}): Promise<ListPage<Connection>> {
      return request({ method: 'GET', path: '/v1/connections', query: { ...params } });
    },
    get(id: string): Promise<Connection> {
      return request({ method: 'GET', path: `/v1/connections/${enc(id)}` });
    },
    update(id: string, body: UpdateConnectionBody): Promise<Connection> {
      return request({ method: 'PATCH', path: `/v1/connections/${enc(id)}`, body });
    },
    /** Delete a connection. Pass `{ revoke: true }` to revoke at the provider first and learn what it said. */
    delete<R extends boolean = false>(id: string, options: { revoke?: R } = {}): Promise<R extends true ? ConnectionDeletion : void> {
      cache.delete(id);
      return request({ method: 'DELETE', path: `/v1/connections/${enc(id)}`, query: options.revoke ? { revoke: 'true' } : undefined });
    },
    /** Start the provider authorization; send the owner to `authorization_url`. */
    connect(id: string, body: ConnectConnectionBody): Promise<ConnectionAuthorization> {
      return request({ method: 'POST', path: `/v1/connections/${enc(id)}/connect`, body });
    },
    /** Revoke at the provider and forget the stored token. The answer says what the provider said (`provider_revoked`). */
    revoke(id: string): Promise<ConnectionRevoked> {
      cache.delete(id);
      return request({ method: 'POST', path: `/v1/connections/${enc(id)}/revoke` });
    },
    /**
     * The live token for your backend (refreshed when needed). Needs the `connections:token` scope.
     * Reads are cached in this client until shortly before `expires_at` (and a cached read is `refreshed: false`),
     * so calling it in a hot loop costs one request per connection per token lifetime.
     */
    async token(id: string, options: TokenReadOptions = {}): Promise<ConnectionToken> {
      const minTtl = options.minTtlSeconds ?? 0;
      const hit = cache.get(id);
      if (options.subject) {
        return request<ConnectionToken>({ method: 'GET', path: `/v1/connections/${enc(id)}/token`, query: { subject: options.subject, ...(options.refresh ? { refresh: 'true' } : {}) } });
      }
      if (!options.refresh && !options.noCache && live(hit, minTtl)) return { ...hit, refreshed: false };
      const t = await request<ConnectionToken>({
        method: 'GET',
        path: `/v1/connections/${enc(id)}/token`,
        query: { ...(options.refresh ? { refresh: 'true' } : {}), ...(minTtl ? { min_ttl_seconds: String(minTtl) } : {}) },
      });
      return remember(t);
    },
    /**
     * Call this when the provider answers 401 to a token you got from here. Pass the access token you were refused with
     * (`staleAccessToken`): if Atlas already holds a newer one, you get it back without another call to the provider.
     */
    async refreshToken(id: string, options: { staleAccessToken?: string; reason?: 'provider_401' | 'expired' | 'manual' } = {}): Promise<ConnectionToken> {
      cache.delete(id);
      const t = await request<ConnectionToken>({
        method: 'POST',
        path: `/v1/connections/${enc(id)}/token/refresh`,
        body: { reason: options.reason ?? 'provider_401', ...(options.staleAccessToken ? { stale_token_hash: await sha256Hex(options.staleAccessToken) } : {}) },
      });
      return remember(t);
    },
    /**
     * A token limited to a subset of the granted scopes, for a less-trusted caller. Not cached and never replaces the
     * connection's own token. Refused with 422 `invalid_scope` or `downscope_unsupported` (the provider cannot narrow).
     */
    downscopeToken(id: string, scopes: string[]): Promise<{ object: 'connection_token'; connection_id: string; access_token: string; expires_at: number | null; scopes: string[]; downscoped: true }> {
      return request({ method: 'POST', path: `/v1/connections/${enc(id)}/token/downscope`, body: { scopes } });
    },
    /** Read up to 100 connections' tokens in one call. Each id has its own result, so one dead connection does not fail the rest. */
    async tokens(ids: string[], options: { minTtlSeconds?: number } = {}): Promise<{ object: 'list'; data: ConnectionTokenBatchItem[]; has_more: false }> {
      const r = await request<{ object: 'list'; data: ConnectionTokenBatchItem[]; has_more: false }>({
        method: 'POST',
        path: '/v1/connections/tokens/batch',
        body: { ids, ...(options.minTtlSeconds ? { min_ttl_seconds: options.minTtlSeconds } : {}) },
      });
      for (const item of r.data) if (item.status === 'ok' && item.token) remember(item.token);
      return r;
    },
    /** Bulk-import existing provider refresh tokens (up to 500 per call). Needs the `connections:import` scope. */
    importConnections(body: ImportConnectionsBody, idempotencyKey?: string): Promise<ImportConnectionsResult> {
      return request({ method: 'POST', path: '/v1/connections/import', body, idempotencyKey });
    },
    /**
     * Export connections. Without `include_secrets` it lists metadata. With it (scope `connections:export_secrets`) the tokens
     * come back as one compact JWE sealed to `recipient_public_key`; open it with the matching private key.
     */
    exportConnections(body: ExportConnectionsBody = {}): Promise<ExportConnectionsResult> {
      return request({ method: 'POST', path: '/v1/connections/export', body, headers: body.include_secrets ? { 'x-atlas-confirm': 'export-secrets' } : undefined });
    },
    /** Enter the credential of a non-OAuth connection (write-only; sealed in the vault, never returned). */
    setCredentials(id: string, body: SetConnectionCredentialsBody): Promise<Connection> {
      return request({ method: 'PUT', path: `/v1/connections/${enc(id)}/credentials`, body });
    },
    /** Rotate the credential; the replaced version stays valid for `overlap_seconds`. */
    rotateCredentials(id: string, body: RotateConnectionCredentialsBody): Promise<Connection> {
      return request({ method: 'POST', path: `/v1/connections/${enc(id)}/credentials/rotate`, body });
    },
    /** The credential's vault versions (numbers and times, never values). */
    secretVersions(id: string): Promise<ConnectionSecretVersions> {
      return request({ method: 'GET', path: `/v1/connections/${enc(id)}/credentials/versions` });
    },
    /**
     * Read an api_key, bearer, basic, custom_header or hmac_secret credential. Needs the `connections:secret_read`
     * scope; every read is audited. `version` is `current` (default), `previous` (inside a rotation's overlap
     * window) or a number. With `organizationId` the connection must belong to that organization (404 otherwise).
     */
    secret(id: string, options: { version?: 'current' | 'previous' | number; organizationId?: string } = {}): Promise<ConnectionSecret> {
      const path = options.organizationId ? `/v1/organizations/${enc(options.organizationId)}/connections/${enc(id)}/secret` : `/v1/connections/${enc(id)}/secret`;
      return request({ method: 'GET', path, query: options.version === undefined ? undefined : { version: String(options.version) } });
    },
    /** Have Atlas sign a request with an oauth1 connection (needs `connections:sign`). */
    oauth1Sign(id: string, body: { method?: string; url: string; body?: string; content_type?: string }): Promise<ConnectionSignature> {
      return request({ method: 'POST', path: `/v1/connections/${enc(id)}/oauth1/sign`, body });
    },
    webhooks: {
      /** Verify a provider webhook signature (needs `connections:webhook_verify`). */
      verify(id: string, body: VerifyConnectionWebhookBody): Promise<ConnectionWebhookVerification> {
        return request({ method: 'POST', path: `/v1/connections/${enc(id)}/webhooks/verify`, body });
      },
      createEndpoint(id: string, body: CreateConnectionWebhookEndpointBody): Promise<ConnectionWebhookEndpoint> {
        return request({ method: 'POST', path: `/v1/connections/${enc(id)}/webhook_endpoints`, body });
      },
      listEndpoints(id: string): Promise<ListPage<ConnectionWebhookEndpoint>> {
        return request({ method: 'GET', path: `/v1/connections/${enc(id)}/webhook_endpoints` });
      },
      updateEndpoint(id: string, endpointId: string, body: { forward_url?: string; enabled?: boolean; signing_secret?: string }): Promise<ConnectionWebhookEndpoint> {
        return request({ method: 'PATCH', path: `/v1/connections/${enc(id)}/webhook_endpoints/${enc(endpointId)}`, body });
      },
      deleteEndpoint(id: string, endpointId: string): Promise<void> {
        return request({ method: 'DELETE', path: `/v1/connections/${enc(id)}/webhook_endpoints/${enc(endpointId)}` });
      },
    },
    oauthClients: {
      set(body: SetConnectionOAuthClientBody): Promise<ConnectionOAuthClient> {
        return request({ method: 'PUT', path: '/v1/connections/oauth_clients', body });
      },
      list(params: { owner_type?: ConnectionOwnerType; owner_id?: string; provider?: string } = {}): Promise<ListPage<ConnectionOAuthClient>> {
        return request({ method: 'GET', path: '/v1/connections/oauth_clients', query: { ...params } });
      },
      get(id: string): Promise<ConnectionOAuthClient> {
        return request({ method: 'GET', path: `/v1/connections/oauth_clients/${enc(id)}` });
      },
      delete(id: string): Promise<void> {
        return request({ method: 'DELETE', path: `/v1/connections/oauth_clients/${enc(id)}` });
      },
    },
  };
}
