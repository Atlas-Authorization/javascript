# gatsby-plugin-atlasauth changelog

## 0.1.3
- **Fixed:** depends on `@atlasauth/react` `^0.9.0` instead of one exact version. With an exact pin, an app that also
  installed a newer `@atlasauth/react` got two copies, and hooks from one couldn't see the other's
  `<AtlasProvider>` ("Atlas hooks must be used inside <AtlasProvider>").

## 0.1.2
- Picks up `@atlasauth/react` 0.6.0 / `@atlasauth/js` 0.7.0: popup sign-in completes when the opener page
  sends `Cross-Origin-Opener-Policy: same-origin`; a tab opened after a failed sign-out stays signed out
  (sign-out tombstones shared across tabs); the default focus ring keeps 3:1 contrast. No API changes.

## 0.1.1
- **`frontendApi` is required.** An unset `frontendApi` (plugin option, `GATSBY_ATLAS_FRONTEND_API` or
  `ATLAS_FRONTEND_API`) now throws an `AtlasConfigError` (`code: 'FRONTEND_API_REQUIRED'`) naming those settings,
  instead of rendering with relative URLs. `ResolvedAtlasOptions.frontendApi` is now `string | undefined`
  (was `string`, defaulting to `""`). Use `"same-origin"` for a reverse proxy.
- **Deprecated:** an explicit `frontendApi: ""` plugin option still means same-origin, with a one-time console
  warning; use `"same-origin"` instead.

## 0.1.0

First published release.

### Added
- Gatsby plugin that wraps the site in `@atlasauth/react`'s `<AtlasProvider>` through both the SSR and browser APIs, using one shared `wrapRootElement` so hydration matches the server HTML.
- Plugin options (`GatsbyAtlasOptions`) including `publishableKey`, resolved by `resolveOptions()`.
- `onCreateWebpackConfig` node API hook.
- `gatsby`, `react` and `react-dom` are peer dependencies.
