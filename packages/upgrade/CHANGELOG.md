# @atlasauth/upgrade changelog

## Unreleased

## 0.6.0 — 2026-10-26

### Changed

- `atlas-upgrade` migrates from more vendor SDKs (Appwrite added, with fixtures) and exposes a `migrate` codemod entry point.

## 0.5.0 — 2026-10-25

### Added

- `--from okta | kinde | descope`: codemods for okta-react / okta-auth-js / oidc-middleware / jwt-verifier / okta-sdk-nodejs, the Kinde Next.js and React SDKs, and the Descope React / Next.js / Node SDKs, onto native Atlas APIs and the new compat helpers.
- `--from auth0` also rewrites `express-oauth2-jwt-bearer` (`auth()` → `requireAccessToken()`) and `express-openid-connect` (`requiresAuth()` → `requireAuth()`), and reports the `auth0` Node SDK clients.
- `--from clerk` covers more of the Clerk SDKs (see the transform's header).
- `--from lucia | passport | iron-session`. Passport: `passport.initialize()` becomes `atlasMiddleware()` from `@atlasauth/express`, `passport.session()` is removed, `passport.authenticate('jwt' | 'bearer')` becomes `requireAuth()`, `req.isAuthenticated()` becomes `getAuth(req).isSignedIn` (CommonJS files get a `require`). iron-session: `getIronSession(cookies(), …)` that only reads `session.userId` becomes `auth()` from `@atlasauth/nextjs/server`. Lucia: each session, cookie, user and password call is marked with the Atlas call or page that replaces it. Strategies, adapters, sign-in/out calls and session stores are reported with file and line.
- `--from authjs`: `await getToken({ req })` from `next-auth/jwt` in App Router server code becomes `(await auth()).claims`; `@auth/*-adapter` imports are reported as database adapters.

## 0.4.0 — 2026-10-24

### Added

- `--from openid-client | jose | generic-oidc`: finds hand-rolled OpenID Connect flows, adds the `oidc` import and marks each step with the `oidc.*` call that replaces it.

## 0.3.0 — 2026-10-24

### Added

- `analyzeBetterAuth(path, { entry })`: finds each `betterAuth({...})` call and reads its options statically. It follows imports, tsconfig path aliases, re-exports and spreads, folds constant arithmetic, records env vars by name only, and reads access-control roles (including Better Auth's default statements). Anything it cannot read is kept as a typed placeholder with its file and line.

## 0.2.0 — 2026-10-24

### Added

- `--from authjs | supabase | auth0 | better-auth` codemods (also behind `atlas migrate code`): rewrite imports, providers, hooks, server session helpers, middleware, sign-in/sign-out calls, auth URLs and env var names onto Atlas and the compat helpers in `@atlasauth/react/compat` / `@atlasauth/nextjs/compat`. Anything that cannot be rewritten safely is left in place with a `TODO(atlas-migrate):` comment and listed with file and line, along with `.env` keys and the packages to add and remove. Idempotent.
- auth0-spa-js usage is rewritten onto `@atlasauth/js/compat` (`createAuth0Client` / `new Auth0Client`, option names, types and `GenericError`); custom token exchange, DPoP helpers and API `audience` are reported.
- `runMigration(path, { from, write })`, `formatMigration()`, `resolveVendor()`, `detectEnvStyle()` and the per-vendor transforms for programmatic use.

## 0.1.0

First published release.

### Added
- `atlas-upgrade` CLI with `--dry` (print a diff, write nothing) and `--yes` (apply) modes.
- Clerk-to-Atlas codemod: rewrites `@clerk/*` imports, renamed components, hooks and middleware, and `CLERK_*` environment variables to their Atlas equivalents; unmapped cases are marked with a `TODO(atlas-upgrade):` comment.
- Version bump: updates `@atlasauth/*` dependency ranges in `package.json` (`bumpAtlasDeps()`).
- Programmatic API: `runClerkToAtlas()`, `clerkToAtlas` transform, `unifiedDiff()`, `main()` / `parseCliArgs()`, and the `PACKAGE_MAP` / `IDENTIFIER_MAP` mappings.
