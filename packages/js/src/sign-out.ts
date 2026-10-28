/**
 * Sign-out that cannot be silently undone.
 *
 * A browser sign-out has two halves: revoke the session on the Frontend API
 * (which also clears the HttpOnly session cookies), and drop the local state.
 * If the first half fails — a network blip, a 5xx — the refresh cookie is still
 * valid, and the very next `reload()` (a tab regaining focus, a sibling tab's
 * broadcast, a failed token refresh) re-boots straight back into the session
 * the user just signed out of.
 *
 * These helpers close that gap: {@link revokeSession} retries once and reports
 * what the server did (including the parked session it promoted, if any), and
 * {@link SessionTombstones} remembers the ids of sessions this browser signed
 * out of so a reload — or a tab opened later — never re-adopts one, even when
 * the revoke never reached the server.
 */

import { upstreamLogoutUrlFromBody } from './upstream-logout';

/** What `signOut()` resolves with. */
export interface SignOutResult {
  /**
   * Whether the Frontend API confirmed the session was revoked. `false` means
   * the local sign-out happened but the server could not be reached (or
   * refused); the session id is remembered so this browser never re-adopts it.
   */
  revoked: boolean;
  /**
   * Set when another account signed in on this browser was promoted to active
   * (multi-session). The SDK adopts it, so the user stays signed in as it.
   */
  activeSessionId?: string;
  /**
   * Set when the session came from an upstream OpenID provider with
   * RP-initiated logout on: its end-session URL. The SDKs navigate there after
   * the local sign-out unless `signOut({ upstreamLogout: false })`.
   */
  upstreamLogoutUrl?: string;
  /**
   * SAML Single Logout: the URL that ends the identity provider's session too.
   * Present only when the revoked session came from a SAML connection with
   * Single Logout on. Unless `signOut({ samlLogout: false })`, the browser has
   * already been sent there.
   */
  samlLogoutUrl?: string;
}

/** The error `signOut({ strict: true })` rejects with when the revoke fails. */
export class SignOutError extends Error {
  readonly code = 'SIGN_OUT_REVOKE_FAILED' as const;
  /** The session that could not be revoked. */
  readonly sessionId: string;
  /** The last HTTP status from the Frontend API, or `0` for a network failure. */
  readonly status: number;

  constructor(sessionId: string, status: number) {
    super(
      status === 0
        ? 'Signed out locally, but the Atlas Frontend API could not be reached to end the session.'
        : `Signed out locally, but the Atlas Frontend API refused to end the session (HTTP ${status}).`,
    );
    this.name = 'SignOutError';
    this.sessionId = sessionId;
    this.status = status;
  }
}

/** The outcome of {@link revokeSession}. */
export interface RevokeSessionOutcome {
  revoked: boolean;
  /** The last HTTP status (`0` when the request never got a response). */
  status: number;
  /** The successful response, for front-channel logout. */
  response?: Response;
  /** A parked session the server promoted to active, if any. */
  activeSessionId?: string;
  /** The upstream provider's end-session URL, when it has RP-initiated logout on. */
  upstreamLogoutUrl?: string;
  /** SAML Single Logout: the URL that completes logout at the identity provider. */
  samlLogoutUrl?: string;
}

/**
 * `POST /v1/client/sessions/:id/revoke`, retried once on a network failure or a
 * 5xx/429. A 4xx other than 429 is not retried: the server understood and said
 * no. A 404 counts as revoked — the session is already gone.
 *
 * `request` is the caller's credentialed FAPI fetch (cookies included), so the
 * server can clear the session cookies on this browser.
 */
