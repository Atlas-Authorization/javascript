# @atlasauth/nuxt changelog

## 0.1.4
- Depends on `@atlasauth/vue` 0.5.1: email-code sign-in works on instances without password sign-in.

## 0.1.3
- **`frontendApi` is validated at plugin start-up.** A missing (or non-string) or malformed value now throws an
  `AtlasConfigError` (from `@atlasauth/js`; `code: 'FRONTEND_API_REQUIRED'` or `'FRONTEND_API_INVALID'`)
  instead of silently sending requests to relative URLs on the app's own origin. Accepted: an absolute
  `https:` URL (`http:` only for localhost / local development hosts), or `"same-origin"` / a root-relative path such as `"/atlas"` for a reverse proxy.
  The error names the `atlas.frontendApi` option and `NUXT_PUBLIC_ATLAS_FRONTEND_API`.
- **Deprecated:** `frontendApi: ""` (the original same-origin spelling) still works as same-origin, with a
  one-time console warning; use `"same-origin"` instead. An unset `atlas.frontendApi` (runtimeConfig
  placeholder `""`) behaves the same way.

## 0.1.2
- **Docs fix.** Frontend API host examples use a single-label host (`your-instance-fapi.atlasauth.net`); the previous two-level `*.fapi.atlasauth.net` form fails TLS behind Cloudflare.

## 0.1.1
- First published release.
- **Nuxt 3 module.** Add `@atlasauth/nuxt` to `modules` and configure it under the `atlas` key (`publishableKey`, `frontendApi`, `jwksUrl`, `issuer`, `authorizedParties`). The publishable key and Frontend API URL go to public runtime config; `jwksUrl`, `issuer` and `authorizedParties` stay server-only. `NUXT_PUBLIC_ATLAS_*` / `NUXT_ATLAS_*` environment variables override them at runtime.
- **Client.** Installs the `@atlasauth/vue` plugin app-wide (also during SSR) and auto-imports its composables (`useAtlas`, `useUser`, `useSession`, `useAuth`, `useOrganization`, `useSignIn`, `useSignUp`, `useFlow`) and components (`SignedIn`, `SignedOut`, `AtlasLoading`, `AtlasLoaded`, `Protect`, `SignIn`, `SignUp`, `UserButton`, `OrganizationSwitcher`, `UserProfile`, `OrganizationProfile`).
- **Server.** A Nitro middleware verifies the session token (`Authorization` header, else the `__session` cookie) locally on every request and stores the result on `event.context.auth`. `getAtlasAuth(event)` is auto-imported into server routes and returns the verified auth state, including `protect()`.
- **Cross-domain sign-in.** `atlasHandshake(event)` sends a visitor without a local session through the Atlas handshake once and, on return, redeems the PKCE-bound nonce for a first-party session on your domain.
