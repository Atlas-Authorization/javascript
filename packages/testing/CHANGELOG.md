# @atlasauth/testing changelog

## 0.1.0

First published release.

### Added
- `getTestingToken()` mints a short-lived testing token from a secret key so end-to-end suites bypass bot/abuse protection.
- `atlasSetup()` returns a shared setup whose `getToken()` mints the testing token once and reuses it across the suite.
- `@atlasauth/testing/playwright`: `setupAtlasTestingToken()` and `createTestingTokenRoute()` attach the token to Atlas requests.
- `@atlasauth/testing/cypress`: `addAtlasCommands()` registers Cypress commands.
- Fail-soft: if a token cannot be minted, helpers resolve to `null` or no-op instead of throwing.
