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
| `-t, --template`    | Template to use: `next` or `react-vite` (default `next`).       |
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

Each generated project is standalone — it depends on the published
`@atlasauth/*` packages (not workspace versions) and ships a `.env.example` with
a placeholder publishable key.
