# @atlas/vue

The official Atlas SDK for Vue 3 — the framework peer of
[`@atlas/react`](../react). It reuses the framework-agnostic
[`@atlas/js`](../js) client for every API call and the shared
[`@atlas/authz`](../authz) primitive for permission checks, and mirrors the web
surface as idiomatic Vue Composition API: a plugin, `Ref`/`computed`-based
composables, and components that render in your host DOM (no iframe, so
Tailwind/CSS just works).

Like `@atlas/js`'s web binding, the session lives in an **HttpOnly cookie** the
browser sends automatically; the short-lived JWT is held only in memory for the
life of the tab. Nothing is written to `localStorage`.

## Install

```sh
npm install @atlas/vue
# peer you already have in a Vue 3 app:
#   vue >= 3.3
```

## Plugin

Install the plugin once, at app creation. It boots the session, completes any
OAuth/hosted-page redirect, schedules proactive token refresh, and paints your
appearance tokens onto the document root as CSS variables.

```ts
import { createApp } from 'vue';
import { createAtlas } from '@atlas/vue';
import App from './App.vue';

createApp(App)
  .use(
    createAtlas({
      publishableKey: 'pk_live_…',
      // frontendApi: 'https://your-instance.atlas.dev', // optional FAPI origin
      // appearance: { baseTheme: 'dark', elements: { formButtonPrimary: 'rounded-xl' } },
      // localization: myCatalog,
    }),
  )
  .mount('#app');
```

## Composables

Every composable returns `isLoaded` alongside its data so you can tell "still
booting" from "signed out" and avoid a flash of the sign-in form. Returned
state is reactive (`Ref` / `computed`).

```vue
<script setup lang="ts">
import { useUser, useAuth, useSession, useOrganization } from '@atlas/vue';

const { isLoaded, isSignedIn, user } = useUser();
const { userId, orgRole, getToken, signOut, has } = useAuth();
const { session } = useSession();
const { organization, memberships, setActive } = useOrganization();

async function callApi() {
  const token = await getToken(); // always fresh; refreshes if near expiry
  // fetch('/api', { headers: { Authorization: `Bearer ${token}` } })
}

// A live token at a connected social provider (Google, GitHub, …):
const { getProviderToken } = useUser();
async function callGoogle() {
  const token = await getProviderToken('google'); // null if no linked account
}

// `has()` mirrors <Protect>, for logic that is not a render decision:
const canManage = has({ permission: 'org:billing:manage' });
</script>
```

| Composable          | React peer        |
| ------------------- | ----------------- |
| `useAtlas()`        | `useAtlas()`      |
| `useUser()`         | `useUser()`       |
| `useSession()`      | `useSession()`    |
| `useAuth()`         | `useAuth()`       |
| `useOrganization()` | `useOrganization()` |
| `useSignIn()`       | internal `useFlow` |
| `useSignUp()`       | internal `useFlow` |

## Components

Drop-in components for the common flows. `<SignIn>` and `<SignUp>` are full
multi-step flows driven entirely by the server-side attempt status — the client
never decides what step comes next.

```vue
<script setup lang="ts">
import {
  SignedIn,
  SignedOut,
  Protect,
  SignIn,
  UserButton,
} from '@atlas/vue';
</script>

<template>
  <SignedOut>
    <SignIn />
  </SignedOut>

  <SignedIn>
    <UserButton />
    <Protect permission="org:billing:manage">
      <button>Manage billing</button>
      <template #fallback>
        <p>You don't have access.</p>
      </template>
    </Protect>
  </SignedIn>
</template>
```

| Component               | React peer              |
| ----------------------- | ----------------------- |
| `<SignedIn>`            | `<SignedIn>`            |
| `<SignedOut>`           | `<SignedOut>`           |
| `<AtlasLoading>`        | `<AtlasLoading>`        |
| `<AtlasLoaded>`         | `<AtlasLoaded>`         |
| `<Protect>`             | `<Protect>`             |
| `<SignIn>`              | `<SignIn>`              |
| `<SignUp>`              | `<SignUp>`              |
| `<UserButton>`          | `<UserButton>`          |
| `<UserProfile>`         | `<UserProfile>`         |
| `<OrganizationSwitcher>`| `<OrganizationSwitcher>`|
| `<OrganizationProfile>` | `<OrganizationProfile>` |

`<Protect>` is a **rendering** helper, never an authorization boundary. It
decides what a user *sees*; the server checking the same permission on the
request is what actually stops them acting.

## Theming

The `appearance` option mirrors `@atlas/react`: design tokens (`variables`),
per-element class overrides (`elements`), and prebuilt `baseTheme`s (`default`,
`dark`, `neobrutalist`). Overrides are **appended** to our base classes, so a
Tailwind class you add makes a rounder button — not an unstyled one.

## Localization

Every string passes through an i18n catalog. `en-US` ships; pass a partial
`localization` catalog and it merges over `en-US`, so an untranslated key still
renders.

## Testing

```sh
pnpm --filter @atlas/vue test        # vitest + @vue/test-utils (happy-dom)
pnpm --filter @atlas/vue typecheck   # tsc --noEmit
pnpm --filter @atlas/vue build       # tsc -> dist
```

## License

MIT — see [LICENSE](./LICENSE).
