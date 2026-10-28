import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

export interface ScimToken {
  object: 'scim_token';
  id: string;
  name: string | null;
  organization_id: string;
  connection_id: string | null;
  prefix: string;
  /** null = read and write; ['read'] = read-only. */
  scopes?: Array<'read' | 'write'> | null;
  /** SCIM user roles[].value → organization role key. */
  role_mappings?: ScimRoleMapping[];
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

/** Create reveals the usable secret exactly once. */
export interface ScimTokenWithSecret extends ScimToken {
  secret: string;
  note: string;
}

export interface ScimRoleMapping {
  value: string;
  role: string;
}

export interface CreateScimTokenBody {
  organization_id: string;
  name?: string;
  connection_id?: string;
  /** ['read'] mints a read-only token. */
  scopes?: Array<'read' | 'write'>;
  role_mappings?: ScimRoleMapping[];
}

export interface UpdateScimTokenBody {
  name?: string | null;
  scopes?: Array<'read' | 'write'> | null;
  role_mappings?: ScimRoleMapping[] | null;
}

export function scimTokensResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<ScimToken>> {
      return request({ method: 'GET', path: '/v1/scim_tokens' });
    },
    create(body: CreateScimTokenBody, idempotencyKey?: string): Promise<ScimTokenWithSecret> {
      return request({ method: 'POST', path: '/v1/scim_tokens', body, idempotencyKey });
    },
    /** Change a token's name, scopes or role mappings. */
    update(id: string, body: UpdateScimTokenBody): Promise<ScimToken> {
      return request({ method: 'PATCH', path: `/v1/scim_tokens/${enc(id)}`, body });
    },
    revoke(
      id: string,
    ): Promise<{ object: 'scim_token'; id: string; revoked: true; note: string }> {
      return request({ method: 'POST', path: `/v1/scim_tokens/${enc(id)}/revoke` });
    },
  };
}

/** A custom SCIM resource type an instance serves at /scim/v2/<endpoint>. */
export interface ScimResourceType {
  object: 'scim_resource_type';
  id: string;
  name: string;
  endpoint: string;
  schema_uri: string;
  description: string | null;
  attributes: Array<{ name: string; type: string; multiValued?: boolean; required?: boolean; mutability?: string; subAttributes?: unknown[] }>;
  created_at: number;
}

export function scimResourceTypesResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<ScimResourceType>> {
      return request({ method: 'GET', path: '/v1/scim_resource_types' });
    },
    get(id: string): Promise<ScimResourceType> {
      return request({ method: 'GET', path: `/v1/scim_resource_types/${enc(id)}` });
    },
    create(body: { name: string; endpoint: string; schema_uri: string; description?: string; attributes?: ScimResourceType['attributes'] }): Promise<ScimResourceType> {
      return request({ method: 'POST', path: '/v1/scim_resource_types', body });
    },
    delete(id: string): Promise<{ object: 'scim_resource_type'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/scim_resource_types/${enc(id)}` });
    },
  };
}
