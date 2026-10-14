# @atlasauth/msw changelog

## 0.1.0

First published release.

### Added
- `atlasHandlers()` returns Mock Service Worker (v2) handlers for the Atlas Frontend API and Backend API.
- `createAtlasMock()` / `AtlasMock` in-memory backend that advances across calls (sign-in attempts transition, minted sessions authenticate, created users appear in lists).
- Seeding via `AtlasMockSeed`, `SeedUser` and `SeedOrganization`, with deterministic ids (`IdFactory`, `ID_PREFIXES`).
- Response serializers for building custom handlers: `presentUser`, `presentMeUser`, `presentMembership`, `presentOrganization`, `presentSession`, `presentSignInAttempt`, `presentSignUpAttempt`, `listEnvelope`, `errorBody`.
