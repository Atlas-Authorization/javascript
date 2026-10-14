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
 * {@link SessionTombstones} remembers the ids of sessions this tab signed out of
 * so a reload never re-adopts one, even when the revoke never reached the
 * server.
 */

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
  options: { retries?: number } = {},
): Promise<RevokeSessionOutcome> {
  const retries = Math.max(0, options.retries ?? 1);
  let status = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let response: Response;
    try {
      response = await request(`/v1/client/sessions/${encodeURIComponent(sessionId)}/revoke`, {
        method: 'POST',
      });
    } catch {
      status = 0;
      continue;
    }
    status = response.status;
    if (response.ok) {
      let activeSessionId: string | undefined;
      try {
        const body = (await response.clone().json()) as { active_session_id?: unknown } | null;
        if (typeof body?.active_session_id === 'string') activeSessionId = body.active_session_id;
      } catch {
        // A body we cannot read still means the revoke succeeded.
      }
      return { revoked: true, status, response, ...(activeSessionId ? { activeSessionId } : {}) };
    }
    if (status === 404) return { revoked: true, status };
    if (status < 500 && status !== 429) break;
  }
  return { revoked: false, status };
}

const TOMBSTONE_KEY = 'atlas:signed-out-sessions';
const TOMBSTONE_LIMIT = 20;

/**
 * The ids of sessions this tab signed out of. Held in memory and mirrored to
 * `sessionStorage` (so a page reload in the same tab remembers them); sibling
 * tabs learn them through the SDK's cross-tab session broadcast. Never holds a
 * token — a session id is not a credential.
 */
export class SessionTombstones {
  private readonly ids: string[];

  constructor(private readonly storageKey: string = TOMBSTONE_KEY) {
    this.ids = readStored(storageKey);
  }

  has(sessionId: string | null | undefined): boolean {
    return typeof sessionId === 'string' && this.ids.includes(sessionId);
  }

  add(...sessionIds: (string | null | undefined)[]): void {
    let changed = false;
    for (const id of sessionIds) {
      if (typeof id !== 'string' || !id || this.ids.includes(id)) continue;
      this.ids.push(id);
      changed = true;
    }
    if (!changed) return;
    while (this.ids.length > TOMBSTONE_LIMIT) this.ids.shift();
    try {
      globalThis.sessionStorage?.setItem(this.storageKey, JSON.stringify(this.ids));
    } catch {
      // Private mode / storage disabled: memory still protects this tab.
    }
  }

  list(): string[] {
    return [...this.ids];
  }
}

function readStored(key: string): string[] {
  try {
    const raw = globalThis.sessionStorage?.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === 'string').slice(-TOMBSTONE_LIMIT)
      : [];
  } catch {
    return [];
  }
}
