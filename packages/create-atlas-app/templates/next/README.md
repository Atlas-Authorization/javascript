# {{PROJECT_NAME}}

A minimal Next.js (App Router) app pre-wired with [Atlas](https://atlasauth.net)
auth, generated with `create-atlas-app`.

## What's wired

- `middleware.ts` — Atlas edge middleware verifying the session JWT and
  protecting every route except `/` and `/sign-in` (via `@atlasauth/nextjs`).
- `app/providers.tsx` — the client-side `<AtlasProvider>` (from
  `@atlasauth/react`), mounted in `app/layout.tsx`.
- `app/page.tsx` — a public home page with `<SignedIn>` / `<SignedOut>` and a
  `<UserButton>`.
- `app/sign-in/page.tsx` — the hosted `<SignIn>` flow.
- `app/dashboard/page.tsx` — a protected server component using the pre-bound
  `auth()` / `currentUser()` helpers from `@atlasauth/nextjs/server`.

## Getting started

1. Install dependencies:

   ```sh
   npm install
   ```

2. Copy the environment template and set your Atlas keys:

   ```sh
   cp .env.example .env.local
   ```

   Set `NEXT_PUBLIC_ATLAS_PUBLISHABLE_KEY` to your instance's publishable key
   (the scaffolder leaves a placeholder, `pk_test_xxx`). Adjust
   `NEXT_PUBLIC_ATLAS_FRONTEND_API`, `ATLAS_JWKS_URL`, and `ATLAS_ISSUER` for
   your instance.

3. Run the dev server:

   ```sh
   npm run dev
   ```

Open http://localhost:3000. Visit `/dashboard` to see route protection in
action.
