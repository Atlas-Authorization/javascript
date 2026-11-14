import { enc, type RequestFn } from './request';



export interface OrganizationConnectionsListQuery {
  /** Only connections in which this organization is the supplier or the partner. */
  organization_id?: string;
  /** Page size, 1-500. Without limit (and without starting_after) the whole list is returned. */
  limit?: number;
  /** Cursor: return only items after this one. Pass the previous page's `next_cursor` (the last item's id). An unknown cursor is a 400. */
  starting_after?: string;
}

export type OrganizationConnectionsListResult = {
  object: 'list';
  data: ({
    object: 'organization_connection';
    id: string;
    supplier_organization_id?: string;
    partner_organization_id?: string;
    application_id?: string;
    roles?: string[];
    status: 'pending' | 'active' | 'revoked' | 'expired';
    expires_at?: number;
    accepted_by?: string | null;
    created_at?: number;
  })[];
  has_more: boolean;
};

export type OrganizationConnectionsCreateBody = {
  supplier_organization_id: string;
  partner_organization_id: string;
  application: string;
  roles?: string[];
};

export type OrganizationConnectionsCreateResult = {
  object: 'organization_connection';
  id: string;
  supplier_organization_id?: string;
  partner_organization_id?: string;
  application_id?: string;
  roles?: string[];
  status: 'pending' | 'active' | 'revoked' | 'expired';
  expires_at?: number;
  accepted_by?: string | null;
  created_at?: number;
} & {
  token?: string;
  note?: string;
};

export type OrganizationConnectionsAcceptBody = {
  token: string;
  accepted_by?: string;
};

export type OrganizationConnectionsAcceptResult = {
  object: 'organization_connection';
  id: string;
  supplier_organization_id?: string;
  partner_organization_id?: string;
  application_id?: string;
  roles?: string[];
  status: 'pending' | 'active' | 'revoked' | 'expired';
  expires_at?: number;
  accepted_by?: string | null;
  created_at?: number;
};

export type OrganizationConnectionsDeleteResult = {
  object: 'organization_connection';
  id: string;
  supplier_organization_id?: string;
  partner_organization_id?: string;
  application_id?: string;
  roles?: string[];
  status: 'pending' | 'active' | 'revoked' | 'expired';
  expires_at?: number;
  accepted_by?: string | null;
  created_at?: number;
};

/** Operations on `/v1/organization_connections` (4). */
export function organizationConnectionsOpsResource(request: RequestFn) {
  return {
    /** B2B connections between organizations, optionally those involving one organization. */
    list(query?: OrganizationConnectionsListQuery): Promise<OrganizationConnectionsListResult> {
      return request({ method: 'GET', path: '/v1/organization_connections', query: { ...query } });
    },
    /** Invite a partner organization to use an application the supplier organization holds. Returns a one-time `token` for the partner's administrator; the invitation lasts 14 days. */
    create(body: OrganizationConnectionsCreateBody, idempotencyKey?: string): Promise<OrganizationConnectionsCreateResult> {
      return request({ method: 'POST', path: '/v1/organization_connections', body, idempotencyKey });
    },
    /** Accept an invitation with its token: the partner organization gains access to the application. The token works once. */
    accept(id: string, body: OrganizationConnectionsAcceptBody, idempotencyKey?: string): Promise<OrganizationConnectionsAcceptResult> {
      return request({ method: 'POST', path: `/v1/organization_connections/${enc(id)}/accept`, body, idempotencyKey });
    },
    /** Revoke a connection (or a pending invitation). The partner organization loses access to the application. */
    delete(id: string): Promise<OrganizationConnectionsDeleteResult> {
      return request({ method: 'DELETE', path: `/v1/organization_connections/${enc(id)}` });
    },
  };
}
