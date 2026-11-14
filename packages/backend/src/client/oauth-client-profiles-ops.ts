import { enc, type RequestFn } from './request';



export interface OauthClientProfilesListQuery {
  /** Page size, 1-500. Without limit (and without starting_after) the whole list is returned. */
  limit?: number;
  /** Cursor: return only items after this one. Pass the previous page's `next_cursor` (the last item's id). An unknown cursor is a 400. */
  starting_after?: string;
}

export type OauthClientProfilesListResult = {
  object?: 'list';
  data?: ({
    object?: 'oauth_client_profile';
    name?: string;
    builtin?: boolean;
    description?: string | null;
    require_pkce?: boolean;
    /** Authorization requests must be pushed (RFC 9126). */
    require_par?: boolean;
    /** The token request must prove DPoP, mutual TLS, or either (any). */
    sender_constraint?: 'none' | 'dpop' | 'mtls' | 'any';
    /** Authorization requests must be a signed request object (RFC 9101), pushed or direct. */
    require_signed_request?: boolean;
    /** Allowed client authentication methods; null = any. */
    token_endpoint_auth_methods?: string[] | null;
    /** JWS algorithms accepted for request objects and client assertions; null = any asymmetric. */
    signing_algs?: string[] | null;
    https_redirects_only?: boolean;
    /** Claim names a `claims` request may ask for; null = any. */
    allowed_claims?: string[] | null;
  })[];
  /** Whether another page follows the cursor. */
  has_more?: boolean;
  /** The cursor to pass as `starting_after` for the next page on a keyset-paginated list; null on the last page (and absent on lists that are not cursor-paginated). */
  next_cursor?: string | null;
};

export type OauthClientProfilesSetBody = {
  description?: string | null;
  require_pkce?: boolean;
  /** Authorization requests must be pushed (RFC 9126). */
  require_par?: boolean;
  /** The token request must prove DPoP, mutual TLS, or either (any). */
  sender_constraint?: 'none' | 'dpop' | 'mtls' | 'any';
  /** Authorization requests must be a signed request object (RFC 9101), pushed or direct. */
  require_signed_request?: boolean;
  /** Allowed client authentication methods; null = any. */
  token_endpoint_auth_methods?: string[] | null;
  /** JWS algorithms accepted for request objects and client assertions; null = any asymmetric. */
  signing_algs?: string[] | null;
  https_redirects_only?: boolean;
  /** Claim names a `claims` request may ask for; null = any. */
  allowed_claims?: string[] | null;
};

export type OauthClientProfilesSetResult = {
  object?: 'oauth_client_profile';
  name?: string;
  builtin?: boolean;
  description?: string | null;
  require_pkce?: boolean;
  /** Authorization requests must be pushed (RFC 9126). */
  require_par?: boolean;
  /** The token request must prove DPoP, mutual TLS, or either (any). */
  sender_constraint?: 'none' | 'dpop' | 'mtls' | 'any';
  /** Authorization requests must be a signed request object (RFC 9101), pushed or direct. */
  require_signed_request?: boolean;
  /** Allowed client authentication methods; null = any. */
  token_endpoint_auth_methods?: string[] | null;
  /** JWS algorithms accepted for request objects and client assertions; null = any asymmetric. */
  signing_algs?: string[] | null;
  https_redirects_only?: boolean;
  /** Claim names a `claims` request may ask for; null = any. */
  allowed_claims?: string[] | null;
};

export type OauthClientProfilesDeleteResult = {
  object?: 'oauth_client_profile';
  id?: string;
  deleted?: true;
};

/** Operations on `/v1/oauth_client_profiles` (3). */
export function oauthClientProfilesOpsResource(request: RequestFn) {
  return {
    /** List the OAuth client policy profiles: the built-ins (fapi2_security, fapi2_message_signing, pkce_required, par_required, dpop_required) and your custom ones. */
    list(query?: OauthClientProfilesListQuery): Promise<OauthClientProfilesListResult> {
      return request({ method: 'GET', path: '/v1/oauth_client_profiles', query: { ...query } });
    },
    /** Create or replace a custom client policy profile (rules: PKCE, PAR, sender constraint, signed request object, allowed auth methods and signing algorithms, https-only redirects, allowed claims). Built-in names are reserved. */
    set(name: string, body: OauthClientProfilesSetBody): Promise<OauthClientProfilesSetResult> {
      return request({ method: 'PUT', path: `/v1/oauth_client_profiles/${enc(name)}`, body });
    },
    /** Delete a custom client policy profile. 409 while any client is assigned it. */
    delete(name: string): Promise<OauthClientProfilesDeleteResult> {
      return request({ method: 'DELETE', path: `/v1/oauth_client_profiles/${enc(name)}` });
    },
  };
}
