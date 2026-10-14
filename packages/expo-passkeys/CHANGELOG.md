# @atlasauth/expo-passkeys changelog

## 0.1.1
- **`frontendApi` is validated at client creation.** A missing, empty or malformed value now throws an
  `AtlasConfigError` (from `@atlasauth/js`; `code: 'FRONTEND_API_REQUIRED'` or `'FRONTEND_API_INVALID'`)
  instead of silently sending requests to relative URLs on the app's own origin. Accepted: an absolute
  `https:` URL (`http:` only for localhost / local development hosts). Native apps have no origin of their own, so `"same-origin"` is refused.

## 0.1.0

First published release.

### Added
- `registerPasskey()` runs the passkey registration ceremony against Atlas on Expo / React Native.
- `authenticateWithPasskey()` signs in with a passkey.
- `toRegistrationFinishBody()` and `toAssertionFinishBody()` map native authenticator results to the Atlas request bodies.
- `createFapiClient()` / `AtlasFapiConfig` for configuring the Atlas instance.
- Works with `react-native-passkey`, passed in as an optional peer and never imported directly.
