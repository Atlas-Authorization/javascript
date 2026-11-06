# @atlasauth/hapi changelog

## 0.1.1 — 2026-11-06

### Added
- `previousIssuers` option (typed alongside `issuer`), so a sign-in host change does not sign users out: tokens from a listed former issuer are accepted. Absent means only `issuer` is accepted.

## 0.1.0

- First release.
