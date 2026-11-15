# AGENTS.md — Atlas (Hono)

Instructions for AI coding agents working in this project. (Humans: see `README.md`.)
This app uses **[Atlas](https://atlasauth.net)** for authentication.

## What's already wired

- **`@atlasauth/hono`** — `atlasMiddleware()` verifies the session JWT locally; `getAuth(c)` returns `userId`, `orgId` and `has()` / `protect()`.
- **Env** (`.env`): `ATLAS_JWKS_URL`, `ATLAS_ISSUER`.

## How to work in this app

- **Protect a route**: `const auth = getAuth(c); if (!auth.isSignedIn) return c.json({ error: 'unauthenticated' }, 401)`; use `auth.has({ permission: '…' })` for 403.
- **OAuth access tokens for your API**: `requireAccessToken(options)` from `@atlasauth/hono`.
- **Secrets**: the publishable key (`pk_…`) is safe in client code. A secret key (`sk_…`)
  belongs only in server-side environment variables and must never be shipped to a browser
  or a mobile app, or committed.
- **Verify on the server**: a signed-in screen or `has()` check decides what a user *sees*;
  the server checking the same condition is what stops them *doing* it.

## Going further (orgs, SSO/SCIM, FGA, M2M, migration)

Full, harness-agnostic Atlas integration rules:
<https://github.com/Atlas-Authorization/atlas-ai-rules> (also install the Claude
Code plugin: `/plugin marketplace add Atlas-Authorization/atlas-claude-skills`).

- **Docs for AI tools**: <https://atlasauth.net/llms.txt> (index) · <https://atlasauth.net/llms-full.txt> (full).
- **MCP server**: `npx -y @atlasauth/mcp` with `ATLAS_SECRET_KEY` (server-side only).
- **API reference**: <https://api.atlasauth.net/v1/openapi.json>.
- **Lint**: `@atlasauth/eslint-plugin` flags a leaked secret key, an unverified webhook route,
  an unverified `decodeJwt` and a secret in a public env variable.
