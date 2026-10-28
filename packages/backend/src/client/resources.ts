import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

export interface ResourceRoleDef {
  key: string;
  name?: string;
  /** `*` grants every permission. */
  permissions: string[];
  /** Other roles of the same type this role also grants. */
  includes?: string[];
}

export interface ResourceType {
  object: 'resource_type';
  key: string;
  name: string;
  description: string | null;
  parent_type: string | null;
  inherit: boolean;
  roles: ResourceRoleDef[];
  created_at: number;
  updated_at: number;
}

export interface CreateResourceTypeBody {
  key: string;
  name?: string;
  description?: string | null;
  /** The type a resource of this type nests under. */
  parent_type?: string | null;
  /** Whether assignments on a parent flow down (default true). */
  inherit?: boolean;
  roles: ResourceRoleDef[];
}

export interface Resource {
  object: 'resource';
  id: string;
  type: string;
  external_id: string;
  name: string | null;
  parent_id: string | null;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}

/** A reference to a resource: Atlas `id`, or your own `type` + `external_id`. */
export type ResourceRef = { id: string } | { type: string; external_id: string };

export interface UpsertResourceBody {
  type: string;
  external_id: string;
  name?: string | null;
  /** The parent resource, or null for a root. */
  parent?: ResourceRef | null;
  metadata?: Record<string, unknown>;
}

export type ResourceSubject = { type: 'user' | 'group' | 'org'; id: string };

export interface ResourceRoleAssignment {
  object: 'resource_role_assignment';
  id: string;
  resource_id: string;
  subject: ResourceSubject;
  role: string;
  inherit: boolean;
  created_at: number;
}

export interface ResourceCheckBody {
  subject: ResourceSubject;
  permission: string;
  resource: ResourceRef;
  /** Extra group ids the subject belongs to (a user's organizations are added automatically). */
  groups?: string[];
}

export interface ResourceCheck {
  object: 'resource_check';
  allowed: boolean;
  resource_id: string;
  grants?: Array<{ resource_id: string; role: string; subject: string; inherited: boolean }>;
}

/** Resource-scoped RBAC: resource types, the resource tree, role assignments on resources, and permission checks. */
export function resourcesResource(request: RequestFn) {
  return {
    types: {
      list(): Promise<ListPage<ResourceType>> {
        return request({ method: 'GET', path: '/v1/resource_types' });
      },
      get(key: string): Promise<ResourceType> {
        return request({ method: 'GET', path: `/v1/resource_types/${enc(key)}` });
      },
      create(body: CreateResourceTypeBody, idempotencyKey?: string): Promise<ResourceType> {
        return request({ method: 'POST', path: '/v1/resource_types', body, idempotencyKey });
      },
      update(key: string, body: Partial<Omit<CreateResourceTypeBody, 'key'>>): Promise<ResourceType> {
        return request({ method: 'PATCH', path: `/v1/resource_types/${enc(key)}`, body });
      },
      delete(key: string): Promise<{ object: 'resource_type'; key: string; deleted: true }> {
        return request({ method: 'DELETE', path: `/v1/resource_types/${enc(key)}` });
      },
    },
    list(query: { type?: string; parent_id?: string; limit?: number } = {}): Promise<ListPage<Resource>> {
      const q = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]): [string, string] => [k, String(v)]));
      return request({ method: 'GET', path: `/v1/resources${q.size ? `?${q}` : ''}` });
    },
    get(id: string): Promise<Resource> {
      return request({ method: 'GET', path: `/v1/resources/${enc(id)}` });
    },
    /** Create or update one resource by (type, external_id). */
    upsert(body: UpsertResourceBody): Promise<Resource> {
      return request({ method: 'PUT', path: '/v1/resources', body });
    },
    /** Discovery sync: upsert up to 500 resources in order (parents before children). */
    sync(resources: UpsertResourceBody[]): Promise<ListPage<Resource>> {
      return request({ method: 'POST', path: '/v1/resources/sync', body: { resources } });
    },
    delete(id: string): Promise<{ object: 'resource'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/resources/${enc(id)}` });
    },
    assignments: {
      list(query: { resource_id?: string; subject_type?: string; subject_id?: string } = {}): Promise<ListPage<ResourceRoleAssignment>> {
        const q = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined) as [string, string][]);
        return request({ method: 'GET', path: `/v1/resource_role_assignments${q.size ? `?${q}` : ''}` });
      },
      /** Assign `role` on `resource` to a user, group or org. */
      assign(body: { resource: ResourceRef; subject: ResourceSubject; role: string; inherit?: boolean }): Promise<ResourceRoleAssignment> {
        return request({ method: 'POST', path: '/v1/resource_role_assignments', body });
      },
      revoke(id: string): Promise<{ object: 'resource_role_assignment'; id: string; deleted: true }> {
        return request({ method: 'DELETE', path: `/v1/resource_role_assignments/${enc(id)}` });
      },
    },
    /** May `subject` hold `permission` on `resource`? */
    check(body: ResourceCheckBody): Promise<ResourceCheck> {
      return request({ method: 'POST', path: '/v1/resource_checks', body });
    },
    /** Convenience: the boolean answer to {@link check}. */
    async can(body: ResourceCheckBody): Promise<boolean> {
      return (await request<ResourceCheck>({ method: 'POST', path: '/v1/resource_checks', body })).allowed;
    },
    checkBatch(checks: ResourceCheckBody[]): Promise<ListPage<ResourceCheck>> {
      return request({ method: 'POST', path: '/v1/resource_checks/batch', body: { checks } });
    },
    /** The resources (of an optional `type`) on which `subject` holds `permission`. */
    accessible(body: { subject: ResourceSubject; permission: string; type?: string; groups?: string[]; limit?: number; starting_after?: string }): Promise<ListPage<Resource>> {
      return request({ method: 'POST', path: '/v1/resource_checks/list', body });
    },
  };
}
