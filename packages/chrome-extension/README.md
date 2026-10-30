# @atlasauth/chrome-extension

The official Atlas SDK for Chrome / MV3 browser extensions — the extension peer
of [`@atlasauth/react`](../react). It reuses the framework-agnostic
[`@atlasauth/js`](../js) client for every API call and, through the `/react`
entry point, the full React hook + component surface.

The one architectural difference from the web SDK: **the web SDK carries the
session in a cookie; a browser extension has no cookie jar to the Atlas FAPI
origin.** So the session token is cached in `chrome.storage.local` and attached
to every request by hand, as a bearer.

## Entry points

| Import from | Pulls in React? | Use in |
| --- | --- | --- |
| `@atlasauth/chrome-extension` | no | anywhere (core: store + client) |
| `@atlasauth/chrome-extension/background` | no | the service worker |
| `@atlasauth/chrome-extension/react` | yes (peer) | popup / options / side panel |

## Sign in

```ts
import { signInWithWebAuthFlow } from '@atlasauth/chrome-extension/background';

const session = await signInWithWebAuthFlow({
  frontendApi: 'https://fapi.your-instance.atlasauth.net',
  publishableKey: 'pk_...',
  clientId: 'your-extension-oauth-client-id',
});
const jwt = await session.getToken(); // Authorization: Bearer for your backend
```

Needs the `"identity"` permission. Register `chrome.identity.getRedirectURL()`
(`https://<extension-id>.chromiumapp.org/`) as the redirect URI of a public,
first-party OAuth client. See the "Sign in from a browser extension" guide.

## Background service worker

```ts
import { createAtlasClient } from '@atlasauth/chrome-extension/background';

const atlas = createAtlasClient({
  publishableKey: 'pk_...',
  frontendApi: 'https://fapi.your-instance.atlasauth.net',
  background: true,
});

// The service worker has no long-lived timer (MV3 evicts it), so refresh the
// token whenever it wakes instead of on an in-page interval.
chrome.alarms.create('atlas-refresh', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'atlas-refresh') void atlas.syncSessionToken();
});
```

`syncSessionToken()` reads the stored token, and if it is inside its refresh lead
window (or you pass `{ force: true }`) mints a fresh one via
`POST /v1/client/sessions/:sid/tokens` and writes it back to `chrome.storage`.

## Popup / options page (React)

```tsx
import { AtlasProvider, useAuth, useUser } from '@atlasauth/chrome-extension/react';

export function App() {
  return (
    <AtlasProvider
      publishableKey="pk_..."
      frontendApi="https://fapi.your-instance.atlasauth.net"
    >
      <Profile />
    </AtlasProvider>
  );
}
```

The provider wraps `@atlasauth/react`'s provider and injects a `fetch` that
attaches the stored token as a bearer and captures any refreshed token back into
`chrome.storage`. The token must already be in the store — seed it with
`client.setToken(jwt)` after a hosted sign-in.

## The store

```ts
import { StorageCache } from '@atlasauth/chrome-extension';

const store = new StorageCache();       // chrome.storage.local, default key
await store.setToken(jwt);
await store.getToken();                  // string | null
await store.removeToken();
```

`chrome` is typed structurally, so the package needs no `@types/chrome`. Pass a
custom `area` (e.g. `chrome.storage.session`, or `createMemoryStorageArea()` in
tests) to change where the token lives.

## Manifest

Add the `storage` permission and the Atlas FAPI origin as a host permission:

```json
{
  "permissions": ["storage", "alarms"],
  "host_permissions": ["https://fapi.your-instance.atlasauth.net/*"]
}
```

## Native session (first-party OAuth → session)

A first-party extension holding an Atlas OAuth access token can trade it for a
cookie-free session with `createNativeSessionManager`. It persists each rotated
refresh token in `chrome.storage` under its own key, so a woken service worker
rehydrates it and auto-refreshes the short-lived JWT:

```ts
import { createNativeSessionManager, exchangeForSession } from '@atlasauth/chrome-extension';

const mgr = await createNativeSessionManager({
  frontendApi: 'https://fapi.your-instance.atlasauth.net',
  publishableKey: 'pk_...',
});
const session = await exchangeForSession({ baseUrl, clientId, accessToken });
if (session) mgr.setSession(session);

const headers = await mgr.authHeaders(); // { Authorization, 'x-publishable-key' }
```
