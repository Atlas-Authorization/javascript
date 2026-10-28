# @atlasauth/expo

The official Atlas SDK for **Expo** — the Expo-native peer of
[`@atlasauth/react`](../react) and the Expo sibling of
[`@atlasauth/react-native`](../react-native). It wraps the React provider and
re-exports the same headless hooks and control components (`useAuth`, `useUser`,
`useSession`, `SignedIn`, `SignedOut`, `<Protect>`), so auth reads identically to
the web — swapping only the one thing Expo must change: **how the session is
carried.**

The web SDK keeps the session in an HttpOnly cookie. Expo / React Native has no
cookie jar, so `@atlasauth/expo` carries the session token in a **`tokenCache`**
backed by [`expo-secure-store`](https://docs.expo.dev/versions/latest/sdk/securestore/)
(hardware-backed Keychain / Keystore) and sends it as a bearer header.

## Install

```sh
npx expo install @atlasauth/expo expo-secure-store
# plus, as you use them:
#   expo-web-browser expo-auth-session   (OAuth)
```

`react` and `react-native` come from your Expo app. `expo-secure-store`,
`expo-web-browser` and `expo-auth-session` are all **optional peers** — install
only what you use.

## Token cache

```ts
// lib/tokenCache.ts
import * as SecureStore from 'expo-secure-store';
import { createSecureStoreTokenCache } from '@atlasauth/expo';

export const tokenCache = createSecureStoreTokenCache(SecureStore);
```

The package ships a non-persistent in-memory cache so it runs out of the box in
Expo Go and tests, but **production apps must pass a persistent cache** — the
secure-store one above.

## Provider (Expo Router)

Mount it once at the app root:

```tsx
// app/_layout.tsx
import { Slot } from 'expo-router';
import { AtlasProvider } from '@atlasauth/expo';
import { tokenCache } from '../lib/tokenCache';

export default function RootLayout() {
  return (
    <AtlasProvider
      publishableKey="pk_live_…"
      frontendApi="https://fapi.your-instance.atlasauth.net"
      tokenCache={tokenCache}
    >
      <Slot />
    </AtlasProvider>
  );
}
```

`frontendApi` is required — the publishable key encodes the instance id but not a
host. Use `https://atlasauth.net` before you verify a custom domain, your custom
domain after.

## Reading auth

```tsx
import { Text } from 'react-native';
import { useAuth, useUser, SignedIn, SignedOut } from '@atlasauth/expo';

function Screen() {
  const { isLoaded, isSignedIn, signOut } = useAuth();
  const { user } = useUser();
  if (!isLoaded) return <Text>Loading…</Text>;
  return (
    <>
      <SignedIn>
        <Text>Hello {user?.first_name}</Text>
      </SignedIn>
      <SignedOut>
        <Text>Please sign in</Text>
      </SignedOut>
    </>
  );
}
```

`getToken()` from `useAuth()` returns the stored session JWT for your own API
calls; `getProviderToken(provider)` returns the user's own live token at a
connected social provider.

> **Headless only on native.** The hooks and the conditional-render controls
> (`SignedIn` / `SignedOut` / `Protect` / `AtlasLoading` / `AtlasLoaded`) render
> no host element, so they run under React Native. The prebuilt web UI
> components (`<SignIn>`, `<UserButton>`, …) render DOM and are **web-only** —
> build those screens with React Native primitives and these hooks.

## OAuth with expo-web-browser

The provider exposes the same flow helpers as the web SDK; open the authorization
URL with `expo-web-browser` and let the provider complete the redirect. See
[`@atlasauth/react-native`](../react-native#oauth-with-expo-auth-session) for the
full pattern — it is identical here.

## Native session (first-party OAuth → session)

A first-party app that already holds an Atlas OAuth access token can trade it for
a cookie-free session with `createNativeSessionManager` — it exchanges once, then
auto-refreshes the short-lived JWT and persists each rotated refresh token into
the secure store:

```ts
import {
  createNativeSessionManager,
  exchangeForSession,
  tokenStorageFor,
} from '@atlasauth/expo';
import { tokenCache } from '../lib/tokenCache';

const mgr = await createNativeSessionManager({
  frontendApi: 'https://fapi.your-instance.atlasauth.net',
  publishableKey: 'pk_…',
  // a slot DEDICATED to the native session, separate from the provider's.
  storage: tokenStorageFor(tokenCache, 'atlas.native-session'),
});

const session = await exchangeForSession({ baseUrl, clientId, accessToken });
if (session) mgr.setSession(session);

const headers = await mgr.authHeaders(); // { Authorization, 'x-publishable-key' }
```

## Policy acceptance (terms of service, privacy)

When the app defines policies in the Atlas dashboard, sign-up must carry the user's acceptance and sign-in can be held until a
newer version is accepted. The components are React Native views (see `@atlasauth/react-native`); the hooks use this package's
provider and bearer client.

```tsx
import { usePolicies, PolicyConsent, PolicyClickwrap, PolicyScrollHost, useExpoFapiClient } from '@atlasauth/expo';
import { startSignUp } from '@atlasauth/js';

const { controller, canSubmit, build } = usePolicies();
const client = useExpoFapiClient();
// <PolicyConsent controller={controller} /> ... then, on submit (after <PolicyScrollHost> reads any `scroll` policies):
await startSignUp(client, { email, password, policyAcceptances: build() });
```

A sign-in held at `needs_policy_acceptance` is continued with `acceptAttemptPolicies(client, state, controller.build())` from
`@atlasauth/js` (`usePendingPolicies({ pendingPolicies })` builds the controller and `<PolicyAcceptStep>` draws the step).
`<PolicyGate>` shows a signed-in banner and re-acceptance modal.

## Companion packages

| Package | What it adds |
| --- | --- |
| [`@atlasauth/expo-passkeys`](../expo-passkeys) | Passkey register / sign-in via `react-native-passkey` |
| [`@atlasauth/expo-biometrics`](../expo-biometrics) | Gate a stored session behind Face ID / Touch ID |
| [`@atlasauth/expo-google-signin`](../expo-google-signin) | Native Google sign-in → Atlas id_token sign-in |
