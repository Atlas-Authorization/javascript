# @atlasauth/actions changelog

## 0.7.0

- `pre_message_send` trigger types and test harness; `egress_allowlist` for `api.http`.

## 0.6.1 — 2026-11-14

- The published package now carries the release notes for every version.

## 0.6.0 — 2026-11-14

- `pre_user_deletion` trigger: allow, `api.access.deny(reason)` or `api.access.pause(reason)`.
- `pre_invitation_create`, `pre_member_add` and `pre_organization_create` events carry the organization's public metadata and entitlements, and the invitation or seat about to be created (metadata, permissions, allowed sign-in methods, accept rules).

## 0.5.0 — 2026-10-28

- `custom_token_exchange` and `workflow_step` triggers

## 0.4.0 — 2026-10-26

### Changed

- Post-login HTTP requests, richer event context and session custom data typings; harness updated to match the new action API surface.

## 0.3.0 — 2026-10-24

### Added

- `api.http.get` / `api.http.post` on `post_login` and `post_user_registration` (queued requests Atlas sends after the flow completes; `saveResponseAs` keeps a JSON response on the user's metadata). The harness records them with the sandbox's own checks as `result.httpRequests`.
- `event.user.organizations` (`{ id, slug, name, role }[]`) and `event.request.country`.
- `api.session.setCustomData(name, value)` on `post_login`: attach custom data to the session being created (returned on the session, and carried in the session token when the instance opts in). The harness records it as `result.sessionData`.

## 0.2.0 — 2026-10-23

### Added
- `ActionConnection.method` can be `passkey` on the registration triggers (a passkey-only sign-up).

## 0.1.1

### Added
- `ActionConnection` gains an optional `method` field on the registration triggers (`pre_user_registration`, `post_user_registration`), carrying the sign-up method family: `password`, `email_code`, `email_link`, `phone_code`, `social`, `enterprise_sso`, `web3_wallet` or `lti`. It is absent on `post_login`.

### Changed
- Documentation: registration Actions now run for every self-service sign-up method (social and enterprise sign-in that creates a new user, passwordless email code / magic link, SMS code and LTI launches), not only email + password.

## 0.1.0

First published release.

### Added
- Typed `event` and `api` objects per trigger (`post_login`, `pre_user_registration`, `post_user_registration`), with `ActionTrigger`, `ACTION_TRIGGERS`, `EventForTrigger` and `ApiForTrigger`.
- `defineAction(trigger, handler)` to author an Action, with `toCode()` returning the deployable script body.
- Offline test harness: `createTestEvent()`, `runAction()`, `runScript()` and `createMockApi()`, capturing denies, access/ID token claims, app metadata, logs and errors with the same globals as the hosted runtime.
- Template gallery (`templates`, `getTemplate()`): add roles to token, block disposable emails, enforce an email-domain allowlist, enrich the profile from secrets, and restrict sign-in by IP.
