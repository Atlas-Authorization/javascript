# {{PROJECT_NAME}}

A minimal [Hono](https://hono.dev) API pre-wired with [Atlas](https://atlasauth.net) auth, generated with `create-atlas-app`.
It runs on Node here; the same code runs on Cloudflare Workers, Deno and Bun.

## What's wired

- `src/index.ts` — `atlasMiddleware()` verifies the session token locally, and `/me` is a protected route.

## Getting started

```sh
npm install
cp .env.example .env     # set the instance URLs
npm run dev
```

Call it with a session token from your client: `curl -H "Authorization: Bearer $TOKEN" localhost:3000/me`.
