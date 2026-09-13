# @atlas/svelte

The official **Svelte / SvelteKit** SDK for Atlas — the Svelte peer of
[`@atlas/react`](../react). Same surface, expressed the Svelte way: a client
installed through **context**, reactive auth state exposed as **stores**, and
`.svelte` **components** for the common flows.

It wraps [`@atlas/js`](../js), the framework-agnostic browser client, exactly as
the React SDK does — so both frameworks drive the same FAPI endpoints through one
implementation and cannot diverge in what the server sees.

- Works with Svelte **4 and 5** (uses `export let` / stores; runes are optional).
- The refresh token is HttpOnly and never touched by this code; only the
  short-lived JWT lives in memory, only as long as the tab.

> Install & build note: this package builds with `svelte-package` and tests with
> Vitest + `@testing-library/svelte` under the toolchain declared in
> `package.json`. It is wired for the pnpm workspace (`workspace:*` deps) and has
> not been `pnpm install`ed in this checkout.

## Install

```bash
pnpm add @atlas/svelte
```

Peer dependencies: `svelte >= 4`. `@sveltejs/kit` is an **optional** peer, needed
only for the server helper.

## Quick start

### 1. Install the client — `initAtlas` or `<AtlasProvider>`

`initAtlas` puts the Atlas client into Svelte context. Call it once, high in the
tree — typically from your root layout, or use the `<AtlasProvider>` convenience
component which also paints the appearance tokens onto a host-DOM wrapper.

```svelte
<!-- src/routes/+layout.svelte -->
<script lang="ts">
  import { AtlasProvider } from '@atlas/svelte';
</script>

<AtlasProvider publishableKey="pk_live_…" frontendApi="https://<instance>.atlas.dev">
  <slot />
</AtlasProvider>
```

Or imperatively, from any component's `<script>`:

```svelte
<script lang="ts">
  import { initAtlas } from '@atlas/svelte';
  const atlas = initAtlas({ publishableKey: 'pk_live_…' });
</script>
```

`initAtlas` boots automatically in the browser (handles an OAuth/hosted-page
redirect, then loads `/v1/client`) and is a no-op during SSR.

### 2. Read state — stores & accessors

Every accessor returns a **store**, so `$`-prefix it in a template and it stays
live. They mirror the React hooks one-to-one:

| React hook        | Svelte accessor      | Returns a store of …                                   |
| ----------------- | -------------------- | ------------------------------------------------------ |
| `useUser()`       | `getUser()`          | `{ isLoaded, isSignedIn, user, getProviderToken }`     |
| `useSession()`    | `getSession()`       | `{ isLoaded, session }`                                |
| `useAuth()`       | `getAuth()`          | `{ isLoaded, isSignedIn, userId, sessionId, orgId, orgRole, getToken, getProviderToken, signOut, has }` |
| `useOrganization()` | `getOrganization()` | `{ isLoaded, organization, membership, memberships, setActive }` |
| `useAtlas()`      | `useAtlas()`         | the client itself (raw stores + actions)               |

```svelte
<script lang="ts">
  import { getUser, getAuth } from '@atlas/svelte';
  const user = getUser();
  const auth = getAuth();

  async function callApi() {
    const token = await $auth.getToken();      // fresh JWT, refreshed if stale
    // fetch('/api/thing', { headers: { authorization: `Bearer ${token}` } })
  }
</script>

{#if $user.isLoaded}
  <p>Hello {$user.user?.first_name ?? 'stranger'}</p>
{/if}
```

The raw stores are also on the client: `useAtlas().user`, `.session`,
`.status`, `.claims`, `.memberships`, `.isSignedIn`, `.isLoaded`.

**Action helpers** (import and call from a component `<script>`): `getToken()`,
`signOut()`, and `signIn()` / `signUp()` (which return a flow controller —
`{ state, submit, destroy }` — the same driver `<SignIn>` uses).

### 3. Components

Mirror `@atlas/react`'s `components.tsx`:

