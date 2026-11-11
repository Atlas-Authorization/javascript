# {{PROJECT_NAME}}

A Next.js app with its own users and organizations on top of Atlas: path mount, session verification, CSRF, a mirrored local user, webhooks, the `before_user_create` hook, an organization mirror with policy, an Admin Portal link and an integration token.

```sh
cp .env.example .env.local   # fill it in, step by step
npm install
npm run dev
```

Follow [the order of operations](https://atlasauth.net/docs/nextjs-local-users-and-orgs); each step has a command that proves it worked. For local development use `atlas dev proxy` against your development instance (see the path mount guide).

| Step | File |
|---|---|
| 1-2 Path mount and verification file | `app/atlas/[[...path]]/route.ts`, `app/.well-known/atlas-verify/[token]/route.ts` |
| 4 Session check and CSRF | `middleware.ts` |
| 5 Local user | `lib/local-user.ts` |
| 6 `before_user_create` hook | `app/api/atlas/hooks/before-user-create/route.ts` |
| 7 Webhooks | `app/api/atlas/webhooks/route.ts` |
| 8 Organization mirror and policy | `app/api/orgs/route.ts` |
| 9 Admin Portal link | `app/api/admin-portal/route.ts` |
| 10 Integration token | `app/api/chat-token/route.ts` |

`lib/store.ts` keeps users and organizations in memory so the example runs as is: swap it for your database.
