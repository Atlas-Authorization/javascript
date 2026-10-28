# gatsby-plugin-atlasauth

Wire [Atlas](https://atlasauth.net) authentication into a [Gatsby](https://www.gatsbyjs.com) site. The Atlas peer of `gatsby-plugin-clerk`.

The plugin wraps your whole app in `@atlasauth/react`'s `<AtlasProvider>` through Gatsby's SSR **and** browser APIs — using the *same* wrap on both sides — so the provider's hooks and components work on every page, server-rendered and hydrated with no mismatch.

## Install

```sh
npm install gatsby-plugin-atlasauth @atlasauth/react
```

`gatsby`, `react` and `react-dom` are peer dependencies.

## Configure

```js
// gatsby-config.js
module.exports = {
  plugins: [
    {
      resolve: 'gatsby-plugin-atlasauth',
      options: {
        // pk_(live|test)_<instanceId>
        publishableKey: 'pk_live_…',
        // The instance's Frontend API origin (shared host, a verified custom
        // domain, or "same-origin" for a same-origin / reverse-proxy setup). Required.
        frontendApi: 'https://atlasauth.net',
        // optional, passed straight through to <AtlasProvider>
        // appearance: { variables: { colorPrimary: '#6c47ff' } },
        // localization: myCatalog,
        // oauthMode: 'popup',
      },
    },
  ],
};
```

### Environment variables

Any option left out of `gatsby-config` falls back to the environment, `GATSBY_*` (inlined into the browser bundle) taking precedence over the unprefixed form:

| Option           | Env (browser-safe)                 | Env (Node/SSR)            |
| ---------------- | ---------------------------------- | ------------------------- |
| `publishableKey` | `GATSBY_ATLAS_PUBLISHABLE_KEY`     | `ATLAS_PUBLISHABLE_KEY`   |
| `frontendApi`    | `GATSBY_ATLAS_FRONTEND_API`        | `ATLAS_FRONTEND_API`      |

The plugin's `gatsby-node` forwards the resolved values into the browser bundle as `GATSBY_*` defines, so setting only the unprefixed `ATLAS_*` works client-side too.

## Use

Anywhere in your pages or components:

```tsx
import { useUser, SignedIn, SignedOut, SignInButton, UserButton } from '@atlasauth/react';

export default function Header() {
  const { user } = useUser();
  return (
    <header>
      <SignedIn>
        <span>Hi {user?.first_name}</span>
        <UserButton />
      </SignedIn>
      <SignedOut>
        <SignInButton />
      </SignedOut>
    </header>
  );
}
```

## Direct use

The shared wrap and option helpers are exported for custom `gatsby-browser` / `gatsby-ssr` wiring or testing:

```ts
import { wrapRootElement, resolveOptions } from 'gatsby-plugin-atlasauth';
```
