/**
 * The whole safer sign-out, once, for every framework provider.
 *
 * `@atlasauth/react` grew this inline; every other provider (Vue, Svelte,
 * Angular, Solid, Qwik, the native SDKs) drives the same steps through a
 * {@link SignOutGuard} so the behaviour cannot drift:
 *
 *   - `signOut()` remembers the session id BEFORE revoking (a tombstone), revokes
 *     it on the Frontend API (retried once), runs front-channel logout, and
 *     reports `{ revoked, activeSessionId? }` — or rejects with a
 *     {@link SignOutError} under `{ strict: true }`;
 *   - every boot / reload / refresh / sibling-tab broadcast asks
 *     {@link SignOutGuard.refuse} before adopting a session, so a session this
 *     browser signed out of is never re-adopted from a refresh cookie (or a
 *     stored token) the revoke did not clear;
 *   - a refused session is revoked again in the background, and its tombstone is
 *     dropped once the server confirms;
 *   - a parked session the server promoted on revoke is adopted
 *     ({@link SignOutGuard.promoted}).
 *
 * The provider keeps its own state and calls these at the matching points.
 */

import type { SignOutOptions } from './frontchannel-logout';
import { runFrontChannelLogoutFromResponse } from './frontchannel-logout';
import { followUpstreamLogout } from './upstream-logout';
import { endImpersonation, type EndImpersonationResult } from './impersonation';
import {
  SessionTombstones,
  SignOutError,
  revokeSession,
  type RevokeSessionOutcome,
  type SignOutResult,
  type TombstoneStore,
} from './sign-out';

/** A credentialed Frontend API request (`path` is relative to the FAPI base URL). */
export type FapiRequest = (path: string, init?: RequestInit) => Promise<Response>;

/** Options for {@link SignOutGuard}. */
export interface SignOutGuardOptions {
  /** The provider's FAPI request: cookies (web) or its bearer token (native). */
  request: FapiRequest;
  /** The Frontend API base URL — tombstones are kept per Frontend API origin. */
  frontendApi?: string;
  /** A persistent store for platforms without `localStorage` (see {@link TombstoneStore}). */
  store?: TombstoneStore;
  /** Bring your own tombstones (tests, or a set shared with other code). */
  tombstones?: SessionTombstones;
  /**
   * Delays (ms) between background re-tries of a revoke `signOut()` could not
   * complete. Default `[15_000, 60_000, 300_000]`; `[]` re-tries only when a
   * refused session shows up on a later boot.
   */
  retryDelaysMs?: number[];
  /** Skip front-channel logout entirely (runtimes without a DOM). */
  frontChannelLogout?: boolean;
  /**
   * How to open the upstream end-session URL or the SAML Single Logout URL
   * (default: `window.location.assign`).
   * Native SDKs pass their system-browser opener.
   */
  navigate?: (href: string) => void;
}

/** What {@link SignOutGuard.revoke} did on the server. */
export interface SignOutAttempt {
  /** The session that was signed out of, or null when there was none. */
  sessionId: string | null;
  outcome: RevokeSessionOutcome;
}

/** The cross-tab sign-out signal: session ids (never tokens) a tab signed out of. */
export interface SignedOutSignal {
  signedOut?: string[];
}

const DEFAULT_RETRY_DELAYS_MS = [15_000, 60_000, 300_000];

export class SignOutGuard {
  /** The sessions this browser (or app) signed out of. */
  readonly tombstones: SessionTombstones;
  private readonly request: FapiRequest;
  private readonly retryDelaysMs: number[];
  private readonly frontChannelLogout: boolean;
  private readonly navigate?: (href: string) => void;
  /** Sessions with a background revoke in flight or scheduled. */
  private readonly retrying = new Set<string>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(options: SignOutGuardOptions) {
    this.request = options.request;
    this.tombstones =
      options.tombstones ??
      new SessionTombstones({ frontendApi: options.frontendApi, ...(options.store ? { store: options.store } : {}) });
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.frontChannelLogout = options.frontChannelLogout !== false;
    this.navigate = options.navigate;
  }

