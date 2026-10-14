# @atlasauth/upgrade

CLI codemods for Atlas, the way `@clerk/upgrade` is for Clerk. It helps you:

1. **Migrate a Clerk codebase to Atlas** — rewrite `@clerk/*` imports, renamed
   components/hooks/middleware, and `CLERK_*` env vars to their Atlas peers.
2. **Move across Atlas SDK versions** — bump `@atlasauth/*` dependency ranges in
   a project's `package.json`.

It is built on [jscodeshift](https://github.com/facebook/jscodeshift) and ships a
single `atlas-upgrade` binary. It is deliberately dependency-light (jscodeshift
plus Node's built-in `util.parseArgs`).

## Usage

```sh
# Migrate a Clerk project (dry run first — prints a diff, writes nothing)
npx atlas-upgrade ./src --dry
npx atlas-upgrade ./src --yes           # apply

# Bump Atlas SDK versions in ./package.json
npx atlas-upgrade . --transform version-bump --to 0.2.0 --yes
```

| Flag | Meaning |
| --- | --- |
| `[path]` | Target file or directory (default: cwd). |
| `--from clerk` | Source SDK (only `clerk` today). |
| `--transform <name>` | `clerk-to-atlas` (default) or `version-bump`. |
| `--to <version>` | Target version for `version-bump` (default `latest`). |
| `--dry` | Print a diff and write nothing. |
| `--yes` | Apply without prompting / without a TTY. |

**Safety:** with no TTY and no `--yes`, the tool runs a no-write dry run, so it is
safe to drop into scripts and CI. Source files under `node_modules`, `dist`,
`.git`, `build`, `coverage`, `.next`, `out` and `.turbo` are never scanned.

## What `clerk-to-atlas` rewrites

- **Packages:** `@clerk/clerk-react` → `@atlasauth/react`, `@clerk/nextjs` →
  `@atlasauth/nextjs`, `@clerk/backend` → `@atlasauth/backend`, and the rest of
  the `@clerk/*` scope → `@atlasauth/*` (plus `gatsby-plugin-clerk` →
  `gatsby-plugin-atlasauth`).
- **Renamed symbols:** `ClerkProvider` → `AtlasProvider`, `useClerk` →
  `useAtlas`, `clerkMiddleware` → `atlasMiddleware`, `ClerkLoaded`/`ClerkLoading`
  → `AtlasLoaded`/`AtlasLoading` (import and every reference, JSX included).
- **Env vars:** `process.env.CLERK_*` / `import.meta.env.CLERK_*` → `ATLAS_*`,
  and `NEXT_PUBLIC_CLERK_*` → `NEXT_PUBLIC_ATLAS_*`.

Clerk's shared surface (`SignedIn`, `useUser`, `UserButton`, …) has the same name
on Atlas and flows through untouched. Anything imported from Clerk with **no
confirmed 1:1 Atlas equivalent is left in place with a `// TODO(atlas-upgrade)`
marker** rather than renamed to a guess — search for `TODO(atlas-upgrade)` after
a run to find what needs a human.

## Programmatic use

Every piece is exported for embedding or testing:

```ts
import { clerkToAtlas, bumpAtlasDeps, runClerkToAtlas } from '@atlasauth/upgrade';
```
