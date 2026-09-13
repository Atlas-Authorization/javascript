import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

export interface Role {
  object: 'role';
  id: string;
  key: string;
  name: string;
  description: string | null;
  is_system: boolean;
  permissions: string[];
  member_count: number;
  created_at: number;
}

export interface Permission {
  object: 'permission';
  id: string;
  key: string;
  name: string;
  description: string | null;
  is_system: boolean;
}

export interface CreateRoleBody {
  key: string;
  name: string;
  description?: string;
  permissions?: string[];
}

export interface UpdateRoleBody {
  name?: string;
  description?: string;
  /** May be supplied but must equal the current key — the key is immutable. */
  key?: string;
}

/** `PUT /v1/roles/:id/permissions` returns this reduced shape, not a full Role. */
export interface RolePermissionsResult {
  object: 'role';
  id: string;
  key: string;
  permissions: string[];
  ignored: string[];
}

export function rolesResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<Role>> {
      return request({ method: 'GET', path: '/v1/roles' });
    },
    create(body: CreateRoleBody, idempotencyKey?: string): Promise<Role> {
      return request({ method: 'POST', path: '/v1/roles', body, idempotencyKey });
    },
    update(id: string, body: UpdateRoleBody): Promise<Role> {
      return request({ method: 'PATCH', path: `/v1/roles/${enc(id)}`, body });
    },
    /** Replace a role's permission set wholesale. */
    setPermissions(id: string, permissions: string[]): Promise<RolePermissionsResult> {
      return request({
        method: 'PUT',
        path: `/v1/roles/${enc(id)}/permissions`,
        body: { permissions },
      });
    },
    /**
     * Delete a role. Pass `{ reassignTo }` to move every member onto another
     * role first (atomic, before the delete) so an in-use role can be retired;
     * without it, deleting a role people still hold fails with `role_in_use`.
     */
    delete(
      id: string,
      opts?: { reassignTo?: string },
    ): Promise<{ object: 'role'; id: string; deleted: true; members_reassigned: number }> {
      return request({
        method: 'DELETE',
        path: `/v1/roles/${enc(id)}`,
        query: opts?.reassignTo ? { reassign_to: opts.reassignTo } : undefined,
      });
    },
  };
}

export interface CreatePermissionBody {
  key: string;
  name?: string;
  description?: string;
}

export interface UpdatePermissionBody {
  name?: string;
  description?: string | null;
  /** May be supplied but must equal the current key — the key is immutable. */
  key?: string;
}

export function permissionsResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<Permission>> {
      return request({ method: 'GET', path: '/v1/permissions' });
    },
    create(body: CreatePermissionBody, idempotencyKey?: string): Promise<Permission> {
      return request({ method: 'POST', path: '/v1/permissions', body, idempotencyKey });
    },
    /** Relabel a custom permission (name/description only — the key is immutable). */
    update(id: string, body: UpdatePermissionBody): Promise<Permission> {
      return request({ method: 'PATCH', path: `/v1/permissions/${enc(id)}`, body });
    },
    /** Delete a custom permission. Fails with `role_in_use` if a role still grants it. */
    delete(id: string): Promise<{ object: 'permission'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/permissions/${enc(id)}` });
    },
  };
}
