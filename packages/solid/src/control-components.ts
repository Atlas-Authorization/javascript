import { Show, createMemo, type JSX } from 'solid-js';
import { h } from './h';
import { evaluate, type ProtectCondition } from '@atlasauth/js';
import { useAtlas } from './context';
import { useUser } from './accessors';

/**
 * Control / conditional-rendering components — the Solid peers of React's
 * `control-components.tsx` and Vue's `<SignedIn>` / `<Protect>`.
 *
 * All three are thin `<Show>` wrappers. `when` is passed as a zero-arg FUNCTION
 * (an accessor), which `solid-js/h` converts to a reactive component prop — so
 * the branch flips when auth state changes without re-rendering anything above
 * it. (A plain getter would NOT be made reactive by `h`; only a function value
 * is.) Children are a function so `<Show>` realises them only on the winning
 * branch.
 */

export function SignedIn(props: { children?: JSX.Element }): JSX.Element {
  const { isLoaded, isSignedIn } = useUser();
  // Renders nothing while loading rather than flashing the signed-out branch.
  return h(Show, { when: () => isLoaded() && isSignedIn() }, () => props.children);
}

export function SignedOut(props: { children?: JSX.Element }): JSX.Element {
  const { isLoaded, isSignedIn } = useUser();
  return h(Show, { when: () => isLoaded() && !isSignedIn() }, () => props.children);
}

/** Render children only while the SDK is still loading. */
export function AtlasLoading(props: { children?: JSX.Element }): JSX.Element {
  const { isLoaded } = useUser();
  return h(Show, { when: () => !isLoaded() }, () => props.children);
}

/** Render children only once the SDK has finished loading — the symmetric
 * partner of {@link AtlasLoading}. */
export function AtlasLoaded(props: { children?: JSX.Element }): JSX.Element {
  const { isLoaded } = useUser();
  return h(Show, { when: () => isLoaded() }, () => props.children);
}

export type ProtectProps = ProtectCondition & {
  children?: JSX.Element;
  fallback?: JSX.Element;
};

/**
 * `<Protect permission="…">` — conditional rendering.
 *
 * A rendering helper, NEVER an authorization boundary — anyone can flip the
 * condition in devtools, and seeing is not doing. The server checking the same
 * permission is the only thing that actually stops an action; this component's
 * job is just to avoid showing a button that would fail. The evaluation lives in
 * `@atlasauth/authz` (re-exported by `@atlasauth/js`), the one primitive every
 * SDK shares, so this `<Protect>` and the server's `has()` judge a condition
 * identically.
 *
 * Implemented as a `createMemo` whose value IS the content to render, returned
 * straight from the component (not wrapped in `<Show>`). A component that
 * returns another component — `<Protect>` returning `<Show>` — breaks under
 * `solid-js/h`: the returned component's reactive scope stops updating, so the
 * gate never reopened once the token's claims landed after boot. Returning a
 * reactive accessor is how a function child behaves, and that tracks correctly.
 */
export function Protect(props: ProtectProps): JSX.Element {
  const client = useAtlas();
  const loaded = () => client.state.status !== 'loading';
  // Capture the condition ONCE as a plain object; it is fixed for the
  // component's life (the `permission`/`role` props do not change the way auth
  // state does).
  const condition = {
    permission: props.permission,
    role: props.role,
    anyPermission: props.anyPermission,
    allPermissions: props.allPermissions,
    plan: props.plan,
    feature: props.feature,
  };

  // Read status AND claims unconditionally on every run so both are tracked
  // from the first evaluation — while loading, show nothing (not the fallback);
  // once loaded, show children when allowed and the caller's fallback when not.
  const content = createMemo(() => {
    const claims = client.state.claims;
    if (!loaded()) return null;
    return evaluate(claims, condition).allowed ? props.children : (props.fallback ?? null);
  });

  return content as unknown as JSX.Element;
}