export async function revokeSession(
  request: (path: string, init?: RequestInit) => Promise<Response>,
  sessionId: string,
  options: {
    retries?: number;
    /** Where an upstream (RP-initiated) logout returns the user — an allowed origin of the instance. */
    returnUrl?: string;
    /** SAML Single Logout: where the IdP returns the browser (an allowed origin). */
    samlLogoutRedirectUrl?: string;
  } = {},
): Promise<RevokeSessionOutcome> {
  const retries = Math.max(0, options.retries ?? 1);
  let status = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let response: Response;
    try {
      const query = options.samlLogoutRedirectUrl
        ? `?redirect_url=${encodeURIComponent(options.samlLogoutRedirectUrl)}`
        : '';
      response = await request(`/v1/client/sessions/${encodeURIComponent(sessionId)}/revoke${query}`, {
        method: 'POST',
        ...(options.returnUrl
          ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ return_url: options.returnUrl }) }
          : {}),
      });
    } catch {
      status = 0;
      continue;
    }
    status = response.status;
    if (response.ok) {
      let activeSessionId: string | undefined;
      let upstreamLogoutUrl: string | undefined;
      let samlLogoutUrl: string | undefined;
      try {
        const body = (await response.clone().json()) as {
          active_session_id?: unknown;
          saml_logout_url?: unknown;
        } | null;
        if (typeof body?.active_session_id === 'string') activeSessionId = body.active_session_id;
        upstreamLogoutUrl = upstreamLogoutUrlFromBody(body);
        samlLogoutUrl = safeSamlLogoutUrl(body?.saml_logout_url);
      } catch {
        // A body we cannot read still means the revoke succeeded.
      }
      return {
        revoked: true,
        status,
        response,
        ...(activeSessionId ? { activeSessionId } : {}),
        ...(upstreamLogoutUrl ? { upstreamLogoutUrl } : {}),
        ...(samlLogoutUrl ? { samlLogoutUrl } : {}),
      };
    }
    if (status === 404) return { revoked: true, status };
    if (status < 500 && status !== 429) break;
  }
  return { revoked: false, status };
}

/** Only an absolute https URL (or http on loopback, for local development) is followed. */
export function safeSamlLogoutUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:') return url.href;
    if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return url.href;
  } catch {
    // not a URL
  }
  return undefined;
}

const TOMBSTONE_KEY = 'atlas:signed-out-sessions';
const TOMBSTONE_LIMIT = 20;
/** How long a tombstone is kept: longer than any refresh cookie it guards against. */
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Options for {@link SessionTombstones}. */
export interface SessionTombstonesOptions {
  /**
   * The Frontend API URL or origin the sessions belong to. Tombstones are kept
   * per Frontend API origin, so two Atlas instances used on one site never
   * share (or clear) each other's.
   */
  frontendApi?: string;
  /** Override the storage key entirely (the Frontend API scope is then not appended). */
  storageKey?: string;
  /** Clock, for tests. */
  now?: () => number;
  /**
   * Where to keep the tombstones instead of `localStorage` — for runtimes
   * without one (React Native, Expo, Electron's main process, a Capacitor app,
   * an extension service worker). Pass the platform's persistent store
   * (AsyncStorage, `expo-secure-store`, `chrome.storage`, Capacitor
   * Preferences…) through a two-method adapter. Reads may be async: await
   * {@link SessionTombstones.ready} before trusting `has()` on a cold start.
   */
  store?: TombstoneStore;
}

/**
 * A key → string store for {@link SessionTombstones} on a platform without
 * `localStorage`. Either method may be sync or async; errors are swallowed
 * (memory still protects the running process).
 */
export interface TombstoneStore {
  getItem(key: string): string | null | undefined | Promise<string | null | undefined>;
  setItem(key: string, value: string): void | Promise<void>;
}

interface TombstoneEntry {
  id: string;
  /** When the session was signed out of (epoch ms). */
  at: number;
}

type StorageKind = 'local' | 'session';

/**
 * The ids of sessions this browser signed out of, so a reload — or a tab opened
 * later — never re-adopts one from a refresh cookie the revoke did not clear.
 *
 * Kept in `localStorage` (shared by every tab of the site and surviving a
 * restart), at most 20 entries, each for 30 days, pruned whenever it is read,
 * and keyed per Frontend API origin. Tabs see each other's changes on every
 * read, and {@link SessionTombstones.subscribe} reports them as they happen
 * (the `storage` event). `sessionStorage` is used only when `localStorage`
 * throws (storage disabled, sandboxed frames); memory always backs both. A
 * confirmed revoke may {@link SessionTombstones.remove} its tombstone. Never
 * holds a token — a session id is not a credential.
 */
