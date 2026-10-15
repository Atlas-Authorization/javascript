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
    rotateSecret(id: string): Promise<OAuthClientWithSecret> {
      return request({ method: 'POST', path: `/v1/oauth_clients/${enc(id)}/rotate_secret` });
    },
    delete(id: string): Promise<{ object: 'oauth_client'; id: string; deleted: true; note: string }> {
      return request({ method: 'DELETE', path: `/v1/oauth_clients/${enc(id)}` });
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
