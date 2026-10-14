# @atlasauth/expo-biometrics changelog

## 0.1.0

First published release.

### Added
- `protectWithBiometrics()` gates a stored session token behind Face ID / Touch ID / fingerprint, returning a `ProtectResult` (`ok`, `token`, `reason`, `error`).
- `isBiometricsAvailable()` checks for hardware and enrolment.
- `BiometricReason` codes: `no_hardware`, `not_enrolled`, `authentication_failed`, `no_session`.
- `allowWhenUnavailable` option to fall through on devices without biometrics.
- Works with `expo-local-authentication`, passed in as an optional peer (`LocalAuthentication`, `StoredSession` interfaces).
