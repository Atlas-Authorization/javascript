# @atlasauth/authz changelog

## 0.3.0 — 2026-10-27

### Added

- Residual-policy filters: the `Filter` type, `evalFilter` (run a filter on in-memory rows), and the compilers `filterToSql` (parameterised, Postgres/MySQL/SQLite), `filterToPrisma` and `filterToDrizzle`.

## 0.2.0 — 2026-10-23

### Added
- App-level (instance-wide) roles and permissions: `ProtectCondition` gains `appRole`, `appPermission`, `anyAppPermission` and `allAppPermissions`, checked against the new `AuthzClaims.app_roles` / `app_permissions`. Like `plan` / `feature`, they need no active organization; a miss is `missing_permission`.

## 0.1.1

First published release.

### Added
- `ProtectCondition` — the single authorization condition shared by every Atlas SDK: `permission`, `role`, `anyPermission`, `allPermissions`, plus `plan` and `feature` for billing entitlements.
- `evaluate(claims, condition)` returning a `ProtectOutcome` (`{ allowed: true }` or `{ allowed: false, reason }` with `ProtectReason` of `signed_out`, `no_organization`, `missing_permission` or `missing_entitlement`). An empty condition means "signed in"; organization conditions fail when there is no active organization; `plan` / `feature` checks need no active organization.
- `hasFromClaims()`, `protectFromClaims()` and `ForbiddenError` for boolean checks and throwing guards.
- `AuthzClaims` — the minimal structural claims shape (`org_id`, `org_role`, `org_permissions`, `pla`, `fea`) that any SDK's session claims can be passed as.
- Role and permission key helpers: `ROLE_KEY_PATTERN`, `PERMISSION_KEY_PATTERN`, `isRoleKey()`, `isPermissionKey()`.
- Zero dependencies; framework-agnostic.
