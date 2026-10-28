import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

export interface OrgRoleGrant {
  object: 'org_role_grant';
  id: string;
  grantor_org_id: string;
  grantee_org_id: string;
  role_keys: string[];
  status: 'active' | 'revoked';
  created_at: number;
  revoked_at: number | null;
}

export interface OrgRoleDelegation {
  object: 'org_role_delegation';
  id: string;
  grant_id: string;
  user_id: string;
  role_key: string;
  created_at: number;
}

export interface EffectiveDelegatedRole {
  organization_id: string;
  grant_id: string;
  role_key: string;
  permissions: string[];
}

const qs = (query: Record<string, string | undefined>) => {
  const q = new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => e[1] !== undefined)).toString();
  return q ? `?${q}` : '';
};

export function orgRoleGrantsResource(request: RequestFn) {
  return {
    list(query: { grantor_org_id?: string; grantee_org_id?: string; status?: 'active' } = {}): Promise<ListPage<OrgRoleGrant>> {
      return request({ method: 'GET', path: `/v1/org_role_grants${qs(query)}` });
    },
    create(body: { grantor_org_id: string; grantee_org_id: string; role_keys: string[] }): Promise<OrgRoleGrant> {
      return request({ method: 'POST', path: '/v1/org_role_grants', body });
    },
    get(id: string): Promise<OrgRoleGrant> {
      return request({ method: 'GET', path: `/v1/org_role_grants/${enc(id)}` });
    },
    update(id: string, body: { role_keys: string[] }): Promise<OrgRoleGrant> {
      return request({ method: 'PATCH', path: `/v1/org_role_grants/${enc(id)}`, body });
    },
    revoke(id: string): Promise<OrgRoleGrant> {
      return request({ method: 'DELETE', path: `/v1/org_role_grants/${enc(id)}` });
    },
    listDelegations(id: string): Promise<ListPage<OrgRoleDelegation>> {
      return request({ method: 'GET', path: `/v1/org_role_grants/${enc(id)}/delegations` });
    },
    delegate(id: string, body: { user_id: string; role_key: string }): Promise<OrgRoleDelegation> {
      return request({ method: 'POST', path: `/v1/org_role_grants/${enc(id)}/delegations`, body });
    },
    undelegate(id: string, delegationId: string): Promise<{ object: 'org_role_delegation'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/org_role_grants/${enc(id)}/delegations/${enc(delegationId)}` });
    },
    effective(query: { user_id: string; organization_id?: string }): Promise<ListPage<EffectiveDelegatedRole>> {
      return request({ method: 'GET', path: `/v1/org_role_grants/effective${qs(query)}` });
    },
  };
}
