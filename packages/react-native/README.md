# @atlasauth/react-native

The official Atlas SDK for React Native and Expo — the native peer of
[`@atlasauth/react`](../react). It reuses the framework-agnostic
[`@atlasauth/js`](../js) client for every API call and mirrors the web hook surface
(`useAuth`, `useUser`, `useSignIn`, `useSignUp`, …), minus the DOM.

The one architectural difference from the web SDK: **the web SDK keeps the
session in a cookie; React Native has no cookie jar, so the session token is
held in a storage adapter you supply** and sent as a bearer header. You choose
where it lives — the Keychain / Keystore (recommended) or AsyncStorage.

## Install

```sh
npm install @atlasauth/react-native
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
import type { TokenStorage } from '@atlasauth/react-native';

export const secureStorage: TokenStorage = {
  getToken: () => SecureStore.getItemAsync('atlas.session'),
  setToken: (t) => SecureStore.setItemAsync('atlas.session', t),
  clearToken: () => SecureStore.deleteItemAsync('atlas.session'),
};
```

### AsyncStorage (simpler, not encrypted)

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { TokenStorage } from '@atlasauth/react-native';

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
import { AtlasProvider } from '@atlasauth/react-native';
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
import { useSignIn, useAuth } from '@atlasauth/react-native';

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
import { useSignIn } from '@atlasauth/react-native';

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
import { useSignUp } from '@atlasauth/react-native';

const { signUpWithPassword, verifyEmailCode } = useSignUp();

const result = await signUpWithPassword({ emailAddress, password });
if (result.status === 'needs_more' && result.attemptId) {
  // instance requires email verification — collect the code, then:
  await verifyEmailCode({ attemptId: result.attemptId, code });
}
// 'complete' → the token is persisted; the user is signed in.
```

Pass the instance's configured sign-up fields by key with `fields` (`firstName` /
`lastName` are shorthands for `first_name` / `last_name`), and `consent: true` when
the instance requires agreement to its terms.

### Captcha

When the instance requires a captcha on sign-up or sign-in, the request needs a
solved token. Captcha providers draw their challenge in a browser, so this SDK
renders none itself — render it your own way (the provider's React Native SDK, or
a WebView that loads the provider script with the site key) and hand the token
over, either per call or once on the provider:

```tsx
<AtlasProvider
  publishableKey={pk}
  getCaptchaToken={async ({ flow, captcha }) => {
    // captcha: { provider, siteKey, widget } for this flow, or null
    return await showCaptchaChallenge(captcha); // resolve the token, or null to cancel
  }}
>
```

`getCaptchaToken` is only called when a token is needed (the request was refused
with `CAPTCHA_REQUIRED` / `CAPTCHA_FAILED`, or sign-in answered with a captcha
challenge), and the request is retried once with it. A `captchaToken` passed to
`signUpWithPassword` / `signInWithPassword` is used first. Without either, the call
returns a `CAPTCHA_REQUIRED` error — check it with `isCaptchaRequired(result)`.

### Error codes

`FlowResult.errors` carries the server's `{ code, message }` items; `message` is
written for end users. `ATLAS_ERROR_CODES` names the codes the SDK knows. When the
app has no way to send email, any step that would send one (sign-up verification,
email code, reset) is refused with **422 `EMAIL_DELIVERY_NOT_CONFIGURED`** before
anything is issued:

```tsx
import { firstErrorMessage, isEmailDeliveryNotConfigured } from '@atlasauth/react-native';

const result = await signUpWithPassword({ emailAddress, password });
if (isEmailDeliveryNotConfigured(result)) {
  // "This app can't send email right now. Try another sign-in method or contact the app owner."
  setBanner(firstErrorMessage(result));
}
```

## Policy acceptance (terms of service, privacy)

When the app defines policies in the Atlas dashboard, sign-up must carry the user's acceptance and sign-in can be held
until a newer version is accepted.

```tsx
// Sign-up: show the policies, send what the user accepted.
const { controller, canSubmit, build } = usePolicies();
const { signUpWithPassword } = useSignUp();
const [reading, setReading] = useState(false);

