# @atlas/nuxt

The official **Nuxt 3** module for [Atlas](https://atlasauth.net). A thin Nuxt
binding: the client half is [`@atlas/vue`](../vue) (the `createAtlas()` plugin,
its composables and components), the server half mirrors
[`@atlas/nextjs`](../nextjs) — it verifies the `__session` JWT **locally** with
`@atlas/backend` inside a Nitro middleware and exposes a `getAtlasAuth(event)`
helper to your server routes.

- **No secrets in the browser.** The client holds only the short-lived session
  JWT in memory. `jwksUrl` / `issuer` live in the **server-only**
  `runtimeConfig` and never reach the client bundle.
- **No round trip on the hot path.** Server verification is local against cached
  JWKS (§7.3) — the same engine every other Atlas SDK uses.

## Install

```bash
pnpm add @atlas/nuxt
```

## Configure

Add the module and set your instance config. Public values (`publishableKey`,
`frontendApi`) are safe in the client; the verification values go under the
server-only `runtimeConfig.atlas`.

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@atlas/nuxt'],

  atlas: {
    // Public — sent to the browser.
    publishableKey: 'pk_test_...',
    frontendApi: 'https://your-instance.fapi.atlasauth.net',
  },

  runtimeConfig: {
    // Server-only — used by the Nitro side to verify session JWTs.
    atlas: {
      jwksUrl: '',   // NUXT_ATLAS_JWKS_URL
      issuer: '',    // NUXT_ATLAS_ISSUER
      // authorizedParties: ['https://app.example.com'], // optional azp allowlist
    },
    public: {
      atlas: {
        publishableKey: '', // NUXT_PUBLIC_ATLAS_PUBLISHABLE_KEY
        frontendApi: '',    // NUXT_PUBLIC_ATLAS_FRONTEND_API
      },
    },
  },
})
```

In production, prefer environment variables (they override the config above):

```bash
NUXT_PUBLIC_ATLAS_PUBLISHABLE_KEY=pk_live_...
NUXT_PUBLIC_ATLAS_FRONTEND_API=https://your-instance.fapi.atlasauth.net
NUXT_ATLAS_JWKS_URL=https://your-instance.fapi.atlasauth.net/.well-known/jwks.json
NUXT_ATLAS_ISSUER=https://your-instance.fapi.atlasauth.net
```

## Use in pages and components

Every `@atlas/vue` composable and component is **auto-imported** — no `import`
line needed.

**Components** (`SignedIn`, `SignedOut`, `Protect`, `SignIn`, `SignUp`,
`UserButton`, `OrganizationSwitcher`, `UserProfile`, `OrganizationProfile`,
`AtlasLoading`, `AtlasLoaded`):

```vue
<template>
  <AtlasLoading><p>Loading…</p></AtlasLoading>

  <SignedIn>
    <UserButton />
    <Protect permission="org:billing:manage">
      <button>Manage billing</button>
      <template #fallback><p>Ask an admin.</p></template>
    </Protect>
  </SignedIn>

  <SignedOut>
    <SignIn />
  </SignedOut>
</template>
```

**Composables** (`useUser`, `useSession`, `useAuth`, `useOrganization`,
`useSignIn`, `useSignUp`, `useFlow`, `useAtlas`):

```vue
<script setup lang="ts">
const { isLoaded, isSignedIn, user } = useUser()
const { userId, getToken, has, signOut } = useAuth()

async function callApi() {
  const token = await getToken() // always fresh; refreshes if near expiry
  await $fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } })
}
</script>
```

> `<Protect>` and `has()` decide what a user **sees**, never what they may
> **do** — seeing is not doing. The server checking the same condition is what
> actually stops them. See the next section.

## Read auth in a server route

`getAtlasAuth(event)` is auto-imported into every Nitro handler. It returns the
verified state for the request (memoized — the global middleware already ran the
verify once).

```ts
// server/api/me.get.ts
export default defineEventHandler(async (event) => {
  const auth = await getAtlasAuth(event)

  if (!auth.isSignedIn) {
    return { signedIn: false }
  }

  return {
    signedIn: true,
    userId: auth.userId,
    orgId: auth.orgId,
    canManageBilling: auth.has({ permission: 'org:billing:manage' }),
  }
})
```

Use `protect()` to hard-stop a route. It throws an HTTP error Nitro maps to a
status: **401** for an anonymous caller, **403** when signed in but missing the
role/permission.

```ts
// server/api/billing.post.ts
export default defineEventHandler(async (event) => {
  const auth = await getAtlasAuth(event)
  auth.protect({ permission: 'org:billing:manage' }) // 401 / 403 as appropriate

  // ...only reached by an authorized caller
  return { ok: true }
})
```

The resolved state is also on `event.context.auth` for any handler or util that
prefers reading it directly.

### The `AtlasAuth` surface

| field / method                     | description                                                        |
| ---------------------------------- | ------------------------------------------------------------------ |
| `userId` / `sessionId`             | the `sub` / `sid` claims, or `null` when signed out                |
| `orgId` / `orgRole`                | the active organization and role, or `null`                        |
| `isSignedIn`                       | `true` once a valid token verified                                 |
| `claims`                           | the raw verified `SessionClaims`, or `null`                        |
| `has(condition?)`                  | boolean check — `permission` / `role` / `anyPermission` / `allPermissions` |
| `protect(condition?)`              | assert; throws 401 (signed out) / 403 (insufficient)               |

You can also `import { getAtlasAuth, verifyCarriers, atlasBackend } from '@atlas/nuxt/server'`
if you prefer explicit imports.

## How it fits together

| layer                | package        | what it does                                                             |
| -------------------- | -------------- | ----------------------------------------------------------------------- |
| client plugin        | `@atlas/vue`   | `createAtlas()` installed on the Nuxt Vue app (per request during SSR)   |
| composables / comps  | `@atlas/vue`   | auto-imported into pages/components                                      |
| Nitro middleware     | `@atlas/backend` | verifies `__session` once per request → `event.context.auth`          |
| `getAtlasAuth`       | `@atlas/backend` | the server-route auth helper (local verify, cached JWKS)              |

## Build & test

- **Build:** `pnpm build` (via `@nuxt/module-builder` — emits `dist/module.mjs`
  and the runtime under `dist/runtime`).
- **Typecheck:** `pnpm typecheck`.
- **Test:** `pnpm test` — a vitest suite (`src/runtime/server/auth.test.ts`)
  covering the Nitro verify helper end-to-end with a real RS256 keypair.

## License

MIT
