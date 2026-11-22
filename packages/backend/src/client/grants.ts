import { type RequestFn } from './request';

/** A grant of either kind: the user's recorded consent, or an OpenID Grant Management grant (`grant_id`). */
export interface OAuthGrant {
  object: 'grant';
  id: string;
  /** `consent` is the user's recorded consent; `managed` is a Grant Management grant. */
  type: 'consent' | 'managed';
  /** The OAuth client's public `client_id`. */
  client_id: string | null;
  client_name: string | null;
  user_id: string;
  organization_id: string | null;
  status: 'active' | 'revoked';
  scopes: string[];
  /** Managed grants: the API the grant covers. */
  resource?: string | null;
  authorization_details?: Record<string, unknown>[] | null;
  /** Managed grants: bumped by every merge, replace and narrowing. */
  revision?: number;
  /** The JSON you set at consent accept or with `update`. Never shown to the user. */
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
  /** The last time a token was issued or refreshed under the grant (Unix ms). */
  last_used_at: number | null;
  revoked_at: number | null;
  revoked_by?: 'client' | 'user' | 'admin' | 'system' | null;
}

export interface ListGrantsQuery {
  user_id?: string;
  /** The OAuth client's public client id. */
  client_id?: string;
  type?: 'consent' | 'managed' | 'all';
  /** Default `active`. */
  status?: 'active' | 'revoked' | 'all';
  /** 1 to 100, default 50. */
  limit?: number;
  /** The `next_cursor` of the previous page. */
  starting_after?: string;
}

/**
 * One grant API for both kinds of grant: list, read, change the metadata of, and revoke
 * them. Revoking either kind ends the consent, the Grant Management grants and every
 * refresh token of that client for the user.
 */
export function grantsResource(request: RequestFn) {
  const path = (id: string) => `/v1/grants/${encodeURIComponent(id)}`;
  return {
    list(query: ListGrantsQuery = {}): Promise<{ object: 'list'; data: OAuthGrant[]; has_more: boolean; next_cursor: string | null }> {
      return request({ method: 'GET', path: '/v1/grants', query: { ...query } });
    },
    get(id: string): Promise<OAuthGrant> {
      return request({ method: 'GET', path: path(id) });
    },
    /** Merge `metadata` into the grant's (a key set to null is removed). At most 4 KB of JSON in all. */
    update(id: string, body: { metadata: Record<string, unknown> }): Promise<OAuthGrant> {
      return request({ method: 'PATCH', path: path(id), body });
    },
    revoke(id: string): Promise<{ object: 'grant'; id: string; type: 'consent' | 'managed'; deleted: true; tokens_revoked: number }> {
      return request({ method: 'DELETE', path: path(id) });
    },
  };
}
