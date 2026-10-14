# @atlasauth/capacitor

The official Atlas SDK for **Capacitor / Ionic** — the cross-platform
(iOS · Android · web) native-auth sibling of [`@atlasauth/electron`](../electron)
and [`@atlasauth/expo`](../expo). It gives a Capacitor app the **native-session
sign-in flow**: system browser → deep-link callback → PKCE → a cookie-free Atlas
session that auto-refreshes and persists in secure storage.

A Capacitor app is a web layer (a WebView on device, a real browser on the web
target) with no cookie against the Atlas FAPI origin, so it cannot carry a
session the way a web page does. Instead it signs in through the **system
browser**, catches the **deep-link** callback, completes **PKCE**, trades the
code for an Atlas session, and carries that session itself as a bearer — wrapping
the same `@atlasauth/js` `NativeSessionManager` / `exchangeForSession` /
`refreshNativeSession` core the Electron and Expo SDKs use.

## Install

```sh
npm install @atlasauth/capacitor
npx cap sync
# the Capacitor plugins it drives (all optional peers — install what you use):
npm install @capacitor/browser @capacitor/app @capacitor/preferences
```

`@capacitor/core`, `@capacitor/browser`, `@capacitor/app` and
`@capacitor/preferences` are **optional peers**. The package compiles and runs
without them (falling back gracefully), but the native sign-in flow needs
`@capacitor/browser` + `@capacitor/app`, and persistence needs a token store.

### Deep-link setup

Register your custom scheme so the authorize redirect reopens the app, and route
`appUrlOpen` to Atlas:

- iOS: add the scheme under `CFBundleURLTypes` in `Info.plist`.
- Android: add an `intent-filter` with your scheme to the main activity.

Your `redirectUri` is that scheme, e.g. `com.acme.app://auth`.

## Quick start

```ts
import { createAtlasCapacitor } from '@atlasauth/capacitor';

export const atlas = await createAtlasCapacitor({
  publishableKey: 'pk_live_…',
  frontendApi: 'https://fapi.your-instance.atlasauth.net',
  clientId: 'client_…',            // your first-party native OAuth client
  redirectUri: 'com.acme.app://auth',
});

// Sign in (opens the system browser; resolves once the deep link returns).
await atlas.signIn();

// Call your own API with the live, auto-refreshing session.
const res = await fetch('/api/thing', { headers: await atlas.authHeaders() });

atlas.onChange((session) => console.log('session rotated', session.sessionId));
await atlas.signOut();
```

`frontendApi` is required — the publishable key encodes the instance id but not a
host. Use `https://atlasauth.net` before you verify a custom domain, your custom
domain after.

### The handle

| Method | What it does |
| --- | --- |
| `signIn({ redirectUri?, scope? })` | System browser → deep-link callback → PKCE → session. On the web target, falls back to the standard redirect (see below). |
| `handleRedirectCallback(url?)` | Finish a **web** redirect sign-in on app load. |
| `signOut()` | Forget the session and clear the store. |
| `getToken()` | The current session JWT, auto-refreshed near expiry. |
| `authHeaders()` | `{ Authorization, 'x-publishable-key' }` for `/v1/client/me/*` and your API. |
| `getSession()` | The current `NativeSession`, or null. |
| `onChange(listener)` | Fires on every session change; returns an unsubscribe. |

## Web target (PWA)

On the web, there is no deep link, so `signIn()` falls back to the **standard
redirect**: it stashes the PKCE verifier and navigates to the authorize URL.
Finish on the next load:

```ts
// on app boot, when the URL looks like your callback:
const session = await atlas.handleRedirectCallback(); // defaults to window.location.href
```

## Secure storage

By default the session is persisted with `@capacitor/preferences` when that
plugin is present, else a non-persistent in-memory store.

> ⚠️ **`@capacitor/preferences` is plaintext at rest** (UserDefaults /
> SharedPreferences). For production, back the store with a secure-storage
> community plugin (e.g. `@capacitor-community/secure-storage`) behind the same
> `TokenStore` interface:

```ts
import { createAtlasCapacitor, type TokenStore } from '@atlasauth/capacitor';

const secureStore: TokenStore = {
  getToken: () => SecureStorage.get('atlas.session'),
  setToken: (v) => SecureStorage.set('atlas.session', v),
  clearToken: () => SecureStorage.remove('atlas.session'),
};

const atlas = await createAtlasCapacitor({ /* … */ storage: secureStore });
```

## Driving the pieces yourself

The flow is also exposed à la carte: `createPkcePair`, `buildAuthorizeUrl`,
`parseAuthCallback`, `redeemAuthorizationCode`, `exchangeAuthCode`,
`signInWithBrowser`, `completeRedirectSignIn`, plus
`createNativeSessionManager` / `exchangeForSession` / `refreshNativeSession`
re-exported from [`@atlasauth/js`](../js).
