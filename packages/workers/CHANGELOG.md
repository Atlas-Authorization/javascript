# @atlasauth/workers changelog

## 0.2.0

- The auth state from `authenticate()` gains `status` (`signed_in`, `signed_out`, `session_expired`, `token_invalid`) and `reason`. `session_expired` means the short-lived session token lapsed but the refresh cookie or sign-in hint is present: renew, do not sign out. `requireAuth` and `withAuth` set `x-atlas-auth-status` on their 401. Needs `@atlasauth/backend` 0.62.0.

## 0.1.0

- First release: `createAtlas` for Cloudflare Workers, Deno, Bun and any runtime that speaks Web `Request` / `Response`. Verifies the session locally against cached JWKS, `requireAuth` / `withAuth` with permission, role, plan and feature conditions, `rateLimit` and `grantUsage` gates, `requireAccessToken` for OAuth-protected APIs, and a signed-webhook receiver.
