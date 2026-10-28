import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

/**
 * Custom (generic) OAuth 2.0 / OpenID Connect login providers — your own
 * upstream identity provider, with Atlas as the relying party. Configure the
 * endpoints (or just an OIDC issuer), the token-endpoint client authentication
 * (incl. private_key_jwt with an Atlas-held key), a declarative profile
 * mapping, upstream logout and third-party initiated login. The provider then
 * signs users in like any built-in one: `provider: <provider_key>`.
 */

/** A claim path, a `{{template}}`, or a rule. */
export type ProfileMappingExpr =
  | string
  | {
      /** A path, or paths tried in order (the first non-empty wins). */
      from?: string | string[];
      template?: string;
      /** A constant. */
      value?: string | number | boolean | null;
      transforms?: Array<
        | 'lowercase'
        | 'uppercase'
        | 'trim'
        | 'first'
        | 'last'
        | 'compact'
        | 'unique'
        | 'to_string'
        | 'to_number'
        | 'to_boolean'
        | { split: string }
        | { join: string }
        | { index: number }
        | { replace: { find: string; with: string } }
        | { prefix: string }
        | { suffix: string }
        | { default: string | number | boolean | null }
      >;
    };

export interface ProfileMapping {
  fields?: Partial<
    Record<
      | 'id'
      | 'email'
      | 'email_verified'
      | 'first_name'
      | 'last_name'
      | 'full_name'
      | 'username'
      | 'image_url'
      | 'phone_number'
      | 'external_id',
      ProfileMappingExpr
    >
  >;
  public_metadata?: Record<string, ProfileMappingExpr>;
  private_metadata?: Record<string, ProfileMappingExpr>;
  /** Re-apply names, image and metadata on every sign-in (default: at account creation). */
  update_on_sign_in?: boolean;
}

export type TokenEndpointAuthMethod =
  | 'client_secret_basic'
  | 'client_secret_post'
  | 'client_secret_jwt'
  | 'private_key_jwt'
  | 'none';

/** One connect-time host value: `{name}` in an endpoint URL is filled from `host_params.name`, which must match `pattern` as a whole. */
export interface HostParamsSchemaEntry {
  name: string;
  pattern: string;
}

export interface UpstreamLogoutSettings {
  /** On Atlas sign-out, hand back the provider end-session URL to send the browser to. */
  rp_initiated?: boolean;
  post_logout_redirect_url?: string | null;
  /** Accept OIDC Back-Channel Logout tokens and end the matching Atlas sessions. */
  backchannel?: boolean;
  /** Accept OIDC Front-Channel Logout (the provider frames frontchannel_logout_uri). */
  frontchannel?: boolean;
  /** Front-channel: require iss + sid (default true). */
  frontchannel_session_required?: boolean;
  end_session_endpoint?: string | null;
}

export interface IdpInitiatedLoginSettings {
  enabled?: boolean;
  /** Exact URLs or bare origins a third-party initiated login may land on. */
  allowed_targets?: string[];
  default_target?: string | null;
}

export interface UpstreamSigningKey {
  object: 'upstream_signing_key';
  kid: string;
  alg: 'RS256' | 'PS256' | 'ES256';
  status: 'active' | 'retiring' | 'retired';
  public_jwk: Record<string, unknown>;
  created_at: number;
  retired_at: number | null;
}

export interface UpstreamUrls {
  /** Register at the provider as the client JWKS URL (private_key_jwt). */
  client_jwks_uri: string;
  backchannel_logout_uri: string;
  frontchannel_logout_uri: string;
  post_logout_redirect_uri: string;
  initiate_login_uri: string;
}

export interface CustomOAuthProviderSettings {
  display_name?: string;
  icon_url?: string | null;
  protocol?: 'oidc' | 'oauth2';
  issuer?: string | null;
  discovery_url?: string | null;
  authorization_endpoint?: string | null;
  token_endpoint?: string | null;
  userinfo_endpoint?: string | null;
  jwks_uri?: string | null;
  end_session_endpoint?: string | null;
  revocation_endpoint?: string | null;
  /** The connect-time `host_params` the `{name}` templates in the endpoints take (data-only providers, OAuth 2.0). */
  host_params_schema?: HostParamsSchemaEntry[] | null;
  /** Never a sign-in method: only connections use it. Required for endpoints with `{name}` templates. */
  data_only?: boolean;
  scopes?: string[];
  scope_separator?: ' ' | ',' | '+';
  pkce?: boolean;
  authorization_params?: Record<string, string> | null;
  token_params?: Record<string, string> | null;
  userinfo_auth?: 'header' | 'query';
  token_endpoint_auth_method?: TokenEndpointAuthMethod;
  client_assertion_audience?: string | null;
  profile_source?: 'merged' | 'userinfo' | 'id_token';
  profile_mapping?: ProfileMapping | null;
  logout?: UpstreamLogoutSettings | null;
  idp_initiated_login?: IdpInitiatedLoginSettings | null;
  client_id?: string;
  /** Write-only; never returned. */
  client_secret?: string;
  enabled?: boolean;
  allow_sign_in?: boolean;
  allow_sign_up?: boolean;
}

export interface CreateCustomOAuthProviderBody extends CustomOAuthProviderSettings {
  provider_key: string;
  display_name: string;
}

