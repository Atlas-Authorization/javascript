# @atlasauth/emulator changelog

## 0.5.2

- Uses @atlasauth/emulator-core 0.4.0.

## 0.5.1

- Uses @atlasauth/emulator-core 0.3.1: success statuses and required request fields now match the latest API description.

## 0.5.0

- Breaking: the `time/advance` route and helpers that depend on it are now async; `await` them. Routes the new federation, trust, compliance, commerce and journey endpoints. Requires `@atlasauth/emulator-core` 0.3.0.

## 0.4.0

- Routes the new machine, OAuth provider, SCIM, passkey, journey, billing, messaging and authz endpoints; webhook `*` endpoints skip newer event types as in production.

## 0.3.0

- `--openapi` serves the whole Backend API from the OpenAPI document, with real signed tokens, signed webhook deliveries, a message sink, clock control and the change feed.

## Unreleased

## 0.2.0 — 2026-11-11

### Added

- `startProxy({ basePath })`: mount the Frontend API under a path (such as `/atlas`) on the same origin as your app.

## 0.1.0 — 2026-10-26

### Added

- First release. A local, in-memory Atlas for development: FAPI, a minimal BAPI, OIDC discovery, a mail/SMS catcher and a one-origin dev proxy.
