# {{PROJECT_NAME}}

A minimal [Express](https://expressjs.com) API pre-wired with [Atlas](https://atlasauth.net) auth, generated with `create-atlas-app`.

## What's wired

- `src/index.ts` — `atlasMiddleware()` verifies the session token locally, and `/me` is a protected route.

## Getting started

```sh
npm install
cp .env.example .env     # set the instance URLs
npm run dev
```

Call it with a session token from your client: `curl -H "Authorization: Bearer $TOKEN" localhost:3000/me`.
Load `.env` with your process manager, `node --env-file=.env`, or `dotenv`.
