# @atlasauth/qwik

Qwik and Qwik City bindings for [Atlas](https://atlasauth.net). Same shape as
`@atlasauth/react` and `@atlasauth/vue` — a provider, hooks, conditional guards,
and mountable sign-in widgets — expressed idiomatically in Qwik.

```bash
pnpm add @atlasauth/qwik
```

Peer: `@builder.io/qwik` (>=1.5). Optional peer: `@builder.io/qwik-city` (>=1.5),
for the `@atlasauth/qwik/server` route guard.

## Quick start

```tsx
import { component$, Slot } from '@builder.io/qwik';
import {
  AtlasProvider,
  SignedIn,
  SignedOut,
  SignIn,
  UserButton,
  useAuth,
} from '@atlasauth/qwik';

export default component$(() => (
  <AtlasProvider publishableKey="pk_live_…" frontendApi="https://fapi.your-app.com">
    <SignedIn>
      <UserButton />
    </SignedIn>
    <SignedOut>
      <SignIn redirect="/dashboard" />
    </SignedOut>
  </AtlasProvider>
));
```

## API

- `<AtlasProvider publishableKey frontendApi>` — boots the client and provides
  the reactive store via Qwik context.
- `useAuth()` / `useUser()` / `useSession()` / `useOrganization()` — read the
  store; each returns `isLoaded` so you never flash the signed-out UI mid-boot.
- `useAtlas()` — the raw store, for advanced use.
- `<SignedIn>` / `<SignedOut>` / `<AtlasLoading>` / `<AtlasLoaded>` — conditional
  rendering over the store.
- `<Protect permission role anyPermission allPermissions>` — conditional
  rendering gated on the session claims, with a named `fallback` slot. A
  **rendering** helper, never an authorization boundary (see below).
- `<SignIn redirect?>` / `<SignUp redirect?>` — mount the `@atlasauth/embed` DOM
  widget into a ref'd element.
- `<UserButton />` — avatar + sign-out menu, rendered natively from the store.
- `@atlasauth/qwik/server` — `protectRoute(event, opts)` / `getAuthState(event)`
  for Qwik City loaders and request handlers.

## How Qwik's serialization boundary is handled

Qwik serializes component state to ship SSR output to the browser and to resume
lazily-loaded code. **The Atlas client is not serializable** — it holds closures,
an in-memory `TokenCache` and a refresh timer. So:

- The provider keeps a **plain, serializable snapshot** (`status`, `user`,
  `session`, `claims`, `memberships`, plus the instance keys) in a `useStore`.
  This is the only part that crosses the boundary.
- The **live client** is created only inside `useVisibleTask$` (client-only,
  post-paint) and stored with `noSerialize(...)`, so Qwik skips it when
  serializing and it reads back as `undefined` anywhere it has not been
  re-created. The hooks tolerate that `undefined` and resolve actions to safe
  defaults during SSR and the first paint.

The client exposes a framework-agnostic change listener (`subscribe`); the
provider mirrors each snapshot into the reactive store, so components re-render
on every auth transition.

## JSX / build

Components are authored with Qwik's `component$` and Qwik JSX, and the package
builds with plain `tsc` (`jsx: react-jsx`, `jsxImportSource: @builder.io/qwik`,
`moduleResolution: bundler`) — no Qwik optimizer in this package's toolchain.
That produces type-correct `dist`; the **consumer's** Qwik build re-optimizes the
components when it bundles the app, exactly as it does for any Qwik library.

## `<Protect>` is not a security boundary

`<Protect>` and `useAuth().has()` decide what a user **sees**, and seeing is not
doing. Anyone can flip the condition in devtools. The server checking the same
permission on the request is what actually stops them. The
`@atlasauth/qwik/server` guard is likewise a routing convenience that reads the
session cookie **without verifying its signature** — verify on the server with
`@atlasauth/backend` before trusting any claim.
