# @atlasauth/backend changelog


## 0.1.7
- **Metadata.** Added `repository` (monorepo + package directory), `homepage`, and `bugs` so the npm page links back to source.

## 0.1.6
- **Optional `audience` verification.** `verifySessionToken(..., { audience })` now enforces the session token's `aud` claim when you pass an expected audience (string or array); omit it and verification is unchanged. Pairs with Atlas sessions now carrying `aud` (the instance id) and `azp`. Backwards compatible.

