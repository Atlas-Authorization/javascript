import { type ReactNode } from 'react';
import { useAtlas } from './AtlasProvider';
import { useSession, useUser } from './hooks';
import { evaluate, type ProtectCondition } from './protect';

/**
 * §10.2 control / conditional-rendering components — the pieces that decide
 * whether their children appear at all (auth state, load state, permission),
 * plus the multi-session remount boundary.
 */

export function SignedIn({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useUser();
  // Renders nothing while loading rather than flashing the signed-out branch.
  if (!isLoaded || !isSignedIn) return null;
  return <>{children}</>;
}

export function SignedOut({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useUser();
  if (!isLoaded || isSignedIn) return null;
  return <>{children}</>;
}

/** §10.2: render children only while the SDK is still loading. */
export function AtlasLoading({ children }: { children: ReactNode }) {
  const { isLoaded } = useUser();
  return isLoaded ? null : <>{children}</>;
}

/** §10.2: render children only once the SDK has finished loading — the
 * symmetric partner of {@link AtlasLoading}, so a consumer can show a spinner
 * and its resolved content without hand-rolling the inverse condition. */
export function AtlasLoaded({ children }: { children: ReactNode }) {
  const { isLoaded } = useUser();
  return isLoaded ? <>{children}</> : null;
}

/**
 * §10.2 `<Protect permission="…">`.
 *
 * A rendering helper, never an authorization boundary — anyone can flip the
 * condition in devtools. The server checking the same permission is what
 * actually stops them, and this component's job is only to avoid showing a
 * button that would fail.
 */
export function Protect({
  children,
  fallback = null,
  ...condition
}: ProtectCondition & { children: ReactNode; fallback?: ReactNode }) {
  const { claims, status } = useAtlas();
  if (status === 'loading') return null;
  return evaluate(claims, condition).allowed ? <>{children}</> : <>{fallback}</>;
}

/**
 * §L1 (Clerk `<MultisessionAppSupport>`). Re-mounts its subtree whenever the
 * ACTIVE account changes, so per-user state held in component state or memo
 * caches is discarded on a `setActive({ session })` switch rather than bleeding
 * one account's data into the next. Keying on the session id (plus a stable key
 * while signed out) is the whole mechanism — React unmounts the old tree and
 * mounts a fresh one when the key changes.
 */
export function MultisessionAppSupport({ children }: { children: ReactNode }) {
  const { session } = useSession();
  return <div key={session?.id ?? 'signed-out'} data-atlas="multisession-root">{children}</div>;
}
