/**
 * Session continuity: keep a signed-in user signed in across a throttled
 * background tab, a bfcache restore or a laptop waking up.
 *
 * - `mayHaveSession` reads the readable `__atlas_uat` hint the server sets
 *   alongside the refresh cookie.
 * - `atlasReady` resolves once a provider finished its first boot.
 * - `onWake` fires when the page comes back (visible, focus, online, pageshow).
 * - `coordinatedRefresh` makes N tabs waking together do ONE network refresh.
 */
import { REFRESH_LEAD_MS, type CachedToken } from './token-cache';
import { broadcastChannel, winsElection, type Channel, type Claim, type RefreshMessage } from './tab-election';

/** The signed-in hint cookie (not HttpOnly; value is unix seconds). */
export const SIGNED_IN_HINT_COOKIE = '__atlas_uat';

/** True when the hint cookie is present and numeric. SSR-safe: false without a document. */
export function mayHaveSession(cookieSource?: string): boolean {
  const source = cookieSource ?? (typeof document === 'undefined' ? '' : document.cookie);
  for (const part of source.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== SIGNED_IN_HINT_COOKIE) continue;
    if (/^\d+$/.test(part.slice(eq + 1).trim())) return true;
  }
  return false;
}

// --- atlasReady ---------------------------------------------------------

interface Deferred {
  promise: Promise<{ signedIn: boolean }>;
  resolve: (value: { signedIn: boolean }) => void;
  settled: boolean;
}

function newDeferred(): Deferred {
  let resolve!: Deferred['resolve'];
  const promise = new Promise<{ signedIn: boolean }>((r) => (resolve = r));
  return { promise, resolve, settled: false };
}

let ready = newDeferred();

/** Resolves once the first boot settled. Await it before trusting `getToken()` outside a provider. */
export function atlasReady(): Promise<{ signedIn: boolean }> {
  return ready.promise;
}

/** Called by providers after the first boot. Later marks are ignored until `resetAtlasReady()`. */
export function markAtlasReady(signedIn: boolean): void {
  if (ready.settled) return;
  ready.settled = true;
  ready.resolve({ signedIn });
}

/** Re-arm after a sign-out so the next boot can mark again. */
export function resetAtlasReady(): void {
  if (ready.settled) ready = newDeferred();
}

// --- onWake -------------------------------------------------------------

/** Wake signals closer together than this collapse into one callback. */
export const WAKE_COALESCE_MS = 1_000;

/** Subscribe to the page coming back. Fires on the first signal, then ignores signals for 1 s. */
export function onWake(cb: () => void): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => undefined;
  let last = -Infinity;
  const fire = () => {
    const now = Date.now();
    if (now - last < WAKE_COALESCE_MS) return;
    last = now;
    cb();
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') fire();
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', fire);
  window.addEventListener('online', fire);
  window.addEventListener('pageshow', fire);
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', fire);
    window.removeEventListener('online', fire);
    window.removeEventListener('pageshow', fire);
  };
}

// --- coordinatedRefresh -------------------------------------------------

/** How long the election listens for rival claims before deciding. */
export const ELECTION_WAIT_MS = 50;
/** How long a losing tab waits for the winner's token before refreshing itself. */
export const ADOPT_WAIT_MS = 5_000;

interface KeyState {
  channel: Channel | null;
  claims: Claim[];
  recent: CachedToken | null;
  waiters: Array<(token: CachedToken) => void>;
  inflight: Promise<CachedToken | null> | null;
}

const states = new Map<string, KeyState>();

function stateFor(key: string): KeyState {
  let st = states.get(key);
  if (st) return st;
  const created: KeyState = { channel: null, claims: [], recent: null, waiters: [], inflight: null };
  st = created;
  states.set(key, st);
  // BroadcastChannel only: the storage-event fallback would write the session JWT into localStorage.
  created.channel = broadcastChannel(`atlas-refresh:${key}`);
  created.channel?.subscribe((raw) => {
    const msg = raw as Partial<RefreshMessage> | null;
    if (msg?.type === 'claim' && typeof msg.id === 'string' && typeof msg.at === 'number') {
      created.claims.push({ id: msg.id, at: msg.at });
    } else if (
      msg?.type === 'refreshed' &&
      typeof msg.jwt === 'string' &&
      typeof msg.expiresAt === 'number' &&
      typeof msg.sessionId === 'string'
    ) {
      created.recent = { jwt: msg.jwt, expiresAt: msg.expiresAt, sessionId: msg.sessionId };
      for (const w of created.waiters.splice(0)) w(created.recent);
    }
  });
  return st;
}

/** Forget coordination state (tests). */
export function resetCoordinatedRefresh(): void {
  for (const st of states.values()) st.channel?.close();
  states.clear();
}

const freshEnough = (t: CachedToken | null): t is CachedToken =>
  !!t && t.expiresAt - Date.now() > REFRESH_LEAD_MS;

/**
 * Run `fn` (one network token refresh) in exactly one tab among those asking
 * for the same `key`. Other tabs get the winner's token over the channel.
 * Returns the new token, or null when `fn` produced none.
 */
export function coordinatedRefresh(
  key: string,
  fn: () => Promise<CachedToken | null>,
): Promise<CachedToken | null> {
  const st = stateFor(key);
  if (st.inflight) return st.inflight;
  const run = async (): Promise<CachedToken | null> => {
    if (freshEnough(st.recent)) return st.recent;

    const doRefresh = async () => {
      const token = await fn();
      if (token) {
        st.recent = token;
        st.channel?.post({ type: 'refreshed', ...token } satisfies RefreshMessage);
      }
      return token;
    };

    const locks = typeof navigator === 'undefined' ? undefined : (navigator as { locks?: LockManager }).locks;
    if (locks?.request) {
      return locks.request(`atlas-refresh:${key}`, async () => {
        if (freshEnough(st.recent)) return st.recent;
        const token = await doRefresh();
        // Hold the lock until the broadcast has had time to land in waiting tabs.
        await new Promise((r) => setTimeout(r, 25));
        return token;
      });
    }

    // No Web Locks: elect one tab. shortcut: lowest-id wins within 50 ms; a lost
    // claim only costs a second refresh inside the server's grace window.
    const mine: Claim = { id: Math.random().toString(36).slice(2), at: Date.now() };
    st.claims = [];
    st.channel?.post({ type: 'claim', ...mine } satisfies RefreshMessage);
    // Tabs open their channel on their first refresh, so a tab waking a moment later missed the first
    // claim: say it again halfway through, so every tab that joined in the window hears it.
    await new Promise((r) => setTimeout(r, ELECTION_WAIT_MS / 2));
    st.channel?.post({ type: 'claim', ...mine } satisfies RefreshMessage);
    await new Promise((r) => setTimeout(r, ELECTION_WAIT_MS / 2));
    if (!st.channel || winsElection(mine, st.claims, Date.now())) return doRefresh();

    const adopted = await new Promise<CachedToken | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), ADOPT_WAIT_MS);
      st.waiters.push((t) => {
        clearTimeout(timer);
        resolve(t);
      });
    });
    return adopted ?? doRefresh();
  };
  const p = run().finally(() => {
    st.inflight = null;
  });
  st.inflight = p;
  return p;
}
