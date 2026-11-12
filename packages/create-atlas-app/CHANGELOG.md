# @atlasauth/create-atlas-app changelog

## 0.4.1 — 2026-11-12

- The templates pin the current SDKs (`@atlasauth/react` ^0.34.0, `@atlasauth/nextjs` ^0.15.0, `@atlasauth/backend` ^0.45.0) and Vite 6.4; new projects no longer start on months-old SDKs.

## 0.4.0

- New `nextjs-local-users` template: a Next.js app with its own users and organizations on a path mount (session check with CSRF, local user sync, webhooks, the `before_user_create` hook, organization mirror and policy, Admin Portal link, integration token). `create-atlas-app --template nextjs-local-users`.

## 0.3.0 — 2026-10-23

- New apps start on the current SDKs: `@atlasauth/react` ^0.14.0 and `@atlasauth/nextjs` ^0.4.0 (the templates pinned 0.1.x).

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
