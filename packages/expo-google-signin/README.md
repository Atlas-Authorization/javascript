# @atlasauth/expo-google-signin

Native Google sign-in for Expo & React Native, a thin companion to
[`@atlasauth/expo`](../expo).

The device-native Google button
([`@react-native-google-signin/google-signin`](https://react-native-google-signin.github.io/),
an **optional peer you pass in**) yields a Google `id_token`; this helper trades
it for an Atlas session via the native id_token endpoint — the same path the
web's One-Tap button uses.

## Install

```sh
npx expo install @react-native-google-signin/google-signin
```

It is a native module: configure it with your Google OAuth client ids and build a
dev client / standalone app (it does not run in Expo Go). Configure it once at
startup:

```ts
import { GoogleSignin } from '@react-native-google-signin/google-signin';

GoogleSignin.configure({
  webClientId: 'xxxx.apps.googleusercontent.com', // used to mint the id_token
  iosClientId: 'xxxx.apps.googleusercontent.com',
});
```

## Usage

```ts
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { signInWithGoogle } from '@atlasauth/expo-google-signin';

const result = await signInWithGoogle({
  config: {
    frontendApi: 'https://fapi.your-instance.atlasauth.net',
    publishableKey: 'pk_live_…',
  },
  googleSignin: GoogleSignin,
});

switch (result.status) {
  case 'complete':
    // result.jwt is the session token — persist it via @atlasauth/expo's cache
    break;
  case 'cancelled':
    break; // user dismissed the Google sheet
  case 'needs_more':
    // a second factor is owed — result.attemptId / result.attemptStatus
    break;
  case 'error':
    console.warn(result.errors[0]?.message);
    break;
}
```

By default the helper mints a single-use **nonce** and binds the Google
`id_token` to it (replay protection); pass `useNonce: false` only if your Google
configuration cannot forward one. `extractIdToken` is exported as a pure helper
for the two Google response shapes (v13 envelope vs. the older flat object).
