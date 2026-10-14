# @atlasauth/expo-biometrics

Gate a stored Atlas session behind Face ID / Touch ID / fingerprint, a thin
companion to [`@atlasauth/expo`](../expo).

A persisted session keeps a returning user signed in across restarts — but it
also means whoever holds the unlocked phone is signed in. `protectWithBiometrics`
puts a local biometric prompt in front of revealing that token, so the session is
handed back only after the device owner authenticates. It wraps
[`expo-local-authentication`](https://docs.expo.dev/versions/latest/sdk/local-authentication/)
(an **optional peer you pass in**).

> This is a **local** gate — it decides whether the app reveals a token it
> already holds. The server still validates that token on every request.

## Install

```sh
npx expo install expo-local-authentication
```

Add `NSFaceIDUsageDescription` (iOS) via the config plugin. Biometrics run in a
dev client / standalone build, not Expo Go.

## Usage

```ts
import * as LocalAuthentication from 'expo-local-authentication';
import { protectWithBiometrics } from '@atlasauth/expo-biometrics';
import { tokenStorageFor } from '@atlasauth/expo';
import { tokenCache } from '../lib/tokenCache';

const result = await protectWithBiometrics({
  auth: LocalAuthentication,
  storage: tokenStorageFor(tokenCache, 'atlas.session'),
  prompt: { promptMessage: 'Unlock Acme' },
});

if (result.ok) {
  // result.token is the session JWT — proceed into the app
} else if (result.reason === 'no_session') {
  // nothing stored — route to sign-in
} else {
  // 'authentication_failed' | 'not_enrolled' | 'no_hardware' — keep the app locked
}
```

Use `isBiometricsAvailable(LocalAuthentication)` to decide whether to show an
"unlock with Face ID" affordance at all. Pass `allowWhenUnavailable: true` to fall
through on devices with no enrolled biometric instead of locking the user out.