export class SessionTombstones {
  private entries: TombstoneEntry[];
  /** Ids no storage accepted: only memory remembers them, so a sync keeps them. */
  private unsaved = new Set<string>();
  private readonly storageKey: string;
  private readonly now: () => number;
  private readonly store: TombstoneStore | undefined;
  /** False until a custom store has been read: writing earlier would drop what it holds. */
  private hydrated = true;
  /**
   * Settles once the tombstones a {@link SessionTombstonesOptions.store} holds
   * have been read (at once for `localStorage`). Never rejects.
   */
  readonly ready: Promise<void>;

  constructor(options: string | SessionTombstonesOptions = {}) {
    const opts: SessionTombstonesOptions = typeof options === 'string' ? { storageKey: options } : options;
    this.storageKey = opts.storageKey ?? scopedKey(opts.frontendApi);
    this.now = opts.now ?? Date.now;
    this.store = opts.store;
    if (this.store) {
      this.entries = [];
      this.hydrated = false;
      this.ready = this.hydrate(this.store);
      return;
    }
    this.ready = Promise.resolve();
    const stored = readStored(this.storageKey) ?? [];
    const legacy = readLegacy(this.storageKey, this.now()).filter((l) => !stored.some((e) => e.id === l.id));
    this.entries = this.prune([...stored, ...legacy]);
    // Carry an older SDK's per-tab tombstones over into the shared store, once.
    if (legacy.length) {
      this.persist();
      try {
        storage('session')?.removeItem(TOMBSTONE_KEY);
      } catch {
        /* sessionStorage unavailable */
      }
    }
  }

  has(sessionId: string | null | undefined): boolean {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    this.sync();
    return this.entries.some((e) => e.id === sessionId);
  }

  add(...sessionIds: (string | null | undefined)[]): void {
    this.sync();
    let changed = false;
    for (const id of sessionIds) {
      if (typeof id !== 'string' || !id || this.entries.some((e) => e.id === id)) continue;
      this.entries.push({ id, at: this.now() });
      changed = true;
    }
    if (changed) this.persist();
  }

