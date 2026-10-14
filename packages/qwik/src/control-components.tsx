import { component$, Slot } from '@builder.io/qwik';
import { evaluate } from '@atlasauth/js';
import { useAtlas } from './context';
import { isLoaded, isSignedIn } from './store';

/**
 * Conditional-render guards — the peer of React's `<SignedIn>`/`<SignedOut>` and
 * Vue's components. They read the reactive store, so they flip automatically
 * when the provider republishes a new snapshot. Each renders NOTHING while the
 * SDK is still loading, rather than flashing the signed-out branch.
 */

export const SignedIn = component$(() => {
  const store = useAtlas();
  return <>{isLoaded(store) && isSignedIn(store) ? <Slot /> : null}</>;
});

export const SignedOut = component$(() => {
  const store = useAtlas();
  return <>{isLoaded(store) && !isSignedIn(store) ? <Slot /> : null}</>;
});

/** Render children only while the SDK is still booting. */
export const AtlasLoading = component$(() => {
  const store = useAtlas();
  return <>{isLoaded(store) ? null : <Slot />}</>;
});

/** Render children only once the SDK has finished booting. */
export const AtlasLoaded = component$(() => {
  const store = useAtlas();
  return <>{isLoaded(store) ? <Slot /> : null}</>;
});

export interface ProtectProps {
  permission?: string;
  role?: string;
  anyPermission?: readonly string[];
  allPermissions?: readonly string[];
}

/**
 * `<Protect permission="org:sys_memberships:manage">` — conditional rendering.
 *
 * A RENDERING helper, never an authorization boundary. It decides what a user
 * SEES, and seeing is not doing. Anyone can open devtools and flip the
 * condition; the only thing that stops them acting is the server checking the
 * same permission on the request. Renders the named `fallback` slot when the
 * condition is not met, mirroring React's `fallback` prop.
 *
 * The evaluation uses the SAME `evaluate` primitive (`@atlasauth/authz`, surfaced
 * through `@atlasauth/js`) that the backend's `auth().has()` uses, so this guard
 * and the server judge a condition identically.
 */
export const Protect = component$<ProtectProps>((props) => {
  const store = useAtlas();
  if (store.status === 'loading') return <>{null}</>;
  const allowed = evaluate(store.claims, {
    permission: props.permission,
    role: props.role,
    anyPermission: props.anyPermission,
    allPermissions: props.allPermissions,
  }).allowed;
  return <>{allowed ? <Slot /> : <Slot name="fallback" />}</>;
});
