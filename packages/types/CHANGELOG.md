# @atlasauth/types changelog

## 0.12.0 — 2026-10-28

- Webhook payload types for workflows, feature flags, chat approvals, risk, device assurance, billing discounts, agent governance, gateway tool changes and connection triggers

## 0.11.0 — 2026-10-27

### Added

- Webhook event types `connection.refresh_failed`, `connection.revoked`, `connection.reauthorization_required`, `connection.scopes_changed` and `connection.recovered`.
- Identity-governance event types `iga_request.created`, `iga_request.approval_needed`, `iga_request.decided`, `iga_request.escalated`, `iga_grant.created`, `iga_grant.revoked`, `iga_campaign.launched`, `iga_campaign.reminder`, `iga_campaign.closed`, `iga_violation.detected`, `iga_user.reconciled` and `iga_user.offboarded`.
- Webhook event types `uma.request_submitted` and `uma.request_decided` (user-managed access requests a resource owner approves).

## 0.10.0 — 2026-10-26

### Changed

- New webhook event types.

## 0.9.0 — 2026-10-24

- Integrator platform release: see the Atlas changelog for 2026-10-24.

## 0.8.0 — 2026-10-24

### Added

- Policy acceptance webhook payload types: `user.policy_accepted` and `policy.version_published`.

## 0.7.0 — 2026-10-24

### Added

- `WebhookEvent` gains `user.reactivated` (a dormant account signed in again) and `session.updated`.
- `Session.custom_data`: custom per-session data attached by the app's backend or a `post_login` Action.

## 0.6.0 — 2026-10-23

### Added

- `WebhookEvent` gains `user.anonymous_linked`, `organizationInvitation.resent`, `team.created` / `team.updated` / `team.deleted`, `teamMembership.created` / `teamMembership.deleted`, `appRole.created` / `appRole.updated` / `appRole.deleted` and `user.app_roles_updated`.

## 0.5.0

### Added

- `WebhookEvent` gains `user.referral_resolved` (the final referral attribution, sent after a `user.created` whose `referral.status` was `pending`).
- `UserReferral` gains `partner_external_ref`, `referral_status` and `notes`; new `UserReferralStatus` type.

### Changed

- `UserReferral.status` is now where attribution stands (`pending`, `attributed`, `none`, `failed`, `held`, `flagged`). The platform's own status moved to `referral_status`. `referral` is non-null for every user reported to the referral platform, not only referred ones.

## 0.4.0

### Added

- `WebhookEvent` gains `user.referral_attributed` (referral attribution resolved after `user.created` was sent).
- `User` gains optional `referral` (`UserReferral`: `partner_id`, `referrer_external_id`, `referrer_user_id`, `matched_via`, `status`, `risk_level`, `flagged`), `referral_code` and `referral_link`.

## 0.3.0

### Added

- `User.version` (optional): strictly increases with every change to the user; user webhook payloads carry the same value.

## 0.2.0

### Added

- `WebhookEvent` gains `api_key.created`, `api_key.updated` and
  `api_key.limit_reached`.
- `WebhookEvent` gains `entitlement.override.created`,
  `entitlement.override.deleted` and `entitlement.override.expired`, which the
  server already emitted but the union was missing.
- `DesignTokens` gains optional `colorTextOnPrimary` and `colorFocusRing` (mirrors `@atlasauth/react` 0.5.0).

## 0.1.0

First published release.

### Added
- Dependency-free, runtime-free shared TypeScript types for Atlas integrators; every export is type-only, so importing them adds nothing to a bundle.
- Session: `SessionClaims`, including the `orgs` entries' optional `settings_partial` flag, set when some organization settings could not be included in the token and should be fetched instead.
- Authorization: `AuthzClaims`, `ProtectCondition`, `ProtectOutcome`, `ProtectReason`.
- Verification: `VerifiedSessionClaims`, `AuthorizedSession`, `VerifyResult`.
- Backend API resources: `User`, `EmailAddress`, `Session`, `Organization`, `OrganizationMembership`, `Invitation`, `ApiKey`, `ApiKeySubjectType`, `ApiKeyVerification`, and the `Metadata`, `CursorPage`, `DataList`, `CursorParams` and `DeletedObject` envelopes.
- Webhooks: `WebhookEvent`, `WebhookPayload`, `WebhookVerifyResult`, `WebhookVerifyFailure`.
- Theming and localization: `Appearance`, `DesignTokens`, `ElementKey`, `LocalizationResource`, `Localization`, `DeepPartial`.

