# AGENTS.md — Atlas (Next.js)

Instructions for AI coding agents working in this project. (Humans: see `README.md`.)
This app uses **[Atlas](https://atlasauth.net)** for authentication. 30+ agents read
this file natively (OpenAI Codex, GitHub Copilot, Cursor, Gemini CLI, Windsurf, Zed,
Aider, Claude Code via import, …).

## What's already wired

- **`@atlasauth/nextjs`** — `atlasMiddleware` in `middleware.ts` guards routes and
  attaches the session.
- **`@atlasauth/react`** — `<AtlasProvider>` wraps the app; `<SignedIn>` / `<SignedOut>`,
  `<SignInButton>`, and `<UserButton>` render auth UI.
- **Env** (`.env.local`): `NEXT_PUBLIC_ATLAS_PUBLISHABLE_KEY` (`pk_…`),
  `NEXT_PUBLIC_ATLAS_FRONTEND_API`, and server-only `ATLAS_SECRET_KEY` (`sk_…`),
  `ATLAS_JWKS_URL`, `ATLAS_ISSUER`. Never ship `sk_…` to the client.

## How to work in this app

- **Protect a route / read the user**: use the `@atlasauth/nextjs` server helpers
  (`auth()` / the middleware-provided session) in server components & route handlers;
  use `@atlasauth/react` hooks/components in client components. Don't hand-roll JWT
  parsing — verify via the SDK against the FAPI JWKS (`ATLAS_JWKS_URL`).
- **Call your own API**: get a token with the client SDK and send it as
  `Authorization: Bearer …`; verify it server-side with `@atlasauth/backend`.
- **Secrets**: `sk_…` only in server code / server env; publishable `pk_…` is the
  only key that may reach the browser.

## Going further (orgs, SSO/SCIM, FGA, M2M, migration)

Full, harness-agnostic Atlas integration rules:
<https://github.com/Atlas-Authorization/atlas-ai-rules> (also install the Claude
Code plugin: `/plugin marketplace add Atlas-Authorization/atlas-claude-skills`).

- **Docs for AI tools**: <https://atlasauth.net/llms.txt> (index) · <https://atlasauth.net/llms-full.txt> (full).
- **MCP server** (query/manage your instance from any MCP client): `npx -y @atlasauth/mcp` with `ATLAS_SECRET_KEY`.
- **API reference**: <https://api.atlasauth.net/v1/openapi.json>.
