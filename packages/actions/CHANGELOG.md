# @atlasauth/actions changelog

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
