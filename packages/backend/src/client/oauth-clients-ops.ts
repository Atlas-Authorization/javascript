import { enc, type RequestFn } from './request';



export type OauthClientsGetExchangePolicyResult = {
  object?: 'oauth_exchange_policy';
  /** The OAuth client row id (oac_…). */
  client_id?: string;
  /** Resource server identifiers the client may exchange for; null = any it holds a client grant on. */
  allowed_audiences?: string[] | null;
  /** Scope ceiling applied on top of the client grant; null = no extra limit. */
  allowed_scopes?: string[] | null;
  /** Resource authorization server issuers this client may request an ID-JAG (Cross App Access) for; null = none. */
  id_jag_audiences?: string[] | null;
  /** false = the client must present an actor_token (delegation only). */
  allow_impersonation?: boolean;
  /** true = delegation needs a subject token carrying may_act. */
  require_may_act?: boolean;
  /** Deepest act chain the client may produce (1 to 10). */
  max_delegation_depth?: number;
  /** false = these are the defaults; no policy row exists. */
  configured?: boolean;
};

export type OauthClientsSetExchangePolicyBody = {
  allowed_audiences?: string[] | null;
  allowed_scopes?: string[] | null;
  id_jag_audiences?: string[] | null;
  allow_impersonation?: boolean;
  require_may_act?: boolean;
  max_delegation_depth?: number;
};

export type OauthClientsSetExchangePolicyResult = {
  object?: 'oauth_exchange_policy';
  /** The OAuth client row id (oac_…). */
  client_id?: string;
  /** Resource server identifiers the client may exchange for; null = any it holds a client grant on. */
  allowed_audiences?: string[] | null;
  /** Scope ceiling applied on top of the client grant; null = no extra limit. */
  allowed_scopes?: string[] | null;
  /** Resource authorization server issuers this client may request an ID-JAG (Cross App Access) for; null = none. */
  id_jag_audiences?: string[] | null;
  /** false = the client must present an actor_token (delegation only). */
  allow_impersonation?: boolean;
  /** true = delegation needs a subject token carrying may_act. */
  require_may_act?: boolean;
  /** Deepest act chain the client may produce (1 to 10). */
  max_delegation_depth?: number;
  /** false = these are the defaults; no policy row exists. */
  configured?: boolean;
};

export type OauthClientsDeleteExchangePolicyResult = {
  object?: 'oauth_exchange_policy';
  id?: string;
  deleted?: true;
};

export type OauthClientsSetProfileBody = {
  /** A built-in or custom profile name; null clears. */
  profile: string | null;
};

export type OauthClientsSetProfileResult = {
  object?: 'oauth_client_profile_assignment';
  client_id?: string;
  profile?: string | null;
};

export interface OauthClientsListOrganizationsQuery {
  /** Page size, 1-500. Without limit (and without starting_after) the whole list is returned. */
  limit?: number;
  /** Cursor: return only items after this one. Pass the previous page's `next_cursor` (the last item's id). An unknown cursor is a 400. */
  starting_after?: string;
}

export type OauthClientsListOrganizationsResult = {
  object: 'list';
  data: ({
    object: 'organization_application';
    id: string;
    organization_id: string;
    /** The application's public client identifier. */
    client_id: string;
    /** The application's id. */
    application_id?: string;
    application_name?: string | null;
    /** Organization role keys allowed to use the app; empty = every member. */
    roles: string[];
    enabled: boolean;
    created_at?: number;
    updated_at?: number;
  })[];
  has_more: boolean;
  mode?: 'open' | 'restricted';
};

export type OauthClientsSetOrganizationAccessBody = {
  mode: 'open' | 'restricted';
};

export type OauthClientsSetOrganizationAccessResult = {
  object: 'oauth_application_org_policy';
  client_id: string;
  mode: 'open' | 'restricted';
};

/** Operations on `/v1/oauth_clients` (6). */
export function oauthClientsOpsResource(request: RequestFn) {
  return {
    /** Read the token-exchange policy of an OAuth client (the defaults, with configured=false, when none is set). */
    getExchangePolicy(id: string): Promise<OauthClientsGetExchangePolicyResult> {
      return request({ method: 'GET', path: `/v1/oauth_clients/${enc(id)}/exchange_policy` });
    },
    /** Set the token-exchange policy of an OAuth client: allowed audiences and scopes, whether it may impersonate (no actor_token), whether delegation needs may_act, and the maximum act-chain depth. Audited as oauth_exchange_policy.updated. */
    setExchangePolicy(id: string, body: OauthClientsSetExchangePolicyBody): Promise<OauthClientsSetExchangePolicyResult> {
      return request({ method: 'PUT', path: `/v1/oauth_clients/${enc(id)}/exchange_policy`, body });
    },
    /** Remove the token-exchange policy of an OAuth client, restoring the defaults. */
    deleteExchangePolicy(id: string): Promise<OauthClientsDeleteExchangePolicyResult> {
      return request({ method: 'DELETE', path: `/v1/oauth_clients/${enc(id)}/exchange_policy` });
    },
    /** Assign a policy profile to an OAuth client (profile null clears it). The client must already conform (auth method, redirect URIs); the profile is then enforced at /oauth2/authorize, /oauth2/par and /oauth2/token. */
    setProfile(id: string, body: OauthClientsSetProfileBody): Promise<OauthClientsSetProfileResult> {
      return request({ method: 'PUT', path: `/v1/oauth_clients/${enc(id)}/profile`, body });
    },
    /** The organizations that have access to an application, with the application's access mode. */
    listOrganizations(id: string, query?: OauthClientsListOrganizationsQuery): Promise<OauthClientsListOrganizationsResult> {
      return request({ method: 'GET', path: `/v1/oauth_clients/${enc(id)}/organizations`, query: { ...query } });
    },
    /** Set who may use an application. `open` (default): any organization. `restricted`: only organizations granted access (and, when a grant lists roles, members holding them); a sign-in outside an entitled organization is refused with `access_denied` at the authorize endpoint. */
    setOrganizationAccess(id: string, body: OauthClientsSetOrganizationAccessBody): Promise<OauthClientsSetOrganizationAccessResult> {
      return request({ method: 'PUT', path: `/v1/oauth_clients/${enc(id)}/organization_access`, body });
    },
  };
}
