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
| `require-webhook-verify` | error | Flags a webhook route handler (`app.post('/webhooks/…', handler)`, or an exported `POST` in a file named for webhooks) that never calls a signature check such as `verifyWebhook` or `verifyAtlasWebhookRequest`. Anyone who finds the URL could send it events. Add your own check names with the `verifyFunctions` option. |
| `no-unverified-jwt-decode` | error | Flags `decodeJwt` / `jwtDecode` in a function that never verifies the token (`jwtVerify`, `verifyToken`, `AtlasBackend.verify`, ...). Decoding reads claims; it does not prove who signed them. Decoding for display in a browser is fine: disable the line with a comment saying so. |
| `no-public-env-secret` | error | Flags a secret read from a variable the framework publishes to the browser (`NEXT_PUBLIC_`, `VITE_`, `PUBLIC_`, `EXPO_PUBLIC_`, `NUXT_PUBLIC_` ...) when its name says it is a secret (`SECRET`, `PASSWORD`, `PRIVATE`, `SK`, `ACCESS_TOKEN` ...). Only the publishable key belongs in a public variable. |
