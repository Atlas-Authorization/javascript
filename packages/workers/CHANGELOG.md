# @atlasauth/workers changelog

## 0.1.0

- First release: `createAtlas` for Cloudflare Workers, Deno, Bun and any runtime that speaks Web `Request` / `Response`. Verifies the session locally against cached JWKS, `requireAuth` / `withAuth` with permission, role, plan and feature conditions, `rateLimit` and `grantUsage` gates, `requireAccessToken` for OAuth-protected APIs, and a signed-webhook receiver.
