# @atlasauth/koa changelog

## 0.1.2 — 2026-11-14

- Takes `@atlasauth/backend` as a peer dependency (`>=0.49.0 <1.0.0`) instead of pinning one exact version, so an app has a single copy of it.

## 0.1.1 — 2026-11-06

### Added
- `previousIssuers` option (typed alongside `issuer`), so a sign-in host change does not sign users out: tokens from a listed former issuer are accepted. Absent means only `issuer` is accepted.

## 0.1.0

- First release.
