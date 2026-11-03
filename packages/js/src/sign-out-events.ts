/**
 * `onSignOut({ reason })` for embedded third parties (a support-chat widget, a
 * docs reader session, analytics identity) that must reset when the user stops
 * being signed in — on EVERY path, not only the app's own sign-out button:
 *
 *   - `user`            this tab called signOut()
 *   - `other_tab`       another tab of this app signed out (BroadcastChannel / storage signal)
 *   - `session_expired` the session ran out (idle or absolute lifetime)
 *   - `revoked`         the session was ended elsewhere (signed out on another
 *                       device, revoked by an admin, banned), detected on the
 *                       next token refresh or session re-check
 *   - `unknown`         signed out without a reason the SDK could tell
 *
 * Framework providers drive one {@link SignOutNotifier}: it fires listeners
 * once per signed-in → signed-out transition and also dispatches a
 * `atlas:signout` DOM event on `window`, so a script that has no access to the
 * app's component tree can listen too:
 *
 *   window.addEventListener('atlas:signout', (e) => Chatly('reset'));
 */

export type SignOutReason = 'user' | 'other_tab' | 'session_expired' | 'revoked' | 'unknown';

export interface SignOutEvent {
  reason: SignOutReason;
  /** The session that ended, when the SDK knew it. */
  sessionId: string | null;
}

/** The `window` event name. */
export const SIGN_OUT_EVENT = 'atlas:signout';

export type SignOutListener = (event: SignOutEvent) => void;

/** Map a signed-out `/v1/client` body's `signed_out_reason` to a reason. */
export function signOutReasonFromClient(body: unknown): SignOutReason {
  const reason = (body as { signed_out_reason?: unknown } | null)?.signed_out_reason;
  return reason === 'session_expired' || reason === 'revoked' ? reason : 'unknown';
}

export class SignOutNotifier {
  private readonly listeners = new Set<SignOutListener>();
  private hint: SignOutReason | null = null;

  /** Subscribe; returns the unsubscribe. */
  subscribe(listener: SignOutListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Note WHY the next sign-out is about to happen (call before the state
   * changes). The first hint wins until the event fires: a user sign-out that
   * also broadcasts to its own tab stays `user`.
   */
  expect(reason: SignOutReason): void {
    if (this.hint === null) this.hint = reason;
  }

  /** Drop a stale hint (e.g. the session survived after all). */
  clear(): void {
    this.hint = null;
  }

  /**
   * The provider went signed-in → signed-out: fire listeners and the DOM event
   * once, with the hinted reason (else `fallback`, else `unknown`).
   */
  signedOut(sessionId: string | null, fallback?: SignOutReason): SignOutEvent {
    const event: SignOutEvent = { reason: this.hint ?? fallback ?? 'unknown', sessionId };
    this.hint = null;
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A listener that throws must not stop the others (or the sign-out).
      }
    }
    dispatchSignOutEvent(event);
    return event;
  }
}

/** Dispatch the `atlas:signout` window event (a no-op outside a browser). */
export function dispatchSignOutEvent(event: SignOutEvent): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  try {
    const Ctor = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent;
    if (!Ctor) return;
    window.dispatchEvent(new Ctor(SIGN_OUT_EVENT, { detail: event }));
  } catch {
    // Never let a DOM quirk break a sign-out.
  }
}

/** Listen for `atlas:signout` on `window` from any framework; returns the unsubscribe. */
export function onAtlasSignOut(listener: SignOutListener): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (e: Event) => listener((e as CustomEvent<SignOutEvent>).detail);
  window.addEventListener(SIGN_OUT_EVENT, handler);
  return () => window.removeEventListener(SIGN_OUT_EVENT, handler);
}
