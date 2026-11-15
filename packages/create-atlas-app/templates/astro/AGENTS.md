# AGENTS.md — Atlas (Astro)

Instructions for AI coding agents working in this project. (Humans: see `README.md`.)
This app uses **[Atlas](https://atlasauth.net)** for authentication.

## What's already wired

- **`@atlasauth/astro`** — `atlasMiddleware()` in `src/middleware.ts` verifies the session JWT locally and fails closed; read it with `getAuth(Astro)` in pages and `getAuth(context)` in endpoints.
- **Env** (`.env`): `ATLAS_JWKS_URL`, `ATLAS_ISSUER` (server only) and `ATLAS_SIGN_IN_URL`.

## How to work in this app

- **Protect a page or endpoint**: `getAuth(Astro).isSignedIn` and redirect or return 401 on the server.
- The adapter verifies sessions; it does not render a sign-in form.
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
