# @atlasauth/react

React components and hooks for Atlas.

## Sign in with Atlas (any website)

Let people sign in to any site with their Atlas account. No `<AtlasProvider>` needed.

```tsx
import { SignInWithAtlasButton, completeSignInWithAtlas } from '@atlasauth/react';

<SignInWithAtlasButton clientId="YOUR_CLIENT_ID" redirectUri="https://example.com/callback" />;

// On the redirect page:
const { idToken, claims } = await completeSignInWithAtlas();
```

Register an app under Account → Sign in with Atlas in the dashboard. Always verify
`idToken` on your server (signature via JWKS, `iss`, `aud`, `exp`) before trusting it.
Use `buildAtlasAuthorizeUrl()` for a custom button.

Server app (one with a client secret)? The code must be exchanged by your server, so let the
button hand off to your backend login route instead of running PKCE in the browser:

```tsx
<SignInWithAtlasButton loginUri="/auth/atlas/login" />
```

`loginUri` must be a same-origin path or an `https://` URL.
