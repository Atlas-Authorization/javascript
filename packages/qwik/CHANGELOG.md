# @atlasauth/qwik changelog

## 0.1.3
- **`frontendApi` is validated at `<AtlasProvider>` render (including SSR) and `createAtlasClient()`.** A missing (or non-string) or malformed value now throws an
  `AtlasConfigError` (from `@atlasauth/js`; `code: 'FRONTEND_API_REQUIRED'` or `'FRONTEND_API_INVALID'`)
  instead of silently sending requests to relative URLs on the app's own origin. Accepted: an absolute
  `https:` URL (`http:` only for localhost / local development hosts), or `"same-origin"` / a root-relative path such as `"/atlas"` for a reverse proxy.
- **Deprecated:** `frontendApi: ""` (the original same-origin spelling) still works as same-origin, with a
  one-time console warning; use `"same-origin"` instead.

## 0.1.2

### Added
- `signOut()` now runs OIDC front-channel logout before clearing local state: the front-channel logout URLs returned when the session is revoked are loaded in hidden iframes (up to 5 seconds), so other apps signed in through the session are signed out in this browser too. Pass `signOut({ frontchannel: false })` to skip it. `signOut` on `AtlasClient` and `useAuth()` now accepts an optional `SignOutOptions`.

## 0.1.1

### Added
- `useAuth()` now also returns `status` (`loading` | `signed_in` | `signed_out`) and `session` (the active session, or `null`) alongside `isLoaded` / `isSignedIn`.

## 0.1.0

First published release.

### Added
- `AtlasProvider` component and `createAtlasClient()` for Qwik and Qwik City.
- Hooks: `useAuth()`, `useUser()`, `useSession()`, `useOrganization()` and `useAtlas()`.
- Guards: `<SignedIn>`, `<SignedOut>`, `<AtlasLoading>`, `<AtlasLoaded>` and `<Protect>` (permission, role, plan and feature conditions).
- Mountable `<SignIn>`, `<SignUp>` and `<UserButton>` components, plus `mountAtlasWidget()`.
- `@atlasauth/qwik/server` entry with `getAuthState()` and `protectRoute()` for Qwik City route protection.
- Store selectors (`isLoaded`, `isSignedIn`, `userId`, `orgId`, `currentUser`, and more) and types `AtlasUser`, `AtlasSession`, `SessionClaims`, `AuthStatus`.
