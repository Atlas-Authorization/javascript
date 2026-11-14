# @atlasauth/emulator changelog

## 0.3.0

- `--openapi` serves the whole Backend API from the OpenAPI document, with real signed tokens, signed webhook deliveries, a message sink, clock control and the change feed.

## Unreleased

## 0.2.0 — 2026-11-11

### Added

- `startProxy({ basePath })`: mount the Frontend API under a path (such as `/atlas`) on the same origin as your app.

## 0.1.0 — 2026-10-26

### Added

- First release. A local, in-memory Atlas for development: FAPI, a minimal BAPI, OIDC discovery, a mail/SMS catcher and a one-origin dev proxy.
