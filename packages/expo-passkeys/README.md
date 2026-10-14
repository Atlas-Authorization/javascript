# @atlasauth/expo-passkeys

Passkey registration and sign-in for Expo & React Native, a thin companion to
[`@atlasauth/expo`](../expo).

The server describes the WebAuthn ceremony (`begin`), the platform authenticator
performs it, and the result is POSTed back (`finish`). On the web the browser
runs the ceremony with `navigator.credentials`; on native there is no
`navigator`, so this package delegates the ceremony to
[`react-native-passkey`](https://github.com/f-23/react-native-passkey) — an
**optional peer you pass in** — and owns only the two HTTP calls and the body
mapping between them.

## Native dependency

```sh
npx expo install react-native-passkey
```

`react-native-passkey` is a native module: it needs a config plugin and a
**custom dev client / prebuild** (it does not run in Expo Go), plus an associated
domain (iOS `webcredentials:`) / Digital Asset Links (Android) for your RP id.
This package never imports it, so the import stays optional and your build keeps
compiling without it.

## Register (signed-in user)

```ts
import { Passkey } from 'react-native-passkey';
import { registerPasskey } from '@atlasauth/expo-passkeys';
import { useAuth } from '@atlasauth/expo';

const { getToken } = useAuth();

await registerPasskey({
  config: {
    frontendApi: 'https://fapi.your-instance.atlasauth.net',
    publishableKey: 'pk_live_…',
    getToken, // the /me/passkeys route is authenticated
  },
  passkey: Passkey,
  name: 'My iPhone',
});
```

## Sign in

```ts
import { Passkey } from 'react-native-passkey';
import { authenticateWithPasskey } from '@atlasauth/expo-passkeys';

const result = await authenticateWithPasskey({
  config: {
    frontendApi: 'https://fapi.your-instance.atlasauth.net',
    publishableKey: 'pk_live_…',
  },
  passkey: Passkey,
});

if (result.status === 'complete' && result.ticket) {
  // hand result.ticket to @atlasauth/expo to exchange for a session
} else if (result.status === 'needs_more') {
  // a second factor is still owed — result.attemptId / result.attemptStatus
}
```

`toRegistrationFinishBody` / `toAssertionFinishBody` are exported as pure helpers
if you want to drive the two HTTP calls yourself.