  /** Settles once persisted tombstones are loaded — await it before the first boot. */
  get ready(): Promise<void> {
    return this.tombstones.ready;
  }

  /** Whether this browser signed out of `sessionId`. */
  isSignedOut(sessionId: string | null | undefined): boolean {
    return this.tombstones.has(sessionId);
  }

  /**
   * Call with the session a boot / reload / refresh is about to adopt. True when
   * it must NOT be adopted (this browser signed out of it); the revoke is then
   * re-tried in the background and the tombstone dropped once it lands.
   */
  refuse(sessionId: string | null | undefined, request?: FapiRequest): boolean {
    if (!this.tombstones.has(sessionId)) return false;
    this.retryInBackground(sessionId as string, request ?? this.request, []);
    return true;
  }

  /**
   * The server half of `signOut()`. Finds the session to end when the provider
   * does not know it (`GET /v1/client` — the revoke works from the cookies, so a
   * missing in-memory token never skips it), tombstones it, revokes it (retried
   * once) and runs front-channel logout. A failed revoke is re-tried in the
   * background. Pass `request` to revoke with a credential the provider is about
   * to drop (a native bearer token).
   */
  async revoke(
    sessionId: string | null | undefined,
    options: SignOutOptions & { request?: FapiRequest } = {},
  ): Promise<SignOutAttempt> {
    const request = options.request ?? this.request;
    let id = sessionId || null;
    let outcome: RevokeSessionOutcome = { revoked: true, status: 200 };
    if (!id) {
      try {
        const response = await request('/v1/client');
        if (!response.ok) throw new Error('boot failed');
        const body = (await response.json()) as { session?: { id?: unknown } | null } | null;
        id = typeof body?.session?.id === 'string' ? body.session.id : null;
      } catch {
        outcome = { revoked: false, status: 0 };
      }
    }
    if (id) {
      // Remember it first: from here on nothing may re-adopt it.
      this.tombstones.add(id);
      // The upstream (RP-initiated) logout lands on `returnUrl`; SAML Single
      // Logout returns the browser to `samlLogoutRedirectUrl` once the IdP is
      // done (else `returnUrl`, else the page that signed out — the server reads
      // it from the request's Referer / Origin).
      outcome = await revokeSession(request, id, {
        ...(options.returnUrl ? { returnUrl: options.returnUrl } : {}),
        ...(options.samlLogoutRedirectUrl ? { samlLogoutRedirectUrl: options.samlLogoutRedirectUrl } : {}),
      });
      // OIDC Front-Channel Logout: let the apps signed in through this session
      // clear theirs in this browser (hidden iframes, capped at 5 s). Best-effort.
      if (this.frontChannelLogout && options.frontchannel !== false && typeof document !== 'undefined') {
        await runFrontChannelLogoutFromResponse(outcome.response);
      }
      if (!outcome.revoked) this.retryInBackground(id, request, this.retryDelaysMs);
    }
    return { sessionId: id, outcome };
  }

  /**
   * End the active impersonation ("return to admin") — see
   * {@link endImpersonation}. The ended session is tombstoned so a stale cookie
   * can never re-adopt it. The framework SDKs adopt `activeSessionId` (or sign
   * out locally when there is none) after this resolves.
   */
  async endImpersonation(
    sessionId: string | null | undefined,
    request?: FapiRequest,
  ): Promise<EndImpersonationResult> {
    if (!sessionId) return { ended: false, resumed: false, status: 0 };
    const outcome = await endImpersonation(request ?? this.request, sessionId);
    if (outcome.ended) this.tombstones.add(sessionId);
    return outcome;
  }

  /** The parked session the server promoted on revoke, when it should be adopted. */
  promoted(attempt: SignOutAttempt): string | null {
    const id = attempt.outcome.activeSessionId;
    return id && !this.tombstones.has(id) ? id : null;
  }

