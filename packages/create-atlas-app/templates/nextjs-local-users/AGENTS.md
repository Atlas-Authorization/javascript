# AGENTS.md — Atlas (Next.js, local users and organizations)

This app keeps its own users and organizations and uses **[Atlas](https://atlasauth.net)** for sign-in.

- Atlas is mounted under `/atlas` (`app/atlas/[[...path]]/route.ts`); sessions are verified in `middleware.ts`.
- `lib/local-user.ts` maps the Atlas `sub` to your own row with `syncLocalUser`. Link by email only when both sides proved it.
- `app/api/atlas/*` receive webhooks and the `before_user_create` hook; both verify the signature and dedupe.
- `app/api/orgs` mirrors your organizations into Atlas; `app/api/admin-portal` and `app/api/chat-token` use the Backend API with `ATLAS_SECRET_KEY` (server only).
- Replace `lib/store.ts` (in memory) with your database and keep a unique index on the Atlas sub.
- Order of operations with a check for each step: https://atlasauth.net/docs/nextjs-local-users-and-orgs
