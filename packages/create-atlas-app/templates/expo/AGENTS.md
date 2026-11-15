# AGENTS.md — Atlas (Expo)

Instructions for AI coding agents working in this project. (Humans: see `README.md`.)
This app uses **[Atlas](https://atlasauth.net)** for authentication.

## What's already wired

- **`@atlasauth/expo`** — `<AtlasProvider>` with a secure-store token cache; the same hooks as the web SDK (`useAuth`, `useUser`, `<SignedIn>`, `<SignedOut>`).
- **Sign-in**: `components/SignInForm.tsx` drives `createSignInFlow` from `@atlasauth/js`.
- **Env** (`.env`): `EXPO_PUBLIC_ATLAS_PUBLISHABLE_KEY`, `EXPO_PUBLIC_ATLAS_FRONTEND_API`, `EXPO_PUBLIC_API_URL`.

## How to work in this app

- **This is a mobile app**: it only ever uses the **publishable** key. An `EXPO_PUBLIC_` variable is shipped inside the app, so never put a secret there.
- **Call your backend** with `await getToken()` as `Authorization: Bearer …`; the backend verifies it.
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
