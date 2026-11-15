# {{PROJECT_NAME}}

A minimal SvelteKit app pre-wired with [Atlas](https://atlasauth.net) auth, generated with `create-atlas-app`.

## What's wired

- `src/hooks.server.ts` — `handleAtlas()` verifies the session JWT locally on every request and
  stores it on `event.locals.auth`.
- `src/routes/+layout.svelte` — `<AtlasProvider>` with the publishable key.
- `src/routes/+page.svelte` — `<SignedIn>` / `<SignedOut>`, `<SignIn>` and `<UserButton>`.
- `src/routes/dashboard` — a route the server protects with `getServerAuth(event)`.

## Getting started

```sh
npm install
cp .env.example .env     # set your publishable key and instance URLs
npm run dev
```

Open http://localhost:5173, sign in, then visit `/dashboard`.
