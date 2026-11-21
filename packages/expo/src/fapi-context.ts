import { createContext } from 'react';
import type { FapiClient } from '@atlasauth/js';

/** The bearer-authenticated client `<AtlasProvider>` provides (null outside it). */
export const ExpoFapiContext = createContext<FapiClient | null>(null);

/** An OAuth sign-in that came back owing a step (a second factor, a required action), for the sign-in screen to continue. */
export interface PendingOAuthAttempt {
  id: string;
  status: string;
  policyToken?: string;
  /** The native OAuth's PKCE verifier: the final ticket is redeemed with it. */
  codeVerifier?: string;
}

/** What native sign-in needs beyond the client: the app id, a way to store a session, and the pending-attempt hand-off. */
export interface ExpoNativeContextValue {
  appId?: string;
  /** Persist a session JWT in the token cache (so a reload sees it). */
  saveToken(jwt: string): Promise<void>;
  /** Hand a pending attempt to the mounted sign-in screen (or to the next one that mounts). */
  setPending(attempt: PendingOAuthAttempt): void;
  /** Subscribe a screen; it is called at once with a pending attempt that arrived earlier, then with each new one. */
  onPending(listener: (attempt: PendingOAuthAttempt) => void): () => void;
}

export const ExpoNativeContext = createContext<ExpoNativeContextValue | null>(null);

export function createExpoNativeContext(opts: { appId?: string; saveToken(jwt: string): Promise<void> }): ExpoNativeContextValue {
  let pending: PendingOAuthAttempt | null = null;
  const listeners = new Set<(a: PendingOAuthAttempt) => void>();
  return {
    ...(opts.appId ? { appId: opts.appId } : {}),
    saveToken: opts.saveToken,
    setPending(attempt) {
      pending = attempt;
      for (const l of listeners) l(attempt);
    },
    onPending(listener) {
      listeners.add(listener);
      // Delivered once: a screen that mounts later still gets it, a remount does not replay it.
      if (pending) {
        const p = pending;
        pending = null;
        listener(p);
      }
      return () => void listeners.delete(listener);
    },
  };
}