  /**
   * Forget tombstones — called once a later revoke of the session is confirmed
   * (the server has ended it, so there is nothing left to re-adopt).
   */
  remove(...sessionIds: (string | null | undefined)[]): void {
    this.sync();
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => !sessionIds.includes(e.id));
    if (this.entries.length !== before) this.persist();
  }

  list(): string[] {
    this.sync();
    return this.entries.map((e) => e.id);
  }

  /**
   * Call `listener` when another tab adds or removes a tombstone (the `storage`
   * event). Returns the unsubscribe function; a no-op outside a browser.
   */
  subscribe(listener: (ids: string[]) => void): () => void {
    if (this.store) return () => undefined;
    const target = globalThis as { addEventListener?: Window['addEventListener']; removeEventListener?: Window['removeEventListener'] };
    if (typeof target.addEventListener !== 'function') return () => undefined;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== this.storageKey && event.key !== null) return;
      listener(this.list());
    };
    target.addEventListener('storage', onStorage);
    return () => target.removeEventListener?.('storage', onStorage);
  }

  /**
   * Re-read storage — the source of truth, so another tab's add or remove is
   * seen here — keeping only what this tab could not store; then drop expired
   * entries. With no readable storage, memory is all there is.
   */
  private sync(): void {
    // A custom store is written through from memory, which is authoritative.
    const stored = this.store ? null : readStored(this.storageKey);
    if (!stored) {
      this.entries = this.prune(this.entries);
      return;
    }
    const known = new Set(stored.map((e) => e.id));
    this.entries = this.prune([
      ...stored,
      ...this.entries.filter((e) => this.unsaved.has(e.id) && !known.has(e.id)),
    ]);
  }

  private prune(entries: TombstoneEntry[]): TombstoneEntry[] {
    const cutoff = this.now() - TOMBSTONE_TTL_MS;
    const seen = new Set<string>();
    const fresh = entries
      .filter((e) => e.at > cutoff && !seen.has(e.id) && seen.add(e.id))
      .sort((a, b) => a.at - b.at);
    return fresh.slice(-TOMBSTONE_LIMIT);
  }

  /** Read a custom store once, merging anything added before it answered. */
  private async hydrate(store: TombstoneStore): Promise<void> {
    let raw: string | null | undefined;
    try {
      raw = await store.getItem(this.storageKey);
    } catch {
      raw = null;
    }
    const added = this.entries;
    this.entries = this.prune([...parseEntries(raw, this.now()), ...added]);
    this.hydrated = true;
    if (added.length) this.persist();
  }

  private persist(): void {
    this.entries = this.prune(this.entries);
    const raw = JSON.stringify(this.entries);
    if (this.store) {
      if (!this.hydrated) return;
      const store = this.store;
      try {
        void Promise.resolve(store.setItem(this.storageKey, raw)).catch(() => undefined);
      } catch {
        /* memory still protects this process */
      }
      return;
    }
    if (write('local', this.storageKey, raw)) {
      // Anything parked in sessionStorage by an earlier failed write is now in localStorage.
      try {
        storage('session')?.removeItem(this.storageKey);
      } catch {
        /* nothing parked, or sessionStorage unavailable */
      }
      this.unsaved.clear();
      return;
    }
    // localStorage threw (disabled, sandboxed, full): fall back to this tab's
    // sessionStorage, and memory still protects this tab if that throws too.
    this.unsaved = write('session', this.storageKey, raw) ? new Set() : new Set(this.entries.map((e) => e.id));
  }
}

/** `atlas:signed-out-sessions:<frontend api origin>`. */
function scopedKey(frontendApi: string | undefined): string {
  if (!frontendApi) return TOMBSTONE_KEY;
  try {
    return `${TOMBSTONE_KEY}:${new URL(frontendApi).origin}`;
  } catch {
    return `${TOMBSTONE_KEY}:${frontendApi}`;
  }
}

function storage(kind: StorageKind): Storage | undefined {
  // Reading `localStorage` itself throws in some sandboxed contexts.
  return kind === 'local' ? globalThis.localStorage : globalThis.sessionStorage;
}

function write(kind: StorageKind, key: string, value: string): boolean {
  try {
    const s = storage(kind);
    if (!s) return false;
    s.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function parseEntries(raw: string | null | undefined, now: number): TombstoneEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: TombstoneEntry[] = [];
    for (const v of parsed) {
      // Bare ids are the pre-TTL format: date them now.
      if (typeof v === 'string' && v) out.push({ id: v, at: now });
      else if (v && typeof v === 'object') {
        const { id, at } = v as { id?: unknown; at?: unknown };
        if (typeof id === 'string' && id && typeof at === 'number' && Number.isFinite(at)) out.push({ id, at });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * localStorage (plus anything a failed write parked in sessionStorage), or
 * sessionStorage alone when localStorage throws; null when neither is readable.
 */
function readStored(key: string): TombstoneEntry[] | null {
  const now = Date.now();
  try {
    const s = storage('local');
    if (s) return [...parseEntries(s.getItem(key), now), ...(readSession(key, now) ?? [])];
  } catch {
    /* fall through to sessionStorage */
  }
  return readSession(key, now);
}

function readSession(key: string, now: number): TombstoneEntry[] | null {
  try {
    const s = storage('session');
    return s ? parseEntries(s.getItem(key), now) : null;
  } catch {
    return null;
  }
}

/** Tombstones written by earlier SDK versions: per tab, unscoped, in sessionStorage. */
function readLegacy(key: string, now: number): TombstoneEntry[] {
  if (key === TOMBSTONE_KEY) return [];
  return readSession(TOMBSTONE_KEY, now) ?? [];
}
