import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

export interface OAuthClient {
  object: 'oauth_client';
  id: string;
  client_id: string;
  name: string;
  logo_url: string | null;
  redirect_uris: string[];
  allowed_scopes: string[];
  grant_types: string[];
  token_endpoint_auth_method: 'client_secret_basic' | 'client_secret_post' | 'none';
  secret_prefix: string | null;
  /**
   * After a rotation with overlap: when the previous secret stops working (epoch
   * ms). Null when only the current secret is accepted.
   */
  previous_secret_expires_at?: number | null;
  is_public: boolean;
  first_party: boolean;
  /** Where the client may send users after an RP-initiated logout. */
  post_logout_redirect_uris: string[];
  /** Back-channel logout endpoint Atlas POSTs a `logout_token` to, or null. */
  backchannel_logout_uri: string | null;
  /** Whether the back-channel `logout_token` must carry `sid`. */
  backchannel_logout_session_required: boolean;
  /** Front-channel logout URL Atlas loads in an iframe on sign-out, or null. */
  frontchannel_logout_uri: string | null;
  /** Whether `iss` and `sid` are appended to the front-channel logout URL. */
  frontchannel_logout_session_required: boolean;
  /**
   * RP-initiated logout with this client's `client_id` and an exactly registered
   * `post_logout_redirect_uri` ends the session and redirects straight back,
   * with no "Sign out?" page. First-party clients only.
   */
  skip_logout_confirmation?: boolean;
  created_at: number;
  updated_at: number;
}

/**
 * OIDC logout registration (RP-Initiated, Back-Channel and Front-Channel
 * Logout), accepted on create and update. On update, `null` clears a URI and
 * `[]` clears the post-logout redirect list.
 */
export interface OAuthClientLogoutFields {
  post_logout_redirect_uris?: string[];
  backchannel_logout_uri?: string | null;
  backchannel_logout_session_required?: boolean;
  frontchannel_logout_uri?: string | null;
  frontchannel_logout_session_required?: boolean;
  /** Skip the logout confirmation page. First-party clients only (`422` otherwise). */
  skip_logout_confirmation?: boolean;
}

/** Create/rotate reveal the secret exactly once, alongside the client. */
export interface OAuthClientWithSecret extends OAuthClient {
  client_secret?: string;
  note: string;
}

export interface RotateOAuthClientSecretBody {
  /**
   * How long the previous secret keeps working, in seconds. Default 86400 (24
   * hours); 0 revokes it now (after a leak); at most 604800 (7 days).
   */
  overlap_seconds?: number;
}

/** The rotate response: the new secret (shown once) and when the old one stops working. */
export interface OAuthClientSecretRotation extends OAuthClientWithSecret {
  client_secret: string;
  /** The overlap applied, in seconds. */
  overlap_seconds: number;
  /** When the previous secret stops working (epoch ms), or null when it already has. */
  previous_secret_expires_at: number | null;
}

export interface ClientGrant {
  object: 'client_grant';
  id: string;
  /** The internal OAuthClient.id (not the public client_id). */
  client_id: string;
  resource_server_id: string;
  scopes: string[];
  created_at: number;
  updated_at: number;
}

export interface CreateOAuthClientBody extends OAuthClientLogoutFields {
  name: string;
  redirect_uris: string[];
  allowed_scopes?: string[];
  grant_types?: string[];
  token_endpoint_auth_method?: 'client_secret_basic' | 'client_secret_post' | 'none';
  logo_url?: string;
  first_party?: boolean;
}

export interface UpdateOAuthClientBody extends OAuthClientLogoutFields {
  name?: string;
  redirect_uris?: string[];
  allowed_scopes?: string[];
  token_endpoint_auth_method?: 'client_secret_basic' | 'client_secret_post' | 'none';
  logo_url?: string | null;
  first_party?: boolean;
}

/** One client in a migration import. Idempotent per `client_id`. */
export interface ImportOAuthClientEntry {
  /** Preserve the existing client_id. */
  client_id: string;
  name: string;
  redirect_uris: string[];
  /** Plaintext secret; hashed on import. Write-only. */
  client_secret?: string;
  /** A pre-computed secret hash imported verbatim (instead of `client_secret`). */
  client_secret_hash?: string;
  allowed_scopes?: string[];
  grant_types?: string[];
  token_endpoint_auth_method?: string;
}

/** An imported client as returned by `import`. */
export interface ImportedOAuthClient extends OAuthClient {
  client_secret?: string;
}

/**
 * One back-channel logout attempt to a client's `backchannel_logout_uri`.
 * Atlas never follows redirects: a 3xx fails with
 * `error: 'backchannel_redirect_not_followed'` and the `location` it pointed at.
 */
