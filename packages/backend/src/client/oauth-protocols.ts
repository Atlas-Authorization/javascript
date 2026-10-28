import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

export interface RefreshToken {
  object: 'refresh_token';
  id: string;
  client_id: string;
  user_id: string;
  organization_id: string | null;
  status: 'active' | 'revoked' | 'expired' | 'replaced';
  scope: string;
  audience: string | null;
  sender_constrained: boolean;
  created_at: number;
  expires_at: number;
  idle_expires_at: number;
}

export interface OpKey {
  object: 'op_key';
  kid: string;
  alg: 'PS256' | 'ES384' | 'EdDSA' | 'RSA-OAEP-256' | 'ECDH-ES';
  use: 'sig' | 'enc';
  status: 'current' | 'previous';
  retires_at: number | null;
  created_at: number;
}

export interface TokenExchangeProfile {
  object: 'oauth_token_exchange_profile';
  id: string;
  client_id: string;
  name: string;
  subject_token_type: string;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

export interface Federation {
  object: 'federation';
  enabled: boolean;
  entity_id: string;
  entity_configuration_url: string;
  federation_fetch_endpoint: string | null;
  federation_list_endpoint: string | null;
  federation_resolve_endpoint: string;
  federation_registration_endpoint: string | null;
  authority_hints: string[];
  trust_anchors: string[];
  subordinates: string[];
  automatic_registration: boolean;
  explicit_registration: boolean;
}

export type FederationResolution =
  | { object: 'federation_resolution'; entity_id: string; valid: true; trust_anchor: string; entities: string[]; expires_at: number; metadata: Record<string, unknown> }
  | { object: 'federation_resolution'; entity_id: string; valid: false; error: string; error_description: string };

/** Refresh-token search and bulk revoke; the OpenID provider's extra keys; custom token-exchange subject types. */
export function oauthProtocolsResource(request: RequestFn) {
  const profiles = (clientId: string) => `/v1/oauth_clients/${enc(clientId)}/token_exchange_profiles`;
  return {
    refreshTokens: {
      /** Search the refresh grants OAuth apps hold. Tokens and hashes are never returned. */
      list(query: { user_id?: string; client_id?: string; status?: RefreshToken['status']; limit?: number } = {}): Promise<ListPage<RefreshToken>> {
        return request({ method: 'GET', path: '/v1/refresh_tokens', query });
      },
      /** Revoke by ids, or every active grant of a user and / or app. A request with no filter is refused. */
      revoke(body: { ids?: string[]; user_id?: string; client_id?: string }): Promise<{ object: 'refresh_token_revocation'; revoked: number }> {
        return request({ method: 'POST', path: '/v1/refresh_tokens/revoke', body });
      },
    },
    federation: {
      /** This instance's OpenID Federation entity identifier, endpoints and configured anchors. */
      get(): Promise<Federation> {
        return request({ method: 'GET', path: '/v1/federation' });
      },
      /** Dry-run: resolve an entity's trust chain against the configured anchors. Registers nothing. */
      resolve(body: { entity_id: string; trust_anchor?: string }): Promise<FederationResolution> {
        return request({ method: 'POST', path: '/v1/federation/resolve', body });
      },
    },
    opKeys: {
      list(): Promise<ListPage<OpKey>> {
        return request({ method: 'GET', path: '/v1/instance/op_keys' });
      },
      /** Rotate one algorithm's key; the previous public key stays published for the grace window. */
      rotate(body: { alg: OpKey['alg']; grace_period_seconds?: number }): Promise<OpKey> {
        return request({ method: 'POST', path: '/v1/instance/op_keys/rotate', body });
      },
    },
    tokenExchangeProfiles: {
      list(clientId: string): Promise<ListPage<TokenExchangeProfile>> {
        return request({ method: 'GET', path: profiles(clientId) });
      },
      create(clientId: string, body: { name: string; subject_token_type: string; enabled?: boolean }): Promise<TokenExchangeProfile> {
        return request({ method: 'POST', path: profiles(clientId), body });
      },
      update(clientId: string, profileId: string, body: { name?: string; enabled?: boolean }): Promise<TokenExchangeProfile> {
        return request({ method: 'PATCH', path: `${profiles(clientId)}/${enc(profileId)}`, body });
      },
      delete(clientId: string, profileId: string): Promise<void> {
        return request({ method: 'DELETE', path: `${profiles(clientId)}/${enc(profileId)}` });
      },
    },
  };
}
