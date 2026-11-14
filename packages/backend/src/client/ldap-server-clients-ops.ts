import { enc, type RequestFn } from './request';



export interface LdapServerClientsListQuery {
  /** Page size, 1-500. Without limit (and without starting_after) the whole list is returned. */
  limit?: number;
  /** Cursor: return only items after this one. Pass the previous page's `next_cursor` (the last item's id). An unknown cursor is a 400. */
  starting_after?: string;
}

export type LdapServerClientsListResult = {
  object?: 'list';
  data?: ({
    object?: 'ldap_server_client';
    id?: string;
    name?: string;
    base_dn?: string;
    bind_dn?: string;
    user_dn_template?: string;
    allowed_cidrs?: string[];
    allow_user_bind?: boolean;
    size_limit?: number;
    status?: 'active' | 'disabled';
    secret_prefix?: string;
    last_bind_at?: number | null;
    created_at?: number;
    /** On create and rotate only: the bind password, shown once. */
    secret?: string;
  })[];
  has_more?: boolean;
};

export type LdapServerClientsCreateBody = {
  name: string;
  /** e.g. dc=acme,dc=com */
  base_dn: string;
  /** The service account cn under base_dn. */
  bind_cn: string;
  /** Source networks allowed to bind (empty = anywhere). */
  allowed_cidrs?: string[];
  allow_user_bind?: boolean;
  size_limit?: number;
  status?: 'active' | 'disabled';
};

export type LdapServerClientsCreateResult = {
  object?: 'ldap_server_client';
  id?: string;
  name?: string;
  base_dn?: string;
  bind_dn?: string;
  user_dn_template?: string;
  allowed_cidrs?: string[];
  allow_user_bind?: boolean;
  size_limit?: number;
  status?: 'active' | 'disabled';
  secret_prefix?: string;
  last_bind_at?: number | null;
  created_at?: number;
  /** On create and rotate only: the bind password, shown once. */
  secret?: string;
};

export type LdapServerClientsGetResult = {
  object?: 'ldap_server_client';
  id?: string;
  name?: string;
  base_dn?: string;
  bind_dn?: string;
  user_dn_template?: string;
  allowed_cidrs?: string[];
  allow_user_bind?: boolean;
  size_limit?: number;
  status?: 'active' | 'disabled';
  secret_prefix?: string;
  last_bind_at?: number | null;
  created_at?: number;
  /** On create and rotate only: the bind password, shown once. */
  secret?: string;
};

export type LdapServerClientsUpdateBody = {
  name?: string;
  /** e.g. dc=acme,dc=com */
  base_dn?: string;
  /** The service account cn under base_dn. */
  bind_cn?: string;
  /** Source networks allowed to bind (empty = anywhere). */
  allowed_cidrs?: string[];
  allow_user_bind?: boolean;
  size_limit?: number;
  status?: 'active' | 'disabled';
};

export type LdapServerClientsUpdateResult = {
  object?: 'ldap_server_client';
  id?: string;
  name?: string;
  base_dn?: string;
  bind_dn?: string;
  user_dn_template?: string;
  allowed_cidrs?: string[];
  allow_user_bind?: boolean;
  size_limit?: number;
  status?: 'active' | 'disabled';
  secret_prefix?: string;
  last_bind_at?: number | null;
  created_at?: number;
  /** On create and rotate only: the bind password, shown once. */
  secret?: string;
};

export type LdapServerClientsRotateSecretResult = {
  object?: 'ldap_server_client';
  id?: string;
  name?: string;
  base_dn?: string;
  bind_dn?: string;
  user_dn_template?: string;
  allowed_cidrs?: string[];
  allow_user_bind?: boolean;
  size_limit?: number;
  status?: 'active' | 'disabled';
  secret_prefix?: string;
  last_bind_at?: number | null;
  created_at?: number;
  /** On create and rotate only: the bind password, shown once. */
  secret?: string;
};

/** Operations on `/v1/ldap_server_clients` (6). */
export function ldapServerClientsOpsResource(request: RequestFn) {
  return {
    /** List the LDAP interface service accounts with their base DN, bind DN and allowed source networks. Secrets are never returned. */
    list(query?: LdapServerClientsListQuery): Promise<LdapServerClientsListResult> {
      return request({ method: 'GET', path: '/v1/ldap_server_clients', query: { ...query } });
    },
    /** Create a service account for the LDAPS interface: base_dn (dc=/o=/ou= parts, unique across Atlas), bind_cn, allowed_cidrs (empty = nobody may connect), allow_user_bind and size_limit. The secret is returned once as secret. */
    create(body?: LdapServerClientsCreateBody, idempotencyKey?: string): Promise<LdapServerClientsCreateResult> {
      return request({ method: 'POST', path: '/v1/ldap_server_clients', body, idempotencyKey });
    },
    /** Read one LDAP interface service account. */
    get(id: string): Promise<LdapServerClientsGetResult> {
      return request({ method: 'GET', path: `/v1/ldap_server_clients/${enc(id)}` });
    },
    /** Change the name, allowed networks, user-bind switch, size limit or status (active or disabled). */
    update(id: string, body?: LdapServerClientsUpdateBody): Promise<LdapServerClientsUpdateResult> {
      return request({ method: 'PATCH', path: `/v1/ldap_server_clients/${enc(id)}`, body });
    },
    /** Delete a service account; its connections can no longer bind. */
    delete(id: string): Promise<void> {
      return request({ method: 'DELETE', path: `/v1/ldap_server_clients/${enc(id)}` });
    },
    /** Issue a new service-account secret (returned once); the old one stops working immediately. */
    rotateSecret(id: string): Promise<LdapServerClientsRotateSecretResult> {
      return request({ method: 'POST', path: `/v1/ldap_server_clients/${enc(id)}/rotate_secret` });
    },
  };
}
