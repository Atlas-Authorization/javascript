# @atlasauth/solid

SolidJS bindings for [Atlas](https://atlasauth.net). Wraps the
framework-agnostic `@atlasauth/js` client in Solid's fine-grained reactivity:
drop in `<AtlasProvider>`, read auth state through accessors, and gate UI with
control components — the Solid peer of `@atlasauth/react` and `@atlasauth/vue`.

```tsx
import {
  AtlasProvider,
  SignedIn,
  SignedOut,
  SignIn,
  UserButton,
  useAuth,
} from '@atlasauth/solid';

function App() {
  return (
    <AtlasProvider publishableKey="pk_test_...">
      <SignedIn>
        <UserButton />
      </SignedIn>
      <SignedOut>
        <SignIn />
      </SignedOut>
    </AtlasProvider>
  );
}
```

## Reactive accessors

Each returns Solid accessors (`() => T`), so a component re-runs only when the
field it reads changes:

- `useAtlas()` — the underlying client.
- `useAuth()` — `{ isLoaded, isSignedIn, userId, sessionId, orgId, orgRole, getToken, getProviderToken, signOut, has }`.
- `useUser()` — `{ isLoaded, isSignedIn, user, getProviderToken }`.
- `useSession()` — `{ isLoaded, session }`.

## Control components

`<SignedIn>`, `<SignedOut>`, `<AtlasLoading>`, `<AtlasLoaded>`, and
`<Protect permission="…" fallback={…}>` — all `<Show>`-based. `<Protect>` is a
rendering helper, never an authorization boundary: the server checking the same
permission is what actually stops an action.

## Widgets

`<SignIn>`, `<SignUp>`, and `<UserButton>` mount Atlas's server-driven flow into
a host element on mount and tear it down on cleanup.

> SSR-safe: the provider boots only in the browser; on the server it renders a
> `loading` state and hydrates into the real status on the client.
