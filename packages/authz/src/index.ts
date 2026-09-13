/**
 * `@atlasauth/authz` — the framework-agnostic authorization primitive shared by
 * every Atlas SDK. Zero dependencies, no DOM, no Node: one `evaluate()` and one
 * `ProtectCondition` so a permission check means the same thing in a browser, an
 * edge middleware, and a Node server.
 */
export type { AuthzClaims } from './claims';
export {
  type ProtectCondition,
  type ProtectOutcome,
  type ProtectReason,
  evaluate,
  hasFromClaims,
  protectFromClaims,
  ForbiddenError,
} from './protect';
export {
  ROLE_KEY_PATTERN,
  PERMISSION_KEY_PATTERN,
  isRoleKey,
  isPermissionKey,
} from './keys';
