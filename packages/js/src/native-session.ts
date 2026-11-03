/**
 * Native session — the first-party OAuth→session exchange, cookie-free.
 *
 * A FIRST-PARTY OAuth client (the app IS the tenant's own property, not a
 * third-party integration) already holds an Atlas OAuth access token. On the web
 * that token would ride in a cookie and the browser would carry the session for
 * free; a native app — React Native, Electron, an extension service worker — has
 * no cookie jar against the FAPI origin, so it trades that OAuth access token for
 * a real Atlas SESSION and then carries the session itself, by hand, as a bearer.
 *
 * This module is the framework-agnostic, SSR-safe half of that:
 *
 *   1. {@link exchangeForSession} — POST the RFC 8693 token-exchange form to
 *      `/oauth2/token` and get back a {@link NativeSession}.
 *   2. {@link refreshNativeSession} — rotate the session WITHOUT a cookie, via
 *      `POST /v1/client/sessions/:sid/tokens` with the stored refresh token.
 *   3. {@link NativeSessionManager} — holds the current session, hands out a live
 *      JWT (auth-refreshing near expiry), and fires `onChange` so a platform's
 *      secure store can persist each rotated refresh token.
 *
 * Nothing here touches a DOM, a cookie, or a global besides `fetch` (which is
 * injectable), so the same code runs in a browser, a service worker, Node SSR,
 * and a React Native runtime. Neither network helper ever throws — a failure is
 * a `null`, the caller's cue to re-run the OAuth flow rather than crash.
 */

import { REFRESH_LEAD_MS } from './token-cache';

/** RFC 8693 token-exchange grant. */
const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
/** The subject token the first-party app presents is an OAuth access token. */
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
/** What we ask for in return: an Atlas session, not another OAuth token. */
const SESSION_TOKEN_TYPE = 'urn:atlas:token-type:session';

/**
 * A live Atlas session held outside a cookie.
 *
 * `sessionToken` is the short-lived (~60s) session JWT sent as `Authorization:
 * Bearer …` on `/v1/client/me/*`. `refreshToken` mints the next one and ROTATES
 * on every refresh — store the new value, discard the old. `expiresInSeconds` is
 * the lifetime the server reported for `sessionToken`, a scheduling hint only.
 */
export interface NativeSession {
  /** The short-lived session JWT. Bearer it on `/v1/client/me/*`. */
  sessionToken: string;
  /** The rotating refresh token. Persist the latest; the previous one is dead. */
  refreshToken: string;
  /** The session id (`sess_…`), the path segment the refresh call needs. */
  sessionId: string;
  /** Reported lifetime of `sessionToken`, in seconds. A hint, not a guarantee. */
  expiresInSeconds: number;
}

/** The shape `/oauth2/token` answers a successful token-exchange with. */
interface TokenExchangeResponse {
  access_token?: unknown;
  issued_token_type?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  session_id?: unknown;
}

/** The shape `/v1/client/sessions/:sid/tokens` answers a refresh with. */
interface SessionTokensResponse {
  object?: unknown;
  jwt?: unknown;
  session_id?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
}

const asNumber = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Exchange a first-party OAuth access token for an Atlas session.
 *
 * POSTs the RFC 8693 token-exchange form to `{baseUrl}/oauth2/token` and parses
 * the result into a {@link NativeSession}. Returns `null` — never throws — on a
 * network failure, a non-2xx, or a body missing the session token or id, so a
 * caller treats a failed exchange as "re-run OAuth" rather than a crash.
 *
 * Uses `opts.fetchImpl` when supplied (tests, a bearer-wrapped fetch), else the
 * global `fetch`; makes no assumption about `window`, so it is SSR-safe.
 */