<PolicyConsent controller={controller} />              {/* checkbox + in-app document viewer */}
<Button title="Create account" disabled={!canSubmit} onPress={() => setReading(true)} />
<PolicyClickwrap controller={controller} viewer={false} />   {/* "By continuing you agree to ..." */}
<PolicyScrollHost                                       {/* `scroll` policies: unskippable modal */}
  controller={controller}
  active={reading}
  onDecline={() => setReading(false)}
  onDone={() => { setReading(false); void signUpWithPassword({ emailAddress, password, policyAcceptances: build() }); }}
/>
```

A sign-in the server holds comes back as a `FlowResult` with `attemptStatus: 'needs_policy_acceptance'`, a `policyToken` and
`pendingPolicies` (an OAuth redirect gives the token via `completeOAuthRedirect(url)`):

```tsx
const { controller } = usePendingPolicies(held);   // held: that FlowResult, or null
const { acceptPolicies } = useSignIn();
controller && (
  <PolicyAcceptStep
    controller={controller}
    onSubmit={(acceptances) => acceptPolicies({ attemptId: held.attemptId!, policyToken: held.policyToken, acceptances })}
    onDecline={cancel}
  />
);
```

For a signed-in user whose policies changed, render `<PolicyGate>` near the top of a screen: it draws a banner (with any grace
window) and the re-acceptance modal. A 422 `POLICY_ACCEPTANCE_REQUIRED` on sign-up means a policy changed while the form was
open: call `refresh()` from `usePolicies()`.

## Hooks

| Hook            | Returns                                                                             |
| --------------- | ----------------------------------------------------------------------------------- |
| `useAuth()`     | `isLoaded`, `isSignedIn`, `userId`, `sessionId`, `orgId`, `orgRole`, `getToken`, `getProviderToken`, `signOut` |
| `useUser()`     | `isLoaded`, `isSignedIn`, `user`, `getProviderToken`                                 |
| `useSession()`  | `isLoaded`, `session`                                                                |
| `useSignIn()`   | `signInWithPassword`, `attemptSecondFactor`, `startOAuth`, `completeOAuthRedirect`   |
| `useSignUp()`   | `signUpWithPassword`, `verifyEmailCode`                                              |
| `useEmailDelivery()` | `isLoaded`, `emailDelivery` (`available`, `passwordReset`, `passwordSignUp`)    |

`getToken()` returns the stored session JWT for attaching to your own API
requests. `getProviderToken(provider)` returns the signed-in user's own live
access token at a connected social provider (Google, GitHub, …).

`signOut(options?)` revokes the session on the server, clears the stored token
and resolves `{ revoked, activeSessionId? }`; `signOut({ strict: true })`
rejects with a `SignOutError` (after signing out locally) when the server could
not be reached. A session whose revoke failed is remembered and never
re-adopted; pass a persistent `tombstoneStore` (AsyncStorage /
`expo-secure-store`, see `createInMemoryTombstoneStore`) to keep that across
restarts.

## Native session (first-party OAuth → session)

A first-party app that already holds an Atlas OAuth access token can trade it for
a cookie-free session with `createNativeSessionManager` — it exchanges once, then
auto-refreshes the short-lived JWT and persists each rotated refresh token into
your `TokenStorage` (Keychain / Keystore):

```ts
import { createNativeSessionManager, exchangeForSession } from '@atlasauth/react-native';

const mgr = await createNativeSessionManager({
  frontendApi: 'https://fapi.your-instance.atlasauth.net',
  publishableKey: 'pk_...',
  storage: secureStorage, // a TokenStorage dedicated to the native session
});
const session = await exchangeForSession({ baseUrl, clientId, accessToken });
if (session) mgr.setSession(session);

const headers = await mgr.authHeaders(); // { Authorization, 'x-publishable-key' }
```
