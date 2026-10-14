# @atlasauth/eslint-plugin

ESLint rules that catch common misuse of the Atlas SDKs.

## Install

```sh
npm i -D @atlasauth/eslint-plugin
```

## Usage

### Flat config (ESLint 9 — `eslint.config.js`)

```js
import atlas from '@atlasauth/eslint-plugin';

export default [atlas.recommended];
```

### Legacy config (`.eslintrc`)

```json
{
  "plugins": ["@atlasauth"],
  "extends": ["plugin:@atlasauth/recommended"]
}
```

## Rules

| Rule | Recommended | Description |
| --- | --- | --- |
| `no-leaked-secret-key` | error | Flags an Atlas secret key (`sk_`/`psk_`/`scim_`) literal in a file that imports a client-side Atlas SDK. Secret keys must never ship to the browser — use a publishable key (`pk_`) client-side and keep secret keys server-only. |
| `no-publishable-key-literal` | warn | Discourages hardcoding a publishable key (`pk_live_`/`pk_test_`); suggests reading it from an environment variable. |
| `await-get-token` | warn | Flags an obvious floating `getToken()` call whose returned Promise is discarded (not awaited, returned, assigned, or `.then`-chained). |