export async function exchangeForSession(opts: {
  /** The instance's FAPI origin, e.g. `https://fapi.acme.atlasauth.net`. */
  baseUrl: string;
  /** The first-party OAuth client id. */
  clientId: string;
  /** The OAuth access token the app already holds. */
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<NativeSession | null> {
  const doFetch = opts.fetchImpl ?? fetch;

  // Form-urlencoded, per the grant. `URLSearchParams` escapes the token values.
  const form = new URLSearchParams({
    grant_type: TOKEN_EXCHANGE_GRANT,
    client_id: opts.clientId,
    subject_token: opts.accessToken,
    subject_token_type: ACCESS_TOKEN_TYPE,
    requested_token_type: SESSION_TOKEN_TYPE,
  });

  let response: Response;
  try {
    response = await doFetch(`${opts.baseUrl}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  let body: TokenExchangeResponse | null = null;
  try {
    body = (await response.json()) as TokenExchangeResponse;
  } catch {
    return null;
  }

  // A session is only a session if it carries both the JWT and the id the
  // refresh path needs; anything short of that is unusable, so report it as a
  // failed exchange rather than hand back a half-session.
  if (!body || typeof body.access_token !== 'string' || typeof body.session_id !== 'string') {
    return null;
  }

  return {
    sessionToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : '',
    sessionId: body.session_id,
    expiresInSeconds: asNumber(body.expires_in),
  };
}

/**
 * Rotate a native session WITHOUT a cookie.
 *
 * POSTs the stored refresh token to `/v1/client/sessions/{sessionId}/tokens`
 * with the publishable-key header, and returns the rotated {@link NativeSession}.
 * Each refresh ROTATES the refresh token: the returned session carries the new
 * one, and the old one is dead the moment this resolves — so the caller MUST
 * persist what comes back. If the server omits a fresh `refresh_token` (it may,
 * when it reuses the presented one), the presented token is carried forward.
 *
 * Returns `null` — never throws — on a network failure, a non-2xx (an expired or
 * already-rotated refresh token answers 4xx), or a body with no `jwt`. A null is
 * the caller's cue that the session is gone and OAuth must run again.
 */
export async function refreshNativeSession(opts: {
  baseUrl: string;
  publishableKey: string;
  sessionId: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}): Promise<NativeSession | null> {
  const doFetch = opts.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await doFetch(
      `${opts.baseUrl}/v1/client/sessions/${encodeURIComponent(opts.sessionId)}/tokens`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-publishable-key': opts.publishableKey,
        },
        body: JSON.stringify({ refresh_token: opts.refreshToken }),
      },
    );
  } catch {
    return null;
  }

  if (!response.ok) return null;

  let body: SessionTokensResponse | null = null;
  try {
    body = (await response.json()) as SessionTokensResponse;
  } catch {
    return null;
  }

  if (!body || typeof body.jwt !== 'string') return null;

  return {
    sessionToken: body.jwt,
    // Carry the rotated token; fall back to the presented one if the server
    // reused it rather than issuing a new value.
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : opts.refreshToken,
    sessionId: typeof body.session_id === 'string' ? body.session_id : opts.sessionId,
    expiresInSeconds: asNumber(body.expires_in),
  };
}

/**
 * Serialize a session for a secure store. The wrappers persist the WHOLE session
 * (not just the refresh token) because the refresh call needs the session id too,
 * and a rehydrated manager needs the current JWT to answer the first request
 * before any refresh. It is plain JSON — the store supplies the encryption.
 */
export function serializeNativeSession(session: NativeSession): string {
  return JSON.stringify(session);
}

/**
 * Parse a session a secure store held, validating the shape. Returns null for
 * anything that is not a complete session (absent, malformed JSON, missing a
 * field) so a wrapper boots signed-out rather than trusting a half-value.
 */
export function parseNativeSession(raw: string | null | undefined): NativeSession | null {
  if (typeof raw !== 'string' || raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const s = parsed as Record<string, unknown>;
  if (
    typeof s.sessionToken !== 'string' ||
    typeof s.refreshToken !== 'string' ||
    typeof s.sessionId !== 'string' ||
    typeof s.expiresInSeconds !== 'number'
  ) {
    return null;
  }
  return {
    sessionToken: s.sessionToken,
    refreshToken: s.refreshToken,
    sessionId: s.sessionId,
    expiresInSeconds: s.expiresInSeconds,
  };
}

/** A callback handed the session after every change, so a store can persist it. */
export type NativeSessionListener = (session: NativeSession) => void;

export interface NativeSessionManagerOptions {
  /** The instance's FAPI origin. */
  baseUrl: string;
  /** The publishable key, sent on the refresh call and in {@link NativeSessionManager.authHeaders}. */
  publishableKey: string;
  /** The first-party OAuth client id (kept for a future in-manager exchange; optional). */
  clientId?: string;
  /** Seed the manager with a session the app already holds (e.g. loaded from a secure store). */
  initial?: NativeSession;
  /** Injectable for tests; defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Called with the session after every change (set or rotate). The one hook a
   * secure-store wrapper needs to persist each rotated refresh token. Equivalent
   * to registering an {@link NativeSessionManager.onChange} listener at
   * construction — both fire.
   */
  persist?: (session: NativeSession) => void;
  /** Injectable clock, epoch ms. Defaults to `Date.now`. Keeps refresh timing testable. */
  now?: () => number;
}

/**
 * Holds the current {@link NativeSession} and keeps its JWT live.
 *
 * The manager is deliberately pure: it owns no timer and reaches for no global
 * besides the injected `fetch` and clock, so it is as happy in a service worker
 * or an SSR render as in a React Native runtime, and a test drives its whole
 * lifecycle with a fake fetch and a fake clock.
 *
 * It refreshes LAZILY — on {@link getToken}/{@link authHeaders}, when the token
 * is within {@link REFRESH_LEAD_MS} of expiry — rather than on an interval,
 * because the native hosts this backs (an MV3 worker, a backgrounded app) cannot
 * keep a long-lived timer alive anyway. Each rotation fires `persist` and every
 * {@link onChange} listener so the platform's secure store captures the new
 * refresh token; the previous one is dead.
 */
export class NativeSessionManager {
  private session: NativeSession | null = null;
  /** Absolute expiry of the current `sessionToken`, epoch ms. */
  private expiresAt = 0;
  private readonly listeners = new Set<NativeSessionListener>();
  /** Single-flight guard: concurrent getToken() calls share one refresh. */
  private refreshing: Promise<NativeSession | null> | null = null;

  private readonly baseUrl: string;
  private readonly publishableKey: string;
  readonly clientId?: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly now: () => number;

  constructor(options: NativeSessionManagerOptions) {
    this.baseUrl = options.baseUrl;
    this.publishableKey = options.publishableKey;
    this.clientId = options.clientId;
    this.fetchImpl = options.fetchImpl;
    this.now = options.now ?? (() => Date.now());
    if (options.persist) this.listeners.add(options.persist);
    // Seed without notifying — the caller already has this session (it loaded it
    // from the store), so persisting it back on construction would be a no-op
    // write and could clobber a newer value.
    if (options.initial) {
      this.session = options.initial;
      this.expiresAt = this.now() + options.initial.expiresInSeconds * 1000;
    }
  }

  /** The current session, or null when signed out. Does NOT refresh. */
  get current(): NativeSession | null {
    return this.session;
  }

  /**
   * Replace the current session (e.g. right after {@link exchangeForSession}) and
   * notify listeners so it is persisted. Recomputes the absolute expiry off the
   * injected clock.
   */
  setSession(session: NativeSession): void {
    this.session = session;
    this.expiresAt = this.now() + session.expiresInSeconds * 1000;
    this.notify(session);
  }

  /** Forget the session (sign-out). Does not notify — there is nothing to persist. */
  clear(): void {
    this.session = null;
    this.expiresAt = 0;
    this.refreshing = null;
  }

  /**
   * Register a listener fired with the session after every change, and get back
   * an unsubscribe. A secure-store wrapper uses this to persist each rotated
   * refresh token.
   */
  onChange(cb: NativeSessionListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(session: NativeSession): void {
    for (const cb of this.listeners) {
      try {
        cb(session);
      } catch {
        // A listener that throws must not break a refresh or sibling listeners.
      }
    }
  }

  /** Whether the current token is within the refresh lead of expiry (or gone). */
  private needsRefresh(): boolean {
    if (!this.session) return false;
    return this.expiresAt - REFRESH_LEAD_MS <= this.now();
  }

  /**
   * The current session JWT, refreshed first if it is within ~10s of expiry.
   *
   * Returns null when signed out. When a refresh is owed it is attempted
   * (single-flight, so twenty concurrent callers make one call); if the refresh
   * fails the EXISTING token is handed back rather than null — the server will
   * reject a truly-dead token on use, which is a better failure than pre-emptive
   * sign-out on a flaky connection. A refresh that fails because the session is
   * genuinely gone leaves `current` in place; the caller detects the dead session
   * on the 401 and re-runs OAuth.
   */
  async getToken(): Promise<string | null> {
    if (!this.session) return null;
    if (this.needsRefresh()) {
      const rotated = await this.refresh();
      if (rotated) return rotated.sessionToken;
    }
    return this.session.sessionToken;
  }

  /**
   * The headers an authenticated `/v1/client/me/*` call needs: a fresh bearer
   * (auto-refreshed like {@link getToken}) plus the publishable key. When signed
   * out, only the publishable key is returned — there is no bearer to add.
   */
  async authHeaders(): Promise<Record<string, string>> {
    const token = await this.getToken();
    return token
      ? { Authorization: `Bearer ${token}`, 'x-publishable-key': this.publishableKey }
      : { 'x-publishable-key': this.publishableKey };
  }

  /**
   * Rotate the session now. Single-flight: a refresh already in progress is
   * shared rather than duplicated. On success the new session is stored and
   * listeners fire; on failure the current session is left untouched and null is
   * returned.
   */
  async refresh(): Promise<NativeSession | null> {
    if (this.refreshing) return this.refreshing;
    const session = this.session;
    if (!session) return null;

    this.refreshing = refreshNativeSession({
      baseUrl: this.baseUrl,
      publishableKey: this.publishableKey,
      sessionId: session.sessionId,
      refreshToken: session.refreshToken,
      fetchImpl: this.fetchImpl,
    })
      .then((rotated) => {
        if (rotated) this.setSession(rotated);
        return rotated;
      })
      .finally(() => {
        this.refreshing = null;
      });

    return this.refreshing;
  }
}
