# @atlasauth/eslint-plugin changelog

## 0.1.0

First published release.

### Added
- `no-leaked-secret-key` rule (error in recommended): flags a secret key literal (`sk_`/`psk_`/`scim_`) in a file that imports a client-side Atlas SDK.
- `no-publishable-key-literal` rule (warn): discourages hardcoding a `pk_live_`/`pk_test_` key in favour of an environment variable.
- `await-get-token` rule (warn): flags a floating `getToken()` call whose promise is discarded.
- `recommended` config for ESLint 9 flat config, plus `plugin:@atlasauth/recommended` for legacy `.eslintrc`.
