# create-atlas-app

Scaffold a starter app pre-wired with [Atlas](https://atlasauth.net) auth.

```sh
npm create atlas-app@latest
# or
npx create-atlas-app my-app --template react-vite
```

## Usage

```
create-atlas-app [dir] [options]
```

| Option              | Description                                                     |
| ------------------- | --------------------------------------------------------------- |
| `-t, --template`    | `next`, `react-vite`, `nextjs-local-users`, `nuxt`, `sveltekit`, `astro`, `expo`, `hono` or `express` (default `next`). |
| `--pm`              | Package manager for the printed steps: `npm`, `pnpm`, `yarn`.   |
| `-y, --yes`         | Skip prompts and accept defaults (template defaults to `next`). |
| `--force`           | Scaffold into a non-empty directory.                            |
| `-h, --help`        | Show help.                                                      |
| `--version`         | Print the version.                                              |

If `dir` is omitted it defaults to `my-atlas-app`. When `--template` is omitted
and stdin is a TTY, you'll be prompted; otherwise (or with `--yes`) it defaults
to `next`. The CLI never runs `install` for you — it prints the commands to run.

## Templates

- **next** — Next.js (App Router) with `@atlasauth/nextjs` (edge middleware +
  the server `auth()` helper) and `@atlasauth/react` (`<AtlasProvider>`,
  `<SignIn>`, `<UserButton>`): a public home page, a hosted sign-in route, and a
  protected dashboard.
- **react-vite** — Vite + React with `@atlasauth/react`: `<AtlasProvider>`,
  `<SignIn>`, and a signed-in user display via `useUser`.

- **nuxt** — Nuxt 3 with `@atlasauth/nuxt`: auto-imported components and composables, a Nitro
  middleware that verifies the session locally, and a protected server route.
- **sveltekit** — SvelteKit with `@atlasauth/svelte`: `handleAtlas()` in `hooks.server.ts`, the
  provider and components, and a server-protected route.
- **astro** — Astro (server output) with `@atlasauth/astro`: `atlasMiddleware()`, a protected page
  and a protected endpoint.
- **expo** — Expo Router with `@atlasauth/expo`: a secure-store token cache, the provider, a
  headless email and password sign-in and a call to your own API with the session token.
- **hono** — a Hono API with `@atlasauth/hono`: local session verification and a protected route
  (Node here; the same code runs on Workers, Deno and Bun).
- **express** — an Express API with `@atlasauth/express`: `atlasMiddleware()` and `requireAuth()`.

Pair any of them with `@atlasauth/eslint-plugin`: it flags a leaked secret key, a webhook route
that never verifies its signature, a `decodeJwt` that is trusted as verification, and a secret
placed in a browser-visible environment variable.

Each generated project is standalone — it depends on the published
`@atlasauth/*` packages (not workspace versions) and ships a `.env.example` with
a placeholder publishable key.
