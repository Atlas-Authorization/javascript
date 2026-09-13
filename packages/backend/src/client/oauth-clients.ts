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
  created_at: number;
  updated_at: number;
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

export interface CreateOAuthClientBody {
  name: string;
  redirect_uris: string[];
  allowed_scopes?: string[];
  grant_types?: string[];
  token_endpoint_auth_method?: 'client_secret_basic' | 'client_secret_post' | 'none';
  logo_url?: string;
  first_party?: boolean;
}

export interface UpdateOAuthClientBody {
  name?: string;
  redirect_uris?: string[];
  allowed_scopes?: string[];
  token_endpoint_auth_method?: 'client_secret_basic' | 'client_secret_post' | 'none';
  logo_url?: string | null;
  first_party?: boolean;
}

export function oauthClientsResource(request: RequestFn) {
  return {
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
