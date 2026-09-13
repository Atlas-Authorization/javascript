export * from './token-cache';
export * from './tab-election';
export * from './attempt';
export * from './redirect';
export * from './fapi';
export * from './native';
export * from './passkey';
export * from './telegram';
export * from './siwe';
export * from './telemetry';
export * from './reauth';
export * from './connect';
export * from './password-reset';
export * from './check-session';
// Framework-agnostic authorization primitive — `has()`/`evaluate` for any
// non-React/Next consumer reading org_role/org_permissions off its session.
export {
  type AuthzClaims,
  type ProtectCondition,
  type ProtectOutcome,
  type ProtectReason,
  evaluate,
  hasFromClaims,
  protectFromClaims,
  ForbiddenError,
  ROLE_KEY_PATTERN,
  PERMISSION_KEY_PATTERN,
  isRoleKey,
  isPermissionKey,
} from '@atlasauth/authz';
