# @atlasauth/upgrade

CLI codemods for Atlas, the way `@clerk/upgrade` is for Clerk. It helps you:

1. **Migrate a codebase to Atlas** from Clerk, Auth.js (NextAuth), Supabase
   Auth, Auth0 or Better Auth — rewrite imports, providers, hooks, server
   helpers, middleware, sign-in/out calls and env vars to their Atlas peers (the
   same engine runs behind `atlas migrate code`).
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

# Migrate from another provider (prints the diff and a file:line report)
npx atlas-upgrade . --from authjs --dry
npx atlas-upgrade . --from supabase --yes

# Bump Atlas SDK versions in ./package.json
npx atlas-upgrade . --transform version-bump --to 0.2.0 --yes
```

| Flag | Meaning |
| --- | --- |
| `[path]` | Target file or directory (default: cwd). |
| `--from <vendor>` | `clerk` (default), `authjs`, `supabase`, `auth0`, `better-auth`, `openid-client`, `jose`, `generic-oidc`, `lucia`, `passport` or `iron-session`. |
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

## Other providers (`--from authjs | supabase | auth0 | better-auth`)

Each vendor codemod rewrites every reference to a vendor export onto its Atlas
target one call site at a time: native Atlas APIs where the shapes match, and
otherwise the compat helpers in `@atlasauth/react/compat` (browser) and
`@atlasauth/nextjs/compat` (server) that keep the vendor's shape
(`{ data, status }` from `useSession`, `{ data: { user }, error }` from
`supabase.auth.getUser()`, …). A call shape a target cannot serve (a Pages-router
`getServerSession(req, res)`, `supabase.auth.signInWithPassword`, a provider
config object) stays on the vendor import, gets a
`// TODO(atlas-migrate):` marker, and is listed in the report with its file and
line, together with vendor keys in `.env*` files, the Atlas packages to install
and the vendor packages to remove. Running it again changes nothing. See the
fixtures under `src/vendors/__fixtures__/` for exact before/after examples.

### Self-hosted session libraries (`--from lucia | passport | iron-session`)

These libraries keep users and sessions in your own app, so the codemods move the
session *reads* onto Atlas and report the rest:

- **Passport** (Express): `app.use(passport.initialize())` becomes
  `app.use(atlasMiddleware({ jwksUrl, issuer }))` from `@atlasauth/express` and
  `app.use(passport.session())` is removed; `passport.authenticate('jwt' | 'bearer')`
  route middleware becomes `requireAuth({ jwksUrl, issuer })`;
  `req.isAuthenticated()` becomes `getAuth(req).isSignedIn`. Strategies
  (`passport-local`, Google, GitHub, SAML, OAuth 2.0, …), login and callback
  routes, `serializeUser` / `deserializeUser`, `req.user`, `req.login()` /
  `req.logout()` and `express-session` with its store are reported with the
  dashboard setting or Atlas call that replaces them. CommonJS files get a
  `require('@atlasauth/express')` instead of an import.
- **iron-session**: `const session = await getIronSession(cookies(), options)`
  whose only use is reading `session.userId` becomes `await auth()` from
  `@atlasauth/nextjs/server`. Sessions that are written, saved or destroyed, the v6
  wrappers and `req.session` are reported; `sealData` / `unsealData` stay.
- **Lucia** (v2 and v3): no Lucia call has an Atlas peer with the same shape, so
  each one (`validateSession`, `handleRequest().validate()`, session cookies,
  `invalidateSession`, `new Lucia(…)`, adapters, `arctic` OAuth, password hashing
  with `oslo/password` / `@node-rs/argon2`) is marked with the exact replacement
  (`auth()` / `currentUser()`, `getAuth(req)`, `AtlasBackend#authenticateRequest()`,
  the sessions API, the Atlas sign-in pages).

Users for these three live in your database; export them separately before
importing them into Atlas.

## Programmatic use

Every piece is exported for embedding or testing:

```ts
import { clerkToAtlas, bumpAtlasDeps, runClerkToAtlas } from '@atlasauth/upgrade';
```
