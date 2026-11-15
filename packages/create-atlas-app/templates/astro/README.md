# {{PROJECT_NAME}}

A minimal Astro (server output) app pre-wired with [Atlas](https://atlasauth.net) auth, generated with `create-atlas-app`.

## What's wired

- `src/middleware.ts` — `atlasMiddleware()` verifies the session JWT locally on every request and sets
  `Astro.locals.atlas`.
- `src/pages/index.astro` — shows the signed-in state; `src/pages/dashboard.astro` redirects when signed out.
- `src/pages/api/me.ts` — an endpoint that answers 401 to an anonymous caller.

The Astro adapter is server-side: it verifies sessions. Sign people in with Atlas's hosted sign-in, or mount
`@atlasauth/js` / a framework island on a page, and point `ATLAS_SIGN_IN_URL` at it.

## Getting started

```sh
npm install
cp .env.example .env     # set the instance URLs
npm run dev
```
