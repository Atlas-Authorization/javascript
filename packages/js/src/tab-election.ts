/**
 * §7.4: "a BroadcastChannel elects one refreshing tab."
 *
 * Twenty open tabs must produce ONE refresh, not twenty. That is not only a
 * load concern: refresh tokens rotate (§7.4 step 2), so twenty simultaneous
 * refreshes send the same token twenty times, nineteen of them land outside the
 * grace window, and the session is revoked for token reuse. Getting this wrong
 * does not degrade the experience — it signs the user out.
 *
 * The election is deliberately simple. A tab that wants to refresh announces a
 * claim carrying a random id and a timestamp; the lowest id within the claim
 * window wins. No consensus protocol, because the cost of getting it wrong is
 * bounded: two tabs refreshing within the 30-second grace window is exactly the
 * race the grace window exists to absorb.
 *
 * BroadcastChannel is missing in Safari private mode and older browsers, so
 * there is a localStorage fallback. A tab with NEITHER refreshes alone, which
 * is correct — one tab cannot stampede.
 */

/** How long a claim stands before it is considered abandoned. */
export const CLAIM_WINDOW_MS = 3_000;

export interface Claim {
  id: string;
  at: number;
}

/**
 * Whether `mine` wins against the claims seen so far.
 *
 * Lowest id wins, and only claims inside the window count — otherwise a tab
 * that crashed mid-refresh would block every other tab forever.
 */
export function winsElection(mine: Claim, others: readonly Claim[], now: number): boolean {
  const live = others.filter((claim) => now - claim.at < CLAIM_WINDOW_MS);
  return live.every((claim) => mine.id <= claim.id);
}

export interface Channel {
  post(message: unknown): void;
  subscribe(handler: (message: unknown) => void): () => void;
  close(): void;
}

/** BroadcastChannel where available. */
export function broadcastChannel(name: string): Channel | null {
  if (typeof BroadcastChannel === 'undefined') return null;

  const channel = new BroadcastChannel(name);
  return {
    post: (message) => channel.postMessage(message),
    subscribe(handler) {
      const listener = (event: MessageEvent) => handler(event.data);
      channel.addEventListener('message', listener);
      return () => channel.removeEventListener('message', listener);
    },
    close: () => channel.close(),
  };
}

/**
 * localStorage fallback.
 *
 * The `storage` event fires only in OTHER tabs, which is exactly the semantics
 * needed — a tab does not need to hear its own message. The key is written and
 * immediately removed so the value never accumulates and a stale claim cannot
 * outlive the session that made it.
 */
export function storageChannel(name: string): Channel | null {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return null;

  const key = `atlas:${name}`;
  return {
    post(message) {
      try {
        window.localStorage.setItem(key, JSON.stringify({ message, at: Date.now() }));
        window.localStorage.removeItem(key);
      } catch {
        // A full or disabled localStorage must not break sign-in. Losing
        // cross-tab coordination degrades to "each tab refreshes for itself",
        // which the 30-second grace window absorbs.
      }
    },
    subscribe(handler) {
      const listener = (event: StorageEvent) => {
        if (event.key !== key || !event.newValue) return;
        try {
          handler((JSON.parse(event.newValue) as { message: unknown }).message);
        } catch {
          // Another script writing to our key is not our problem to crash over.
        }
      };
      window.addEventListener('storage', listener);
      return () => window.removeEventListener('storage', listener);
    },
    close: () => undefined,
  };
}

/**
 * The best channel available, or null.
 *
 * Null is a supported state, not a failure: a single tab with no channel
 * refreshes alone and cannot stampede by definition.
 */
export function bestChannel(name: string): Channel | null {
  return broadcastChannel(name) ?? storageChannel(name);
}

export type RefreshMessage =
  | { type: 'claim'; id: string; at: number }
  | { type: 'refreshed'; jwt: string; expiresAt: number; sessionId: string }
  | { type: 'signed_out' };

export function isRefreshMessage(value: unknown): value is RefreshMessage {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return type === 'claim' || type === 'refreshed' || type === 'signed_out';
}
