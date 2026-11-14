import { type RequestFn } from './request';



export interface OrgRoleGrantsGetEffectiveQuery {
  /** The user whose delegated roles to list. Required. */
  user_id: string;
  /** Only roles held in this grantor organization. */
  organization_id?: string;
  /** Page size, 1-500. Without limit (and without starting_after) the whole list is returned. */
  limit?: number;
  /** Cursor: return only items after this one. Pass the previous page's `next_cursor` (the last item's id). An unknown cursor is a 400. */
  starting_after?: string;
}

export type OrgRoleGrantsGetEffectiveResult = {
  object?: 'list';
  data?: {
    /** The grantor organization the role applies in. */
    organization_id: string;
    /** The cross-organization grant the role comes through. */
    grant_id: string;
    role_key: string;
    /** The permissions the role carries. */
    permissions: string[];
  }[];
  /** Whether another page follows the cursor. */
  has_more?: boolean;
  /** The cursor to pass as `starting_after` for the next page on a keyset-paginated list; null on the last page (and absent on lists that are not cursor-paginated). */
  next_cursor?: string | null;
};

/** Operations on `/v1/org_role_grants` (1). */
export function orgRoleGrantsOpsResource(request: RequestFn) {
  return {
    /** The roles and permissions a user (user_id) holds in a grantor organization (organization_id, optional) through active delegations. */
    getEffective(query: OrgRoleGrantsGetEffectiveQuery): Promise<OrgRoleGrantsGetEffectiveResult> {
      return request({ method: 'GET', path: '/v1/org_role_grants/effective', query: { ...query } });
    },
  };
}
