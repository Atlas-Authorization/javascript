import { hasFromClaims } from '@atlasauth/authz';
import type { SessionClaims } from './verify';

/**
 * Typed access-control definitions for app-level roles.
 *
 * Declare your resources and their actions once; the result gives you
 * type-checked permission keys (`tickets:read`), role definitions you can send
 * to `atlas.appRoles.create`, and checks against a verified session's
 * `app_permissions` claim — so a typo in a permission is a compile error, not a
 * silent deny.
 *
 * ```ts
 * const ac = createAccessControl({
 *   tickets: ['read', 'write', 'close'],
 *   billing: ['read', 'refund'],
 * } as const);
 *
 * const support = ac.role('support', 'Support agent', { tickets: ['read', 'write'] });
 * await atlas.appRoles.create(support);            // { key, name, permissions: [...] }
 *
 * if (!ac.can(claims, { tickets: ['close'] })) return forbidden();
 * ```
 */
export type AccessStatements = Readonly<Record<string, readonly string[]>>;

/** Every `resource:action` key a statement set allows. */
export type PermissionOf<S extends AccessStatements> = {
  [R in keyof S & string]: `${R}:${S[R][number]}`;
}[keyof S & string];

/** A partial grant: some actions on some resources. */
export type AccessGrant<S extends AccessStatements> = { [R in keyof S]?: ReadonlyArray<S[R][number]> };

export interface AppRoleDefinition<S extends AccessStatements> {
  key: string;
  name: string;
  description?: string;
  permissions: Array<PermissionOf<S>>;
}

export interface AccessControl<S extends AccessStatements> {
  readonly statements: S;
  /** One typed permission key. */
  permission<R extends keyof S & string>(resource: R, action: S[R][number]): PermissionOf<S>;
  /** Flatten a grant into sorted permission keys. */
  permissions(grant: AccessGrant<S>): Array<PermissionOf<S>>;
  /** Every permission the statements define. */
  allPermissions(): Array<PermissionOf<S>>;
  /** An app role definition (the body `appRoles.create` takes). */
  role(key: string, name: string, grant: AccessGrant<S>, description?: string): AppRoleDefinition<S>;
  /** Whether the verified claims hold EVERY permission in the grant (from `app_permissions`). */
  can(claims: SessionClaims | null | undefined, grant: AccessGrant<S>): boolean;
  /** Whether the verified claims hold AT LEAST ONE permission in the grant. */
  canAny(claims: SessionClaims | null | undefined, grant: AccessGrant<S>): boolean;
}

export function createAccessControl<const S extends AccessStatements>(statements: S): AccessControl<S> {
  for (const [resource, actions] of Object.entries(statements)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(resource) || resource === 'org') {
      throw new Error(`Invalid resource "${resource}": lowercase letters, digits and _, not "org".`);
    }
    for (const action of actions) {
      if (!/^[a-z*][a-z0-9_*]{0,63}$/.test(action)) throw new Error(`Invalid action "${action}" on "${resource}".`);
    }
  }

  const permissions = (grant: AccessGrant<S>): Array<PermissionOf<S>> => {
    const out = new Set<string>();
    for (const [resource, actions] of Object.entries(grant) as Array<[string, ReadonlyArray<string> | undefined]>) {
      const allowed = statements[resource];
      if (!allowed) throw new Error(`Unknown resource "${resource}".`);
      for (const action of actions ?? []) {
        if (!allowed.includes(action)) throw new Error(`Unknown action "${action}" on "${resource}".`);
        out.add(`${resource}:${action}`);
      }
    }
    return [...out].sort() as Array<PermissionOf<S>>;
  };

  return {
    statements,
    permission: (resource, action) => `${resource}:${String(action)}` as PermissionOf<S>,
    permissions,
    allPermissions: () =>
      Object.entries(statements)
        .flatMap(([r, actions]) => actions.map((a) => `${r}:${a}`))
        .sort() as Array<PermissionOf<S>>,
    role: (key, name, grant, description) => ({
      key,
      name,
      ...(description !== undefined ? { description } : {}),
      permissions: permissions(grant),
    }),
    can: (claims, grant) => hasFromClaims(claims, { allAppPermissions: permissions(grant) }),
    canAny: (claims, grant) => hasFromClaims(claims, { anyAppPermission: permissions(grant) }),
  };
}
