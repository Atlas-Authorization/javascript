# @atlasauth/create-atlas-app changelog

## 0.2.0

### Added
- Every scaffolded app (both `next` and `react-vite` templates) now includes an `AGENTS.md` describing the app's Atlas setup and how to extend it, for use with AI coding agents.

## 0.1.0

First published release.

### Added
- `create-atlas-app [dir]` scaffolder, invoked as `npm create @atlasauth/atlas-app`, with options `--template`, `--pm`, `--yes`, `--force`, `--help` and `--version`.
- `next` template: Next.js App Router with `@atlasauth/nextjs` middleware and server `auth()`, `@atlasauth/react` provider and components, a public home page, a sign-in route and a protected dashboard.
- `react-vite` template: Vite + React with `@atlasauth/react`, `<SignIn>` and a signed-in user display.
- Generated projects depend on the published `@atlasauth/*` packages and include a `.env.example` with a placeholder publishable key; the CLI prints install steps rather than running them.
- Interactive template prompt on a TTY, and an animated Atlas banner on start.
