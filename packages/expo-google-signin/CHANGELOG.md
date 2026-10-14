# @atlasauth/expo-google-signin changelog

## 0.1.1
- **`frontendApi` is validated at client creation.** A missing, empty or malformed value now throws an
  `AtlasConfigError` (from `@atlasauth/js`; `code: 'FRONTEND_API_REQUIRED'` or `'FRONTEND_API_INVALID'`)
  instead of silently sending requests to relative URLs on the app's own origin. Accepted: an absolute
  `https:` URL (`http:` only for localhost / local development hosts). Native apps have no origin of their own, so `"same-origin"` is refused.

## 0.1.0

First published release.

### Added
- `signInWithGoogle()` trades a native Google `id_token` for an Atlas session, returning a `GoogleSignInResult` (`complete`, `needs_more`, `error`, `cancelled`).
- Nonce binding enabled by default (`useNonce`) and an optional Play Services check (`checkPlayServices`).
- `extractIdToken()` reads the token from both current and legacy Google Sign-In response shapes.
- `createFapiClient()` / `AtlasFapiConfig` for configuring the Atlas instance.
- Works with `@react-native-google-signin/google-signin`, passed in as an optional peer.
