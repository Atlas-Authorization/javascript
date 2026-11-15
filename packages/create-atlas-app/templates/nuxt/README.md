# {{PROJECT_NAME}}

A minimal Nuxt 3 app pre-wired with [Atlas](https://atlasauth.net) auth, generated with `create-atlas-app`.

## What's wired

- `nuxt.config.ts` — the `@atlasauth/nuxt` module and its config. Verification values live in the
  server-only `runtimeConfig.atlas`; only the publishable key and Frontend API reach the browser.
- `app.vue` — `<SignedIn>` / `<SignedOut>`, `<SignIn>` and `<UserButton>` (all auto-imported).
- `server/api/me.get.ts` — a protected Nitro route using `getAtlasAuth(event).protect()`.

## Getting started

```sh
npm install
cp .env.example .env     # set your publishable key and instance URLs
npm run dev
```

Open http://localhost:3000, sign in, then call `/api/me`.