export interface CustomOAuthProvider extends UpstreamUrls {
  object: 'custom_oauth_provider';
  id: string;
  provider_key: string;
  display_name: string;
  icon_url: string | null;
  protocol: 'oidc' | 'oauth2';
  issuer: string | null;
  discovery_url: string | null;
  authorization_endpoint: string | null;
  token_endpoint: string | null;
  userinfo_endpoint: string | null;
  jwks_uri: string | null;
  end_session_endpoint: string | null;
  /** RFC 7009 revoke endpoint; may carry `{name}` host templates. */
  revocation_endpoint: string | null;
  host_params_schema: HostParamsSchemaEntry[];
  /** A data-only provider serves connections and is never a sign-in method. */
  data_only: boolean;
  scopes: string[];
  scope_separator: ' ' | ',' | '+';
  pkce: boolean;
  authorization_params: Record<string, string>;
  token_params: Record<string, string>;
  userinfo_auth: 'header' | 'query';
  token_endpoint_auth_method: TokenEndpointAuthMethod;
  client_assertion_audience: string | null;
  profile_source: 'merged' | 'userinfo' | 'id_token';
  profile_mapping: Required<ProfileMapping> | null;
  logout: Required<UpstreamLogoutSettings>;
  idp_initiated_login: Required<IdpInitiatedLoginSettings>;
  client_id: string | null;
  has_secret: boolean;
  enabled: boolean;
  allow_sign_in: boolean;
  allow_sign_up: boolean;
  /** Register at the provider as the redirect / callback URI. */
  redirect_uri: string;
  signing_keys: UpstreamSigningKey[];
  created_at: number;
  updated_at: number;
}

export interface ProfileMappingPreviewBody {
  profile_mapping?: ProfileMapping;
  userinfo?: Record<string, unknown>;
  id_token_claims?: Record<string, unknown>;
  /** A sample id_token — decoded, not verified. */
  id_token?: string;
}

export interface ProfileMappingPreview {
  object: 'profile_mapping_preview';
  profile: {
    id: string | null;
    email: string | null;
    email_verified: boolean;
    first_name: string | null;
    last_name: string | null;
    username: string | null;
    image_url: string | null;
    phone_number: string | null;
    external_id: string | null;
    public_metadata: Record<string, unknown>;
    private_metadata: Record<string, unknown>;
  };
  trace: Record<string, { value: unknown; source: string | null }>;
  warnings: string[];
}

export interface OidcDiscoveryResult {
  object: 'oidc_discovery';
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string | null;
  jwks_uri: string;
  end_session_endpoint: string | null;
  scopes_supported: string[];
  claims_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  token_endpoint_auth_signing_alg_values_supported: string[];
  code_challenge_methods_supported: string[];
  backchannel_logout_supported: boolean;
  backchannel_logout_session_supported: boolean;
}

/** The signing-key operations shared by custom providers and OIDC connections. */
export function upstreamSigningKeys(request: RequestFn, base: string) {
  return {
    list(): Promise<ListPage<UpstreamSigningKey>> {
      return request({ method: 'GET', path: `${base}/signing_keys` });
    },
    /** Generate a new active key; the previous one turns `retiring` (still published). */
    rotate(body: { alg?: 'RS256' | 'PS256' | 'ES256' } = {}, idempotencyKey?: string): Promise<UpstreamSigningKey> {
      return request({ method: 'POST', path: `${base}/signing_keys`, body, idempotencyKey });
    },
    /** Retire a non-active key (it leaves the JWKS). */
    retire(kid: string): Promise<{ object: 'upstream_signing_key'; kid: string; status: 'retired' }> {
      return request({ method: 'POST', path: `${base}/signing_keys/${enc(kid)}/retire` });
    },
  };
}

export function customOAuthProvidersResource(request: RequestFn) {
  const base = (id: string) => `/v1/custom_oauth_providers/${enc(id)}`;
  return {
    list(): Promise<ListPage<CustomOAuthProvider>> {
      return request({ method: 'GET', path: '/v1/custom_oauth_providers' });
    },
    get(id: string): Promise<CustomOAuthProvider> {
      return request({ method: 'GET', path: base(id) });
    },
    create(body: CreateCustomOAuthProviderBody, idempotencyKey?: string): Promise<CustomOAuthProvider> {
      return request({ method: 'POST', path: '/v1/custom_oauth_providers', body, idempotencyKey });
    },
    update(id: string, body: CustomOAuthProviderSettings, idempotencyKey?: string): Promise<CustomOAuthProvider> {
      return request({ method: 'PATCH', path: base(id), body, idempotencyKey });
    },
    delete(id: string): Promise<{ object: 'custom_oauth_provider'; id: string; provider_key: string; deleted: true }> {
      return request({ method: 'DELETE', path: base(id) });
    },
    /** Fetch + validate an issuer's OpenID configuration (for autofill). */
    discover(body: { issuer: string; discovery_url?: string }): Promise<OidcDiscoveryResult> {
      return request({ method: 'POST', path: '/v1/custom_oauth_providers/discover', body });
    },
    /**
     * Run a mapping against a pasted sample. With `id`, the provider's stored
     * mapping is used unless the body carries one.
     */
    previewProfileMapping(body: ProfileMappingPreviewBody, id?: string): Promise<ProfileMappingPreview> {
      return request({
        method: 'POST',
        path: id ? `${base(id)}/profile_mapping/preview` : '/v1/custom_oauth_providers/profile_mapping/preview',
        body,
      });
    },
    signingKeys(id: string) {
      return upstreamSigningKeys(request, base(id));
    },
  };
}
