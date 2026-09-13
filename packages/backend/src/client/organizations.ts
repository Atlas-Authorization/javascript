import { enc, type RequestFn } from './request';
import type { CursorPage, CursorParams, DataList, DeletedObject, ListPage, Metadata } from './types';

export interface Organization {
  object: 'organization';
  id: string;
  name: string;
  slug: string;
  image_url: string | null;
  public_metadata: Metadata;
  max_allowed_memberships: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface OrganizationMembership {
  object: 'organization_membership';
  id: string;
  organization_id: string;
  user_id: string;
  role: string;
  created_at: number;
}

export interface OrganizationInvitation {
  object: 'organization_invitation';
  id: string;
  organization_id: string;
  email: string;
  role: string;
  status: string;
  inviter_user_id: string;
  expires_at: number;
  created_at: number;
}

export interface OrgDomain {
  object: 'org_domain';
  id: string;
  organization_id: string;
  domain: string;
  status: string;
  auto_join: boolean;
  default_role_id: string | null;
  verification: {
    record_name: string;
    record_type: 'TXT';
    record_value: string;
  };
  verified_at: number | null;
  last_checked_at: number | null;
  created_at: number;
}

export interface OrganizationPolicy {
  object: 'organization_policy';
  organization_id: string;
  policy: Record<string, unknown>;
}

export interface OrganizationHierarchy {
  object: 'organization_hierarchy';
  organization_id: string;
  ancestors: Array<{ id: string; name: string; slug: string }>;
  children: Array<{ id: string; name: string; slug: string }>;
}

export interface OrganizationEntitlements {
  object: 'organization_entitlements';
  organization_id: string;
  plan: string | null;
  features: Record<string, unknown>;
  catalog: { features: unknown; plans: unknown };
}

export interface CreateOrganizationBody {
  name: string;
  slug: string;
  created_by: string;
  max_allowed_memberships?: number;
}

export interface UpdateOrganizationBody {
  name?: string;
  slug?: string;
  image_url?: string;
  max_allowed_memberships?: number;
  public_metadata?: Metadata;
  private_metadata?: Metadata;
}

export interface ReplaceOrganizationMetadataBody {
  public_metadata?: Metadata;
  private_metadata?: Metadata;
}

/** The org security policy patch (§4.4). Fields are camelCase on this route. */
export interface OrganizationPolicyPatch {
  requireMfa?: boolean;
  ssoRequired?: boolean;
  sessionIdleOverrideMs?: number | null;
  [key: string]: unknown;
}

export function organizationsResource(request: RequestFn) {
  return {
    list(params: CursorParams = {}): Promise<CursorPage<Organization>> {
      return request({ method: 'GET', path: '/v1/organizations', query: { ...params } });
    },
    get(id: string): Promise<Organization> {
      return request({ method: 'GET', path: `/v1/organizations/${enc(id)}` });
    },
    create(body: CreateOrganizationBody, idempotencyKey?: string): Promise<Organization> {
      return request({ method: 'POST', path: '/v1/organizations', body, idempotencyKey });
    },
    update(id: string, body: UpdateOrganizationBody): Promise<Organization> {
      return request({ method: 'PATCH', path: `/v1/organizations/${enc(id)}`, body });
    },
    delete(id: string): Promise<DeletedObject> {
      return request({ method: 'DELETE', path: `/v1/organizations/${enc(id)}` });
    },
    /** `PUT /v1/organizations/:id/metadata` — replaces the named bags wholesale. */
    updateMetadata(id: string, body: ReplaceOrganizationMetadataBody): Promise<Organization> {
      return request({ method: 'PUT', path: `/v1/organizations/${enc(id)}/metadata`, body });
    },
    /** `PATCH /v1/organizations/:id/policy`. */
    updatePolicy(id: string, body: OrganizationPolicyPatch): Promise<OrganizationPolicy> {
      return request({ method: 'PATCH', path: `/v1/organizations/${enc(id)}/policy`, body });
    },
    /**
     * `PUT /v1/organizations/:id/parent` — set (or clear, with null) the org's
     * parent in the B2B2B hierarchy. A cycle is refused; clearing re-parents to
     * top level.
     */
    setParent(id: string, body: { parent_organization_id: string | null }): Promise<Organization> {
      return request({ method: 'PUT', path: `/v1/organizations/${enc(id)}/parent`, body });
    },
    /** `GET /v1/organizations/:id/hierarchy` — ancestor chain (nearest first) + direct children. */
    hierarchy(id: string): Promise<OrganizationHierarchy> {
      return request({ method: 'GET', path: `/v1/organizations/${enc(id)}/hierarchy` });
    },
    /**
     * `GET /v1/organizations/:id/entitlements` — the org's active feature set,
     * resolved from its assigned plan + overrides against the instance catalog.
     */
    entitlements(id: string): Promise<OrganizationEntitlements> {
      return request({ method: 'GET', path: `/v1/organizations/${enc(id)}/entitlements` });
    },

    memberships: {
      list(orgId: string): Promise<{ data: OrganizationMembership[]; has_more: boolean }> {
        return request({ method: 'GET', path: `/v1/organizations/${enc(orgId)}/memberships` });
      },
      add(
        orgId: string,
        body: { user_id: string; role?: string },
        idempotencyKey?: string,
      ): Promise<{
        object: 'organization_membership';
        organization_id: string;
        user_id: string;
        role: string;
      }> {
        return request({
          method: 'POST',
          path: `/v1/organizations/${enc(orgId)}/memberships`,
          body,
          idempotencyKey,
        });
      },
      update(
        orgId: string,
        userId: string,
        body: { role: string },
      ): Promise<{ object: 'organization_membership'; role: string; updated: true }> {
        return request({
          method: 'PATCH',
          path: `/v1/organizations/${enc(orgId)}/memberships/${enc(userId)}`,
          body,
        });
      },
      remove(
        orgId: string,
        userId: string,
      ): Promise<{ object: 'organization_membership'; deleted: true }> {
        return request({
          method: 'DELETE',
          path: `/v1/organizations/${enc(orgId)}/memberships/${enc(userId)}`,
        });
      },
    },

    invitations: {
      list(orgId: string): Promise<ListPage<OrganizationInvitation>> {
        return request({ method: 'GET', path: `/v1/organizations/${enc(orgId)}/invitations` });
      },
      create(
        orgId: string,
        body: { email: string; role: string; inviter_user_id: string },
        idempotencyKey?: string,
      ): Promise<{
        object: 'organization_invitation';
        id: string;
        organization_id: string;
        email: string;
        status: string;
        expires_at: number;
      }> {
        return request({
          method: 'POST',
          path: `/v1/organizations/${enc(orgId)}/invitations`,
          body,
          idempotencyKey,
        });
      },
      revoke(
        orgId: string,
        invitationId: string,
      ): Promise<{ object: 'organization_invitation'; id: string; status: 'revoked' }> {
        return request({
          method: 'POST',
          path: `/v1/organizations/${enc(orgId)}/invitations/${enc(invitationId)}/revoke`,
        });
      },
    },

    domains: {
      list(orgId: string): Promise<DataList<OrgDomain> & { object: 'list' }> {
        return request({ method: 'GET', path: `/v1/organizations/${enc(orgId)}/domains` });
      },
      create(
        orgId: string,
        body: { domain: string; auto_join?: boolean; default_role_id?: string | null },
        idempotencyKey?: string,
      ): Promise<OrgDomain> {
        return request({
          method: 'POST',
          path: `/v1/organizations/${enc(orgId)}/domains`,
          body,
          idempotencyKey,
        });
      },
      verify(orgId: string, domainId: string): Promise<OrgDomain & { verified: boolean }> {
        return request({
          method: 'POST',
          path: `/v1/organizations/${enc(orgId)}/domains/${enc(domainId)}/verify`,
        });
      },
      delete(
        orgId: string,
        domainId: string,
      ): Promise<{ object: 'org_domain'; id: string; deleted: true }> {
        return request({
          method: 'DELETE',
          path: `/v1/organizations/${enc(orgId)}/domains/${enc(domainId)}`,
        });
      },
    },

    /** Directory-group → role grants that augment members' permissions. */
    groupRoles: {
      grant(
        orgId: string,
        groupId: string,
        roleId: string,
      ): Promise<{
        object: 'group_role_grant';
        organization_id: string;
        group_id: string;
        role_id: string;
        granted: true;
      }> {
        return request({
          method: 'PUT',
          path: `/v1/organizations/${enc(orgId)}/groups/${enc(groupId)}/roles/${enc(roleId)}`,
        });
      },
      revoke(
        orgId: string,
        groupId: string,
        roleId: string,
      ): Promise<{
        object: 'group_role_grant';
        organization_id: string;
        group_id: string;
        role_id: string;
        deleted: boolean;
      }> {
        return request({
          method: 'DELETE',
          path: `/v1/organizations/${enc(orgId)}/groups/${enc(groupId)}/roles/${enc(roleId)}`,
        });
      },
    },
  };
}
