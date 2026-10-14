import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

export type OrgLdapConnectionStatus = 'draft' | 'active' | 'disabled';

/** Directory attribute → Atlas field mapping. `email` is required. */
export interface OrgLdapAttributeMap {
  email: string;
  firstName?: string;
  lastName?: string;
  username?: string;
}

/** An organization-owned LDAP / Active Directory connection. Never the bind password. */
export interface OrgLdapConnection {
  object: 'org_ldap_connection';
  id: string;
  organization_id: string;
  status: OrgLdapConnectionStatus;
  url: string;
  bind_dn: string;
  base_dn: string;
  user_filter: string;
  start_tls: boolean;
  attributes: OrgLdapAttributeMap;
  has_bind_password: boolean;
  default_role_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface UpdateOrgLdapConnectionBody {
  status?: OrgLdapConnectionStatus;
  /** `ldap://` or `ldaps://` directory URL. */
  url?: string;
  /** Service-account DN Atlas binds as to search. */
  bind_dn?: string;
  /** Subtree searched under. */
  base_dn?: string;
  /** Search filter with a `{{username}}` placeholder. */
  user_filter?: string;
  start_tls?: boolean;
  attributes?: OrgLdapAttributeMap;
  /** Service-account password. Write-only; re-encrypted only when supplied. */
  bind_password?: string;
  default_role_id?: string | null;
}

/** One connection per organization. */
export interface CreateOrgLdapConnectionBody extends UpdateOrgLdapConnectionBody {
  organization_id: string;
}

export interface OrgLdapConnectionTest {
  object: 'org_ldap_connection_test';
  id: string;
  /** Whether the service-account bind succeeded. */
  ok: boolean;
  /** Present only when the bind failed. */
  error?: string;
}

export function orgLdapConnectionsResource(request: RequestFn) {
  return {
    list(
      params: { organization_id?: string } = {},
    ): Promise<ListPage<OrgLdapConnection>> {
      return request({ method: 'GET', path: '/v1/org_ldap_connections', query: { ...params } });
    },
    create(
      body: CreateOrgLdapConnectionBody,
      idempotencyKey?: string,
    ): Promise<OrgLdapConnection> {
      return request({ method: 'POST', path: '/v1/org_ldap_connections', body, idempotencyKey });
    },
    get(id: string): Promise<OrgLdapConnection> {
      return request({ method: 'GET', path: `/v1/org_ldap_connections/${enc(id)}` });
    },
    update(
      id: string,
      body: UpdateOrgLdapConnectionBody,
      idempotencyKey?: string,
    ): Promise<OrgLdapConnection> {
      return request({
        method: 'PATCH',
        path: `/v1/org_ldap_connections/${enc(id)}`,
        body,
        idempotencyKey,
      });
    },
    delete(id: string): Promise<{ object: 'org_ldap_connection'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/org_ldap_connections/${enc(id)}` });
    },
    /**
     * Attempt a service-account bind and report ok/failure. Pass `bind_password`
     * to test a password before saving it.
     */
    test(id: string, body: { bind_password?: string } = {}): Promise<OrgLdapConnectionTest> {
      return request({ method: 'POST', path: `/v1/org_ldap_connections/${enc(id)}/test`, body });
    },
  };
}
