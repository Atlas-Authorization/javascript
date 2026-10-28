import { type RequestFn } from './request';

/** A grant an OAuth client holds for a user (OpenID Grant Management): the `grant_id` token responses carry. */
export interface ManagedGrant {
  object: 'managed_grant';
  id: string;
  /** The OAuth client's public `client_id`. */
  client_id: string | null;
  user_id: string;
  organization_id: string | null;
  status: 'active' | 'revoked';
  scopes: string[];
  /** The API (resource server identifier) the grant covers. */
  resource: string | null;
  authorization_details: Record<string, unknown>[] | null;
  /** Bumped by every merge, replace and narrowing. */
  revision: number;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
  revoked_by: 'client' | 'user' | 'admin' | 'system' | null;
}

export interface ListManagedGrantsQuery {
  user_id?: string;
  /** The OAuth client's public client id. */
  client_id?: string;
  status?: 'active' | 'revoked';
  limit?: number;
}

/**
 * OpenID Grant Management grants. Backends can read, narrow and revoke what each
 * OAuth client holds for each user. Widening is the user's alone: they authorize
 * again with `grant_management_action=merge`.
 */
export function managedGrantsResource(request: RequestFn) {
  const path = (id: string) => `/v1/grant_management/grants/${encodeURIComponent(id)}`;
  return {
    list(query: ListManagedGrantsQuery = {}): Promise<{ object: 'list'; data: ManagedGrant[] }> {
      return request({ method: 'GET', path: '/v1/grant_management/grants', query: { ...query } });
    },
    get(id: string): Promise<ManagedGrant> {
      return request({ method: 'GET', path: path(id) });
    },
    /** Keep a subset of what the grant holds. A scope or authorization_details entry it does not hold is refused. */
    narrow(id: string, body: { scopes?: string[]; authorization_details?: Record<string, unknown>[] }): Promise<ManagedGrant> {
      return request({ method: 'PATCH', path: path(id), body });
    },
    /** Revoke the grant and end every token issued under it. */
    revoke(id: string): Promise<{ object: 'managed_grant'; id: string; deleted: true; tokens_ended: number }> {
      return request({ method: 'DELETE', path: path(id) });
    },
  };
}
