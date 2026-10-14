export * from './token-cache';
export * from './tab-election';
export * from './attempt';
export * from './redirect';
export * from './fapi';
export * from './native';
export * from './native-session';
export * from './passkey';
export * from './telegram';
export * from './siwe';
export * from './telemetry';
export * from './reauth';
export * from './connect';
export * from './password-reset';
export * from './check-session';
// OIDC Front-Channel Logout after a browser sign-out.
export * from './frontchannel-logout';
// §5 "captcha anywhere" — fetch the central widget config, render the provider
// widget, and verify a solved token, all without hardcoding provider keys.
export * from './captcha';
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
