// Provider configuration checks (frontendApi) shared by every framework SDK.
export * from './config';
export * from './sign-out';
// Impersonation: the acting party and "return to admin".
export * from './impersonation';
// The safer sign-out every framework provider drives (tombstones, background revoke).
export * from './sign-out-guard';
export * from './token-cache';
export * from './tab-election';
export * from './attempt';
export * from './first-factor';
export * from './initial-state';
// Server errors in the app's language (`error.<reason>` catalog keys).
export * from './errors';
export * from './redirect';
// §oauth popup mode: the same-origin hand-back for a popup whose opener was severed.
export * from './popup-channel';
export * from './fapi';
// Policy acceptance (ToS / privacy / any policy): read, build, accept.
export * from './policies';
// An organization's audit trail for its admins (`<OrganizationAuditLog/>` in every framework SDK).
export * from './organization-audit-log';
// Policy acceptance (terms, privacy, any policy) at sign-up and sign-in: state machine, FAPI calls, DOM UI.
export * from './policy-acceptance';
export * from './policy-dom';
// Referral attribution: capture the visitor's referral and send it on sign-up.
export * from './referral';
export * from './sign-in-with-atlas-loader';
// Development instances: sign-in from localhost where the browser blocks the instance's cookie.
export { devBrowserEnabled, devBrowserToken, forgetDevBrowserToken, setPersistence, withDevBrowser, type PersistenceMode } from './dev-browser';
export {
  CONSENT_PROVIDERS,
  REFERRAL_BROWSER_SOURCES,
  canonicalCategory,
  detectConsent,
  detectConsentProvider,
  detectReferralSource,
  type ConsentDecision,
  type ConsentProvider,
  type DetectedReferral,
  type ReferralBrowserSource,
} from './referral-detect';
// SDK version advisories (`X-Atlas-SDK` / `Atlas-SDK-Advisory`).
export * from './sdk-advisory';
export * from './version';
// `onSignOut({ reason })` for every sign-out path, and the `atlas:signout` window event.
export * from './sign-out-events';
export * from './native';
export * from './native-session';
export * from './passkey';
// Device-bound biometric sign-in for native apps (register a device key, sign in with it).
export * from './attestation';
export * from './device-key';
// The sign-in's MFA steps: second-factor setup (authenticator app / texts) and the texted / emailed code.
export * from './mfa-enrollment';
// HOTP, YubiKey (Yubico OTP), Duo, security questions (password-reset recovery).
export * from './mfa-factors';
// Passkey sign-in's ceremony start, carrying the sign-in captcha when one is required.
export * from './passkey-sign-in';
// Passkey-only sign-up (the account is created when its passkey registers).
export * from './passkey-sign-up';
// Check an emailed one-time code without using it up (sign-in, sign-up, step-up, email verification).
export * from './email-code-check';
// SRP-6a sign-in (RFC 5054, 3072-bit group, SHA-256): the password never leaves the browser.
export * from './srp';
export * from './step-up';
export * from './telegram';
export * from './siwe';
export * from './telemetry';
export * from './reauth';
// End-user API key self-service (`/v1/client/me/api_keys`).
export * from './api-keys';
// The apps a user authorized, with the OpenID Grant Management grants each holds.
export * from './authorized-apps';
export * from './ciba';
export * from './device-authorization';
export * from './app-launcher';
export * from './connector-directory';
export * from './organizations';
export * from './organization-admin';
export * from './pricing';
export * from './marketing';
export * from './phone-numbers';
export * from './email-addresses';
// Username availability + the "Last used" sign-in method hint.
export * from './account-hints';
export * from './custom-challenge';
// Identity verification (document and selfie) through the app's verification service.
export * from './identity-verification';
// Identity governance: request access, approve, review, delegate.
export * from './iga';
export * from './resource-sharing';
// Self-service profile update (incl. user-editable identity traits).
export * from './profile';
export * from './connect';
export * from './connections';
export * from './password-reset';
export * from './check-session';
// Moving from Better Auth: exchange a readable Better Auth session cookie for an Atlas session.
export * from './better-auth-bridge';
export * from './migration-browser-sessions';
// OIDC Front-Channel Logout after a browser sign-out.
export * from './frontchannel-logout';
// RP-initiated logout at an upstream OpenID provider after a browser sign-out.
export * from './upstream-logout';
// §5 "captcha anywhere" — fetch the central widget config, render the provider
// widget, and verify a solved token, all without hardcoding provider keys.
export * from './captcha';
// Per-flow captcha widget rendering shared by the prebuilt sign-in / sign-up UIs.
export * from './captcha-widget';
// Atlas's own captcha (provider `atlas`): challenge fetch, proof-of-work solver, puzzle UI.
export * from './atlas-captcha';
// The framework-agnostic captcha lifecycle + sign-in / sign-up submit helpers the
// prebuilt forms of every framework SDK share, and the instance's public
// sign-in / sign-up settings (`/v1/appearance`) they are driven by.
export * from './captcha-controller';
export * from './instance-settings';
// `GET /v1/client/environment`, typed, and the `email_delivery` facts.
export * from './environment';
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
export * from './journey-redirect';

// Bring-your-own login / consent pages: read the challenge, call your backend proxy, follow redirect_to.
export * from './delegated-ui';

// Passkeys for a user store you own (via your backend and the Atlas Passkey API).
export * from './external-passkeys';

// Wallet-side helpers for verifiable credentials (receive an offer, present an SD-JWT VC).
export * from './credentials';
export * from './uma';
