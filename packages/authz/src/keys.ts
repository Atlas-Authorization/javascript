/**
 * Role and permission KEY SHAPES — the single definition every layer shares.
 *
 * The two shapes are deliberately different, and the difference is meaningful:
 *
 *   ROLE keys are `org:<segment>`      — e.g. `org:admin`, `org:member`.
 *   PERMISSION keys are `org:<resource>:<action>` — e.g. `org:billing:manage`.
 *
 * A role names WHO someone is; a permission names WHAT they may do to a
 * resource. That is why `<Protect role="org:admin">` and
 * `<Protect permission="org:billing:manage">` both type-check but read
 * differently — the arity of the key tells you which you are looking at.
 *
 * The full creation-time rules (reserved `sys_` prefix, immutability, length)
 * are the shared source of truth these SDKs and the Atlas server both build on so they can
 * never drift.
 */

/** `org:` then one lowercase segment. Matches a role key like `org:admin`. */
export const ROLE_KEY_PATTERN = /^org:[a-z][a-z0-9_]{1,31}$/;

/** `org:<resource>:<action>`. Matches a permission key like `org:billing:manage`. */
export const PERMISSION_KEY_PATTERN = /^org:[a-z][a-z0-9_]{1,31}:[a-z][a-z0-9_]{1,31}$/;

/** True for a well-shaped role key (`org:admin`), false otherwise. */
export function isRoleKey(key: string): boolean {
  return ROLE_KEY_PATTERN.test(key);
}

/** True for a well-shaped permission key (`org:billing:manage`), false otherwise. */
export function isPermissionKey(key: string): boolean {
  return PERMISSION_KEY_PATTERN.test(key);
}
