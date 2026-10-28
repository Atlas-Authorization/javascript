import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

/**
 * App-level (instance-wide) user roles: roles that are not tied to an
 * organization, each granting permission keys like `tickets:read`. A user's
 * role keys and the union of their permissions travel on the session token as
 * `app_roles` / `app_permissions`; check them offline with
 * `has(claims, { appPermission: 'tickets:read' })` or `hasAppPermission`.
 */
export interface AppRole {
  object: 'app_role';
  id: string;
  key: string;
  name: string;
  description: string | null;
  permissions: string[];
  /** On list and create only. */
  users_count?: number;
  created_at: number;
  updated_at: number;
}

export interface CreateAppRoleBody {
  /** 2-64 lowercase letters, digits, _ or -, starting with a letter. */
  key: string;
  name: string;
  description?: string | null;
  /** `resource:action` keys (the `org:` namespace is reserved for organizations). */
  permissions?: string[];
}

export interface UpdateAppRoleBody {
  name?: string;
  description?: string | null;
  permissions?: string[];
}

export interface UserAppRoles {
  object: 'user_app_roles';
  user_id: string;
  roles: AppRole[];
  role_keys: string[];
  permissions: string[];
}

/**
 * Change a user's app roles: `roles` replaces the set; `add`/`remove` change it
 * (role keys or ids). Send one form, not both.
 */
export type SetUserAppRolesBody = { roles: string[] } | { add?: string[]; remove?: string[] };

export function appRolesResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<AppRole>> {
      return request({ method: 'GET', path: '/v1/app_roles' });
    },
    create(body: CreateAppRoleBody): Promise<AppRole> {
      return request({ method: 'POST', path: '/v1/app_roles', body });
    },
    /** By id or key. */
    get(idOrKey: string): Promise<AppRole> {
      return request({ method: 'GET', path: `/v1/app_roles/${enc(idOrKey)}` });
    },
    update(idOrKey: string, body: UpdateAppRoleBody): Promise<AppRole> {
      return request({ method: 'PATCH', path: `/v1/app_roles/${enc(idOrKey)}`, body });
    },
    delete(idOrKey: string): Promise<{ object: 'app_role'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/app_roles/${enc(idOrKey)}` });
    },
    /** The users holding a role. */
    listUsers(
      idOrKey: string,
      query: { limit?: number; offset?: number } = {},
    ): Promise<ListPage<{ object: 'user_app_role'; user_id: string; role: string }>> {
      return request({ method: 'GET', path: `/v1/app_roles/${enc(idOrKey)}/users`, query });
    },
    /** A user's app roles and effective permissions. */
    getForUser(userId: string): Promise<UserAppRoles> {
      return request({ method: 'GET', path: `/v1/users/${enc(userId)}/app_roles` });
    },
    setForUser(userId: string, body: SetUserAppRolesBody): Promise<UserAppRoles> {
      return request({ method: 'POST', path: `/v1/users/${enc(userId)}/app_roles`, body });
    },
    removeFromUser(userId: string, idOrKey: string): Promise<UserAppRoles> {
      return request({ method: 'DELETE', path: `/v1/users/${enc(userId)}/app_roles/${enc(idOrKey)}` });
    },
  };
}
