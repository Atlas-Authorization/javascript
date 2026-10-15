// Provider configuration checks (frontendApi) shared by every framework SDK.
export * from './config';
export * from './sign-out';
export * from './token-cache';
export * from './tab-election';
export * from './attempt';
export * from './redirect';
// §oauth popup mode: the same-origin hand-back for a popup whose opener was severed.
export * from './popup-channel';
export * from './fapi';
export * from './native';
export * from './native-session';
export * from './passkey';
export * from './telegram';
export * from './siwe';
export * from './telemetry';
export * from './reauth';
// End-user API key self-service (`/v1/client/me/api_keys`).
export * from './api-keys';
export * from './connect';
export * from './password-reset';
export * from './check-session';
// OIDC Front-Channel Logout after a browser sign-out.
export * from './frontchannel-logout';
// §5 "captcha anywhere" — fetch the central widget config, render the provider
// widget, and verify a solved token, all without hardcoding provider keys.
export * from './captcha';
// Per-flow captcha widget rendering shared by the prebuilt sign-in / sign-up UIs.
export * from './captcha-widget';
// The framework-agnostic captcha lifecycle + sign-in / sign-up submit helpers the
// prebuilt forms of every framework SDK share, and the instance's public
// sign-in / sign-up settings (`/v1/appearance`) they are driven by.
export * from './captcha-controller';
export * from './instance-settings';
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
