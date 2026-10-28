# @atlasauth/migrate changelog

## Unreleased

## 0.2.0 — 2026-10-26

### Changed

- Bundle schema and sources extended to cover more vendors and data (MFA factors, organizations, roles, sessions, custom claims).

## 0.1.0 — 2026-10-26

### Added

- First release. The vendor-neutral Atlas migration bundle: schema, sealing (X25519 + AES-256-GCM to your Atlas instance's import key), a validating writer and an upload client. Every `atlas migrate export <vendor>` exporter writes this format; Atlas imports it through /v1/migrations/{source}/imports.