  /**
   * What `signOut()` resolves with — or, with `{ strict: true }` and a revoke the
   * server never confirmed, the {@link SignOutError} it rejects with. Call after
   * the local sign-out.
   */
  settle(attempt: SignOutAttempt, options: SignOutOptions = {}): SignOutResult {
    const { outcome, sessionId } = attempt;
    if (!outcome.revoked && options.strict) throw new SignOutError(sessionId ?? '', outcome.status);
    // A browser follows one logout redirect. Upstream (RP-initiated) logout
    // first: the local sign-out is done, so the browser can now be sent to the
    // provider's end-session URL (an OpenID provider has no server-to-server
    // fallback; a SAML IdP is told through SOAP back-channel logout when the
    // server returned both).
    const followedUpstream =
      outcome.upstreamLogoutUrl && options.upstreamLogout !== false
        ? followUpstreamLogout(outcome.upstreamLogoutUrl, this.navigate)
        : false;
    // SAML Single Logout: send the browser to the IdP so its session ends too.
    // Not when another account was promoted (the user is still signed in here),
    // and never outside a browser (unless the host supplied `navigate`).
    if (
      !followedUpstream &&
      outcome.samlLogoutUrl &&
      options.samlLogout !== false &&
      !outcome.activeSessionId
    ) {
      if (this.navigate) this.navigate(outcome.samlLogoutUrl);
      else if (typeof window !== 'undefined' && typeof window.location?.assign === 'function') {
        window.location.assign(outcome.samlLogoutUrl);
      }
    }
    return {
      revoked: outcome.revoked,
      ...(outcome.activeSessionId ? { activeSessionId: outcome.activeSessionId } : {}),
      ...(outcome.upstreamLogoutUrl ? { upstreamLogoutUrl: outcome.upstreamLogoutUrl } : {}),
      ...(outcome.samlLogoutUrl ? { samlLogoutUrl: outcome.samlLogoutUrl } : {}),
    };
  }

  /** The cross-tab message announcing a sign-out (`{}` when there was no session). */
  signal(attempt: SignOutAttempt): SignedOutSignal {
    return attempt.sessionId ? { signedOut: [attempt.sessionId] } : {};
  }

  /**
   * Learn the sessions a sibling tab signed out of from its broadcast — call it
   * BEFORE re-checking, so the re-check cannot re-adopt one. Returns the ids.
   */
  learn(message: unknown): string[] {
    const list = (message as SignedOutSignal | null)?.signedOut;
    if (!Array.isArray(list)) return [];
    const ids = list.filter((id): id is string => typeof id === 'string' && !!id);
    this.tombstones.add(...ids);
    return ids;
  }

  /**
   * Call `onSignedOut` when another tab signs out of the session `current()`
   * returns (its tombstone reached the shared store). Returns the unsubscribe.
   */
  watch(current: () => string | null | undefined, onSignedOut: () => void): () => void {
    return this.tombstones.subscribe((ids) => {
      const id = current();
      if (id && ids.includes(id)) onSignedOut();
    });
  }

  /** Cancel scheduled background re-tries (provider teardown). */
  dispose(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.retrying.clear();
  }

  /**
   * Revoke `sessionId` again: now when `delays` is empty, else after each delay
   * in turn until one lands. Drops the tombstone on success. One chain per session.
   */
  private retryInBackground(sessionId: string, request: FapiRequest, delays: number[]): void {
    if (this.retrying.has(sessionId)) return;
    this.retrying.add(sessionId);
    const attempt = async (index: number): Promise<void> => {
      let revoked = false;
      try {
        revoked = (await revokeSession(request, sessionId, { retries: 0 })).revoked;
      } catch {
        revoked = false;
      }
      if (revoked) {
        this.tombstones.remove(sessionId);
        this.retrying.delete(sessionId);
        return;
      }
      if (index >= delays.length || !this.retrying.has(sessionId)) {
        this.retrying.delete(sessionId);
        return;
      }
      schedule(index);
    };
    const schedule = (index: number) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        void attempt(index + 1);
      }, delays[index]);
      (timer as { unref?: () => void }).unref?.();
      this.timers.add(timer);
    };
    if (delays.length === 0) void attempt(0);
    else schedule(0);
  }
}
