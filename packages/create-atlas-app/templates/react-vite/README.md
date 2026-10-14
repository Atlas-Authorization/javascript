# {{PROJECT_NAME}}

A minimal Vite + React app pre-wired with [Atlas](https://atlasauth.net) auth,
generated with `create-atlas-app`.

## What's wired

- `src/main.tsx` — the app wrapped in `<AtlasProvider>` (from `@atlasauth/react`),
  configured from your `VITE_ATLAS_*` environment variables.
- `src/App.tsx` — `<SignedOut>` renders the `<SignIn>` flow; `<SignedIn>` shows
  the current user (via `useUser`) and a `<UserButton>`.

## Getting started

1. Install dependencies:

   ```sh
   npm install
   ```

2. Copy the environment template and set your Atlas keys:

   ```sh
   cp .env.example .env
   ```

   Set `VITE_ATLAS_PUBLISHABLE_KEY` to your instance's publishable key (the
   scaffolder leaves a placeholder, `pk_test_xxx`) and adjust
   `VITE_ATLAS_FRONTEND_API` for your instance.

3. Run the dev server:

   ```sh
   npm run dev
   ```

Open the URL Vite prints (defaults to http://localhost:5173).
