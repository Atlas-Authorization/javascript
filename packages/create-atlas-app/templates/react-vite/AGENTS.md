# AGENTS.md — Atlas (React + Vite)

Instructions for AI coding agents working in this project. (Humans: see `README.md`.)
This app uses **[Atlas](https://atlasauth.net)** for authentication. 30+ agents read
this file natively (OpenAI Codex, GitHub Copilot, Cursor, Gemini CLI, Windsurf, Zed,
Aider, Claude Code via import, …).

## What's already wired

- **`@atlasauth/react`** — `<AtlasProvider>` wraps the app; use `<SignedIn>` /
  `<SignedOut>`, `<SignInButton>`, `<UserButton>`, and the `useUser` / `useSession`
  hooks for auth state and UI.
- **Env** (`.env`): `VITE_ATLAS_PUBLISHABLE_KEY` (`pk_…`) and `VITE_ATLAS_FRONTEND_API`.
  This is a browser SPA — it only ever uses the **publishable** key; a secret `sk_…`
  key must NEVER appear in this app.

## How to work in this app

- **Auth state / UI**: `useUser()` / `useSession()` and the `<SignedIn>` / `<SignedOut>`
  components. Gate UI on them rather than checking tokens by hand.
- **Call your backend**: get a session token via the client SDK (`getToken()`), send it
  as `Authorization: Bearer …`, and verify it **on your server** with `@atlasauth/backend`
  (or the SDK for your backend language) against the FAPI JWKS — never verify or trust
  tokens in the browser.

## Going further (orgs, SSO/SCIM, FGA, M2M, migration)

Full, harness-agnostic Atlas integration rules:
<https://github.com/Atlas-Authorization/atlas-ai-rules> (also install the Claude
Code plugin: `/plugin marketplace add Atlas-Authorization/atlas-claude-skills`).

- **Docs for AI tools**: <https://atlasauth.net/llms.txt> (index) · <https://atlasauth.net/llms-full.txt> (full).
- **MCP server**: `npx -y @atlasauth/mcp` with `ATLAS_SECRET_KEY` (server-side only).
- **API reference**: <https://api.atlasauth.net/v1/openapi.json>.
