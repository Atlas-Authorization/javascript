/**
 * `@atlasauth/types` — the shared public TypeScript types an Atlas integrator
 * imports. The Atlas peer of `@clerk/types`.
 *
 * Dependency-free and runtime-free: every export is `export type`, so a consumer
 * can `import type { User } from '@atlasauth/types'` with NO runtime SDK pulled
 * in. The shapes are aggregated from the SDKs that own them — COPIED verbatim
 * where the source package ships runtime code/deps (core, authz, backend,
 * react), and RE-EXPORTED type-only from the one package that is itself
 * runtime-free (`@atlasauth/localizations`).
 */

// Mint-side session JWT claims (← @atlasauth/core).
export type { SessionClaims } from './session';

// Shared authorization condition (← @atlasauth/authz).
export type { AuthzClaims, ProtectCondition, ProtectOutcome, ProtectReason } from './authz';

// Read-side verification result + verifier's claims superset (← @atlasauth/backend).
export type { VerifiedSessionClaims, AuthorizedSession, VerifyResult } from './verify';

// BAPI resource shapes + list envelopes (← @atlasauth/backend client).
export type {
  Metadata,
  CursorPage,
  DataList,
  CursorParams,
  DeletedObject,
  User,
  EmailAddress,
  Session,
  Organization,
  OrganizationMembership,
  Invitation,
  ApiKey,
  ApiKeySubjectType,
  ApiKeyVerification,
} from './resources';

// Webhook event + payload + verification (← @atlasauth/core + @atlasauth/backend).
export type {
  WebhookEvent,
  WebhookPayload,
  WebhookVerifyResult,
  WebhookVerifyFailure,
} from './webhooks';

// Component theming (← @atlasauth/react).
export type { Appearance, DesignTokens, ElementKey } from './appearance';

// Localization (type-only re-export ← @atlasauth/localizations).
export type { LocalizationResource, Localization, DeepPartial } from './localization';