| Component               | Purpose                                                        |
| ----------------------- | ------------------------------------------------------------- |
| `<SignedIn>`            | renders its slot only when signed in                          |
| `<SignedOut>`           | renders its slot only when signed out                         |
| `<AtlasLoading>`        | slot only while the SDK is still booting                      |
| `<AtlasLoaded>`         | slot only once booted (symmetric partner of `<AtlasLoading>`) |
| `<Protect>`             | slot when the auth condition holds; `fallback` slot otherwise |
| `<SignIn>` / `<SignUp>` | full server-driven, multi-step flows                          |
| `<UserButton>`          | avatar + account menu                                         |
| `<UserProfile>`         | account-management card                                       |
| `<OrganizationSwitcher>`| switch the active organization                                |
| `<OrganizationProfile>` | active organization's card                                    |

```svelte
<script lang="ts">
  import { SignedIn, SignedOut, SignIn, UserButton, Protect } from '@atlas/svelte';
</script>

<SignedOut><SignIn /></SignedOut>
<SignedIn><UserButton /></SignedIn>

<Protect permission="org:sys_memberships:manage">
  <button>Invite member</button>
  <p slot="fallback">You don't have access.</p>
</Protect>
```

> `<Protect>` is a **rendering** helper, never an authorization boundary —
> anyone can flip the condition in devtools. The server checking the same
> permission is what actually stops them.

### Theming & i18n

Same as `@atlas/react`: pass `appearance` (design tokens + per-element class
overrides — components render in the host DOM, no iframe, so Tailwind/CSS just
work) and `localization` (a flat i18n catalog, merged over `en-US`) to
`initAtlas` / `<AtlasProvider>`.

```svelte
<AtlasProvider
  publishableKey="pk_live_…"
  appearance={{ baseTheme: 'dark', elements: { formButtonPrimary: 'rounded-xl' } }}
>
  <slot />
</AtlasProvider>
```

## SvelteKit SSR

The server helper lives at the separate `@atlas/svelte/server` entry (it depends
on `@atlas/backend` and must never enter a browser bundle). It verifies the
session JWT **locally at the edge** — the JWKS is cached in-process, so a warm
server verifies with no network round-trip.

### `hooks.server.ts`

```ts
import { handleAtlas } from '@atlas/svelte/server';

export const handle = handleAtlas({
  jwksUrl: 'https://<instance>.atlas.dev/.well-known/jwks.json',
  issuer: 'https://<instance>.atlas.dev',
  // authorizedParties: ['https://app.example.com'], // optional azp allowlist
});
```

This resolves the session once per request and stashes it on
`event.locals.auth`.

### In a `load` or endpoint

```ts
// +layout.server.ts
import { getServerAuth } from '@atlas/svelte/server';

export const load = (event) => {
  const auth = getServerAuth(event);
  return { userId: auth.userId, isSignedIn: auth.isSignedIn };
};
```

```ts
// a protected +page.server.ts
import { getServerAuth } from '@atlas/svelte/server';
import { error } from '@sveltejs/kit';

export const load = (event) => {
  const auth = getServerAuth(event);
  try {
    auth.protect({ permission: 'org:reports:read' }); // throws ForbiddenError if unmet
  } catch {
    throw error(403, 'Forbidden');
  }
  return { ok: true };
};
```

`getServerAuth(event).has(condition)` answers a condition without throwing;
`.protect(condition)` asserts it (throwing `ForbiddenError`). Both use the shared
`@atlas/authz` primitive — the same one `<Protect>` evaluates in the browser — so
a check reads identically on the client, here, and in the React/Next SDKs.

For strong typing of `event.locals.auth`, add to `src/app.d.ts`:

```ts
import type { ServerAuth } from '@atlas/svelte/server';
declare global {
  namespace App {
    interface Locals {
      auth: ServerAuth;
    }
  }
}
export {};
```

## Development

```bash
pnpm --filter @atlas/svelte build       # svelte-package → dist/
pnpm --filter @atlas/svelte typecheck   # svelte-check
pnpm --filter @atlas/svelte test        # vitest (jsdom + @testing-library/svelte)
```

Tests cover the context init, the reactive stores, and `<SignedIn>`/`<SignedOut>`
(with `@atlas/js` mocked).

## License

MIT — see [LICENSE](./LICENSE).
