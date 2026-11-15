# @atlasauth/msw changelog

## 0.4.3

- Uses @atlasauth/emulator-core 0.4.0.

## 0.4.2

- Uses @atlasauth/emulator-core 0.3.1: success statuses and required request fields now match the latest API description.

## 0.4.1

- Picks up `@atlasauth/emulator-core` 0.3.0: async clock advance and the new emulated routes.

## 0.4.0

- `coreHandlers` re-exports the full-API emulator engine as MSW handlers.

## 0.3.0 — 2026-11-06

- Emailed link confirmation and enrolment factor strings and shapes.

## 0.2.0 — 2026-10-24

- Integrator platform release: see the Atlas changelog for 2026-10-24.

## 0.1.0

First published release.

### Added
- `atlasHandlers()` returns Mock Service Worker (v2) handlers for the Atlas Frontend API and Backend API.
- `createAtlasMock()` / `AtlasMock` in-memory backend that advances across calls (sign-in attempts transition, minted sessions authenticate, created users appear in lists).
- Seeding via `AtlasMockSeed`, `SeedUser` and `SeedOrganization`, with deterministic ids (`IdFactory`, `ID_PREFIXES`).
- Response serializers for building custom handlers: `presentUser`, `presentMeUser`, `presentMembership`, `presentOrganization`, `presentSession`, `presentSignInAttempt`, `presentSignUpAttempt`, `listEnvelope`, `errorBody`.