export interface BackchannelLogoutDelivery {
  object: 'backchannel_logout_delivery';
  id: string;
  oauth_client_id: string | null;
  /** The ended session (`sid_test_…` for a test); null for "sign out everywhere". */
  sid: string | null;
  /** Sent by `testBackchannelLogout`; never retried. */
  test: boolean;
  status: 'pending' | 'success' | 'failed';
  attempt_number: number;
  max_attempts: number;
  http_status: number | null;
  latency_ms: number | null;
  /**
   * `backchannel_redirect_not_followed`, `backchannel_http_error`,
   * `backchannel_timeout`, `backchannel_network_error` or `backchannel_url_blocked`.
   */
  error: string | null;
  location: string | null;
  response_snippet: string | null;
  next_retry_at: number | null;
  attempted_at: number | null;
  delivered_at: number | null;
  created_at: number;
}

/** A page of {@link BackchannelLogoutDelivery}, newest first. */
export interface BackchannelLogoutDeliveryPage extends ListPage<BackchannelLogoutDelivery> {
  has_more: boolean;
  /** Pass as `starting_after` for the next page. */
  next_cursor: string | null;
}

/** Paging for a delivery log. */
export interface BackchannelDeliveriesQuery {
  limit?: number;
  starting_after?: string;
}

/** The result of a test back-channel logout (a signed token for `sid_test_…` with `atlas_test: true`). */
export interface BackchannelLogoutTest {
  object: 'backchannel_logout_test';
  delivery_id: string;
  /** True when the receiver answered 2xx. */
  ok: boolean;
  sid: string;
  status: number | null;
  latency_ms: number | null;
  error: string | null;
  location: string | null;
  /** Set when nothing was sent because the URI points at a private, loopback or non-https address. */
  blocked_reason: string | null;
  /** First 512 characters of the response body. */
  body_excerpt: string | null;
}

export function oauthClientsResource(request: RequestFn) {
  return {
    /** Bulk-import OAuth clients for a migration, optionally with pre-hashed secrets. */
    import(
      body: { clients: ImportOAuthClientEntry[] },
      idempotencyKey?: string,
    ): Promise<ListPage<ImportedOAuthClient>> {
      return request({ method: 'POST', path: '/v1/oauth_clients/import', body, idempotencyKey });
    },
    list(): Promise<ListPage<OAuthClient>> {
      return request({ method: 'GET', path: '/v1/oauth_clients' });
    },
    get(id: string): Promise<OAuthClient> {
      return request({ method: 'GET', path: `/v1/oauth_clients/${enc(id)}` });
    },
    create(body: CreateOAuthClientBody, idempotencyKey?: string): Promise<OAuthClientWithSecret> {
      return request({ method: 'POST', path: '/v1/oauth_clients', body, idempotencyKey });
    },
    update(id: string, body: UpdateOAuthClientBody): Promise<OAuthClient> {
      return request({ method: 'PATCH', path: `/v1/oauth_clients/${enc(id)}`, body });
    },
    /**
     * Mint a new secret. The previous one keeps working for `overlap_seconds`
     * (default 24 hours, max 7 days; 0 = revoke it now).
     */
    rotateSecret(
      id: string,
      body: RotateOAuthClientSecretBody = {},
      idempotencyKey?: string,
    ): Promise<OAuthClientSecretRotation> {
      return request({
        method: 'POST',
        path: `/v1/oauth_clients/${enc(id)}/rotate_secret`,
        body,
        idempotencyKey,
      });
    },
    delete(id: string): Promise<{ object: 'oauth_client'; id: string; deleted: true; note: string }> {
      return request({ method: 'DELETE', path: `/v1/oauth_clients/${enc(id)}` });
    },
    /** The client's back-channel logout delivery log, newest first. */
    listBackchannelDeliveries(
      id: string,
      query: BackchannelDeliveriesQuery = {},
    ): Promise<BackchannelLogoutDeliveryPage> {
      return request({
        method: 'GET',
        path: `/v1/oauth_clients/${enc(id)}/backchannel_deliveries`,
        query: { ...query },
      });
    },
    /** Send a test back-channel logout now and return what the receiver answered. */
    testBackchannelLogout(id: string): Promise<BackchannelLogoutTest> {
      return request({ method: 'POST', path: `/v1/oauth_clients/${enc(id)}/backchannel_logout/test` });
    },

    grants: {
      list(clientId: string): Promise<ListPage<ClientGrant>> {
        return request({ method: 'GET', path: `/v1/oauth_clients/${enc(clientId)}/grants` });
      },
      create(
        clientId: string,
        body: { resource_server_id: string; scopes?: string[] },
      ): Promise<ClientGrant> {
        return request({
          method: 'POST',
          path: `/v1/oauth_clients/${enc(clientId)}/grants`,
          body,
        });
      },
      delete(
        clientId: string,
        grantId: string,
      ): Promise<{ object: 'client_grant'; id: string; deleted: true }> {
        return request({
          method: 'DELETE',
          path: `/v1/oauth_clients/${enc(clientId)}/grants/${enc(grantId)}`,
        });
      },
    },
  };
}
