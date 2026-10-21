# @atlasauth/testing changelog

## 0.2.0

### Added
- Re-exports `createTestIssuer`, `TEST_TOKEN_TAMPERS` and their types (`TestIssuer`, `CreateTestIssuerOptions`, `MintIdTokenOptions`, `TestAuthorizeOptions`, `TestAuthorizeResult`, `TestTokenTamper`) from `@atlasauth/backend` 0.9.0, so backend unit tests can mint session and ID tokens and run a redirect sign-in offline from the same import as the end-to-end helpers.

## 0.1.0

First published release.

### Added
- `getTestingToken()` mints a short-lived testing token from a secret key so end-to-end suites bypass bot/abuse protection.
- `atlasSetup()` returns a shared setup whose `getToken()` mints the testing token once and reuses it across the suite.
- `@atlasauth/testing/playwright`: `setupAtlasTestingToken()` and `createTestingTokenRoute()` attach the token to Atlas requests.
- `@atlasauth/testing/cypress`: `addAtlasCommands()` registers Cypress commands.
- Fail-soft: if a token cannot be minted, helpers resolve to `null` or no-op instead of throwing.
