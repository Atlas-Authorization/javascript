# @atlas/react-native

The official Atlas SDK for React Native and Expo — the native peer of
[`@atlas/react`](../react). It reuses the framework-agnostic
[`@atlas/js`](../js) client for every API call and mirrors the web hook surface
(`useAuth`, `useUser`, `useSignIn`, `useSignUp`, …), minus the DOM.

The one architectural difference from the web SDK: **the web SDK keeps the
session in a cookie; React Native has no cookie jar, so the session token is
held in a storage adapter you supply** and sent as a bearer header. You choose
where it lives — the Keychain / Keystore (recommended) or AsyncStorage.

## Install

```sh
npm install @atlas/react-native
# peers you already have in an Expo / RN app:
#   react, react-native
# plus whichever secure store you wire the adapter to (see below)
```

## Storage adapter

`AtlasProvider` needs a `TokenStorage` — three methods, each sync or async. The
package ships a non-persistent in-memory default so it runs out of the box, but
**production apps must pass a persistent, ideally encrypted, adapter.**

### expo-secure-store (recommended — hardware-backed)

```ts
import * as SecureStore from 'expo-secure-store';
import type { TokenStorage } from '@atlas/react-native';

export const secureStorage: TokenStorage = {
  getToken: () => SecureStore.getItemAsync('atlas.session'),
  setToken: (t) => SecureStore.setItemAsync('atlas.session', t),
  clearToken: () => SecureStore.deleteItemAsync('atlas.session'),
};
```

### AsyncStorage (simpler, not encrypted)

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { TokenStorage } from '@atlas/react-native';

export const asyncStorage: TokenStorage = {
  getToken: () => AsyncStorage.getItem('atlas.session'),
  setToken: (t) => AsyncStorage.setItem('atlas.session', t),
  clearToken: () => AsyncStorage.removeItem('atlas.session'),
};
```

Neither library is a dependency of this package — the adapter is the whole
contract, so you install only what you use.

## Provider

```tsx
import { AtlasProvider } from '@atlas/react-native';
import { secureStorage } from './storage';

export default function App() {
  return (
    <AtlasProvider
      publishableKey="pk_live_…"
      frontendApi="https://fapi.your-instance.com"
      storage={secureStorage}
    >
      <RootNavigator />
    </AtlasProvider>
  );
}
```

## Password sign-in

```tsx
import { useState } from 'react';
import { View, TextInput, Button, Text } from 'react-native';
import { useSignIn, useAuth } from '@atlas/react-native';

function SignInScreen() {
  const { signInWithPassword } = useSignIn();
  const { isSignedIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function onSubmit() {
    const result = await signInWithPassword({ identifier: email, password });
    if (result.status === 'error') setError(result.errors[0]?.message ?? 'Sign-in failed');
    else if (result.status === 'needs_more') {
      // e.g. a second factor is owed — result.attemptId / result.attemptStatus
      // then: signIn.attemptSecondFactor({ attemptId, status, code })
    }
    // 'complete' → the token is persisted; `useAuth().isSignedIn` flips to true.
  }

  if (isSignedIn) return <Text>Signed in</Text>;
  return (
    <View>
      <TextInput value={email} onChangeText={setEmail} autoCapitalize="none" />
      <TextInput value={password} onChangeText={setPassword} secureTextEntry />
      <Button title="Sign in" onPress={onSubmit} />
      {error ? <Text>{error}</Text> : null}
    </View>
  );
}
```

## OAuth with expo-auth-session

`startOAuth` returns the provider's authorization URL — this SDK never opens a
browser itself, so you stay in control of the flow. Open the URL, then hand the
deep-link callback back to `completeOAuthRedirect`.

```tsx
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import { useSignIn } from '@atlas/react-native';

function useGoogleSignIn() {
  const { startOAuth, completeOAuthRedirect } = useSignIn();
  const redirectUrl = Linking.createURL('oauth-callback'); // myapp://oauth-callback

  return async function signInWithGoogle() {
    const { authorizationUrl, errors } = await startOAuth({ provider: 'google', redirectUrl });
    if (!authorizationUrl) throw new Error(errors[0]?.message ?? 'Could not start OAuth');

    // Opens the system browser and resolves when the provider redirects back.
    const result = await WebBrowser.openAuthSessionAsync(authorizationUrl, redirectUrl);
    if (result.type !== 'success') return; // user cancelled

    // The callback URL carries the one-time ticket; this exchanges it for a
    // session token and persists it. `useAuth().isSignedIn` then flips to true.
    const outcome = await completeOAuthRedirect(result.url);
    if (outcome.status === 'error') throw new Error(outcome.errors[0]?.message);
  };
}
```

`redirectUrl` must be registered as an allowed redirect URL on the instance.
`expo-auth-session`, `expo-web-browser`, and `Linking` are all optional — any
mechanism that opens a URL and gives you back the callback works.

## Sign-up

```tsx
import { useSignUp } from '@atlas/react-native';

const { signUpWithPassword, verifyEmailCode } = useSignUp();

const result = await signUpWithPassword({ emailAddress, password });
if (result.status === 'needs_more' && result.attemptId) {
  // instance requires email verification — collect the code, then:
  await verifyEmailCode({ attemptId: result.attemptId, code });
}
// 'complete' → the token is persisted; the user is signed in.
```

## Hooks

| Hook            | Returns                                                                             |
| --------------- | ----------------------------------------------------------------------------------- |
| `useAuth()`     | `isLoaded`, `isSignedIn`, `userId`, `sessionId`, `orgId`, `orgRole`, `getToken`, `getProviderToken`, `signOut` |
| `useUser()`     | `isLoaded`, `isSignedIn`, `user`, `getProviderToken`                                 |
| `useSession()`  | `isLoaded`, `session`                                                                |
| `useSignIn()`   | `signInWithPassword`, `attemptSecondFactor`, `startOAuth`, `completeOAuthRedirect`   |
| `useSignUp()`   | `signUpWithPassword`, `verifyEmailCode`                                              |

`getToken()` returns the stored session JWT for attaching to your own API
requests. `getProviderToken(provider)` returns the signed-in user's own live
access token at a connected social provider (Google, GitHub, …).
