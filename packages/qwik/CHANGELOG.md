# @atlasauth/qwik changelog

## 0.3.0

### Added
- **Server errors in the app's language.** `<SignIn>` / `<SignUp>` take `locale?: string` (sent as
  `Accept-Language`) and `localization?` (strings keyed `error.<reason>`, e.g. `esES` from
  `@atlasauth/localizations`); both pass through to the embed widget, as do the new `MountWidgetOptions.locale`
  and `MountWidgetOptions.localization`. Requires `@atlasauth/embed` 0.5.0.


## 0.2.0

### Changed
- **`signOut()` now resolves a `SignOutResult`** (`{ revoked: boolean; activeSessionId?: string }`) instead of `void`, on
  `AtlasClient.signOut` and `useAuth().signOut`. Existing `await signOut()` / `signOut().then(…)` call sites keep working.
  `revoked: false` means the local sign-out happened but the Frontend API never confirmed the revoke (it is retried once,
  then in the background). Before the live client exists (SSR / first paint) `useAuth().signOut()` resolves `{ revoked: false }`.
- **Signed-out sessions are never re-adopted.** `signOut()` records the session id (a tombstone in `localStorage`, per
  Frontend API origin, shared by every tab) before revoking, and `reload()`, token refresh, `boot()` in a tab opened later,
  and a sibling tab all refuse that session even while the refresh cookie still returns it. A refused session's revoke is
  re-tried in the background and its tombstone cleared once the server confirms. Built on `SignOutGuard` from `@atlasauth/js`.
- `signOut()` revokes the cookie session even when no token is cached (it looks the session up with `GET /v1/client`).
- When another tab signs out of the current session, this tab signs out too (the tombstone reaches it via the `storage` event).
- `boot()` completes the OAuth popup flow when the page is running inside the sign-in popup: on a severed-popup landing
  (`#atlas_popup_result=…`) it relays the result to the opener and closes (the opener redeems the ticket), or — when no opener
  takes it — exchanges the ticket itself (or follows the continuation URL); after a sign-in completed inside the popup it
  wakes the opener and closes the popup.

### Added
- `signOut({ strict: true })` (`SignOutOptions.strict`) rejects with a `SignOutError` (`code: 'SIGN_OUT_REVOKE_FAILED'`,
  `sessionId`, `status`) when the revoke was not confirmed — after the local sign-out.
- A parked session the server promoted on revoke (`activeSessionId`) is adopted.
- The package entry re-exports `SignOutError` and the `SignOutOptions` / `SignOutResult` types from `@atlasauth/js`.
- Tests covering `<SignIn>` / `<SignUp>` (the `@atlasauth/embed` widget) when the instance cannot send email: the sign-up form
  is replaced by the "can't send email" notice and "Forgot password?" is hidden, following `email_delivery`.

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
