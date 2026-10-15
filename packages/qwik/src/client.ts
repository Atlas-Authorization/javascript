import {
  FapiClient,
  SignOutGuard,
  TokenCache,
  closeOAuthPopupAfterSignIn,
  completeOAuthPopupLanding,
  getProviderToken as fetchProviderToken,
  mapOAuthPopupPayload,
  msUntilRefresh,
  readExpiry,
  readRedirectResult,
  resolveFrontendApi,
  stripRedirectParams,
  evaluate,
  type ProtectCondition,
  type ProviderToken,
  type RedirectResult,
  type SignOutOptions,
  type SignOutResult,
} from '@atlasauth/js';
import type {
  AtlasOrganizationMembership,
  AtlasSession,
  AtlasSnapshot,
  AtlasUser,
  AuthStatus,
  SessionClaims,
} from './types';

/**
 * The browser Atlas client — the framework-agnostic heart of the Qwik SDK.
 *
 * Qwik has no long-lived reactive primitive like Vue's `shallowRef` that the
 * React/Vue SDKs lean on; a Qwik store is a serializable plain object. So the
 * live auth engine lives HERE, as a plain object with a change-listener, built
 * on the `@atlasauth/js` primitives (`FapiClient`, `TokenCache`, the redirect
 * and token helpers). `<AtlasProvider>` creates one in a client-only
 * `useVisibleTask$`, keeps it out of the serializable store via `noSerialize`,
 * and republishes each snapshot into the store through {@link AtlasClient.subscribe}.
 *
 * It holds exactly one thing that matters in memory: the token. Not
 * localStorage, not a cookie this code writes — the refresh token is HttpOnly
 * so browser script never touches it, and the short-lived JWT lives only as
 * long as the tab. A client that persisted either would survive the tab and
 * become the thing an XSS reads first.
 */
export interface AtlasClient {
  readonly publishableKey: string;
  /** The instance's FAPI origin. */
  readonly frontendApi: string;
  /** A snapshot of the current auth state — a plain, serializable value. */
  snapshot(): AtlasSnapshot;
  /**
   * Subscribe to state changes. The listener fires on every transition with the
   * fresh snapshot, and once synchronously is NOT implied — call {@link snapshot}
   * for the current value. Returns an unsubscribe function.
   */
  subscribe(listener: (snapshot: AtlasSnapshot) => void): () => void;
  /**
   * §5.3: a sign-in attempt handed back by an OAuth redirect that still needs a
   * second factor (no session was issued). Null in the ordinary case. Captured
   * synchronously at construction — before any component reads it.
   */
  readonly pendingAttempt: { id: string; status: string } | null;
  /** Always fresh: refreshes first if the cached token is close to expiry. */
  getToken(): Promise<string | null>;
  /**
   * §6.6 the signed-in user's OWN live token at a connected provider (Google,
   * GitHub, …), so the app can call that provider's API. Null when there is no
   * usable token. The server refreshes a stale token on read; the refresh token
   * is never exposed.
   */
  getProviderToken(provider: string): Promise<ProviderToken | null>;
  /** Evaluate a role/permission condition against the live claims. */
  has(condition: ProtectCondition): boolean;
  /**
   * Sign out: revoke the session on the Frontend API (retried once), run OIDC
   * front-channel logout, then drop all local state. Resolves whether the
   * server confirmed the revoke (`{ revoked, activeSessionId? }`); with
   * `{ strict: true }` an unconfirmed revoke rejects with a `SignOutError`
   * AFTER the local sign-out. Either way this browser remembers the session id
   * and never re-adopts it on a reload, refresh, sibling tab or new tab.
   */
  signOut(options?: SignOutOptions): Promise<SignOutResult>;
  setActiveOrganization(organizationId: string | null): Promise<void>;
  reload(): Promise<void>;
  /**
   * §6.3: complete a redirect-based sign-in (or, inside the OAuth popup, hand
   * the result back to the opener), then boot the session.
   */
  boot(): Promise<void>;
  /** Tear down the refresh timer, the sibling-tab watch and all listeners. */
  destroy(): void;
}

export interface CreateAtlasClientOptions {
  publishableKey: string;
  /**
   * The instance's Frontend API: an absolute URL such as
   * `"https://auth.example.com"`, or `"same-origin"` / a path such as `"/atlas"`
   * behind a reverse proxy on the app's own origin. Required at runtime — a
   * missing or malformed value throws an `AtlasConfigError`
   * (`FRONTEND_API_REQUIRED` / `FRONTEND_API_INVALID`). Optional in the type
   * only so existing call sites keep compiling.
   */
  frontendApi?: string;
  fetchImpl?: typeof fetch;
}

export function createAtlasClient(options: CreateAtlasClientOptions): AtlasClient {
  const publishableKey = options.publishableKey;
  // Throws on a missing/invalid value rather than quietly sending every request
  // to a relative path on the app's origin.
  const baseUrl = resolveFrontendApi(options.frontendApi, { component: 'createAtlasClient()' });
  const doFetch = options.fetchImpl ?? fetch;

  // The live state. Plain fields, not reactive — changes are broadcast to
  // subscribers, who copy a fresh snapshot into whatever reactive store they own.
  let status: AuthStatus = 'loading';
  let user: AtlasUser | null = null;
  let session: AtlasSession | null = null;
  let claims: SessionClaims | null = null;
  let memberships: AtlasOrganizationMembership[] = [];

  const cache = new TokenCache();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<(snapshot: AtlasSnapshot) => void>();

  const snapshot = (): AtlasSnapshot => ({
    status,
    user,
    session,
    claims,
    memberships,
  });

  const emit = () => {
    const snap = snapshot();
    for (const listener of listeners) listener(snap);
    scheduleRefresh();
  };

  const pendingAttempt: { id: string; status: string } | null = (() => {
    if (typeof window === 'undefined') return null;
    const result = readRedirectResult(window.location.search);
    return result?.status && !result.ticket
      ? { id: result.attemptId, status: result.status }
      : null;
  })();

  const call = (path: string, init?: RequestInit) =>
    doFetch(`${baseUrl}${path}`, {
      ...init,
      // Cookies carry the session; a fetch without this looks identical to being
      // signed out.
      credentials: 'include',
      headers: {
        'x-publishable-key': publishableKey,
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    });

  // Safer sign-out: tombstones (localStorage, per FAPI origin, shared by every
  // tab) of the sessions this browser signed out of, the revoke with retry, and
  // the background re-try of a revoke that did not land.
  const guard = new SignOutGuard({ request: call, frontendApi: baseUrl });

  const clearLocal = () => {
    cache.clear();
    status = 'signed_out';
    user = null;
    session = null;
    claims = null;
    memberships = [];
  };

  const applyToken = (jwt: string, sessionId: string) => {
    // An in-flight refresh must not resurrect a session signed out meanwhile.
    if (guard.isSignedOut(sessionId)) return;
    const expiresAt = readExpiry(jwt);
    if (!expiresAt) return;
    cache.set({ jwt, expiresAt, sessionId });
    claims = decodeClaims(jwt);
  };

  const reload = async () => {
    try {
      const response = await call('/v1/client');
      if (!response.ok) throw new Error('boot failed');

      const body = (await response.json()) as {
        session: AtlasSession | null;
        user: AtlasUser | null;
        jwt?: string;
        organization_memberships?: AtlasOrganizationMembership[];
      };

      // A session this browser signed out of is never re-adopted from a refresh
      // cookie the revoke did not clear; the guard re-tries the revoke.
      const refused = !!body.session && guard.refuse(body.session.id);
      if (!body.session || !body.user || refused) {
        clearLocal();
        emit();
        return;
      }

      user = body.user;
      session = body.session;
      memberships = body.organization_memberships ?? [];
      if (body.jwt) applyToken(body.jwt, body.session.id);
      status = 'signed_in';
      emit();
    } catch {
      // A failed boot is NOT signed-out. Rendering a sign-in form because the
      // network hiccuped throws away a perfectly good session and makes the user
      // re-authenticate for no reason.
      if (status === 'loading') {
        status = 'signed_out';
        emit();
      }
    }
  };

  const refresh = async () => {
    const current = cache.peek();
    if (!current) return;

    try {
      const response = await call(`/v1/client/sessions/${current.sessionId}/tokens`, {
        method: 'POST',
      });
      if (!response.ok) throw new Error('refresh failed');

      const body = (await response.json()) as { jwt: string; session_id: string };
      applyToken(body.jwt, body.session_id);
      emit();
    } catch {
      // The session may genuinely be gone. Re-boot rather than guess.
      await reload();
    }
  };

  /** §7.4: proactive, jittered refresh scheduled from the token's own expiry. */
  function scheduleRefresh() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (status !== 'signed_in') return;
    const token = cache.peek();
    if (!token) return;
    const delay = msUntilRefresh({ token, now: Date.now() });
    timer = setTimeout(() => void refresh(), delay);
  }

  const getToken = async () => {
    // A 5s skew so a token that would die inside the caller's request is
    // refreshed first rather than handed over.
    const usable = cache.get(5_000);
    if (usable) return usable.jwt;
    await refresh();
    return cache.get(5_000)?.jwt ?? null;
  };

  // The FAPI client for the token-vault read. Reuses the same publishable key
  // and fetch so the framework-agnostic `@atlasauth/js` helper is the single
  // implementation the Qwik SDK surfaces.
  const fapiClient = new FapiClient({ publishableKey, baseUrl, fetchImpl: doFetch });
  const getProviderToken = (provider: string) => fetchProviderToken(fapiClient, provider);

  const signOut = async (options?: SignOutOptions): Promise<SignOutResult> => {
    // The session to end: from the token cache, else the booted session, else
    // (none known yet) whatever session the cookies carry — the guard looks it
    // up, so a missing in-memory token never skips the server-side sign-out. It
    // tombstones the id first, revokes (retried once) and runs OIDC
    // front-channel logout.
    const attempt = await guard.revoke(cache.peek()?.sessionId ?? session?.id ?? null, options);
    clearLocal();
    emit();
    // §L1 the server promoted another account signed in on this browser: adopt
    // it deliberately (the revoke response already set its cookies).
    if (guard.promoted(attempt)) await reload();
    return guard.settle(attempt, options);
  };

  // Another tab signed out of THIS session (its tombstone reached the shared
  // store): drop the token and re-check, which refuses the session.
  const stopWatching = guard.watch(
    () => cache.peek()?.sessionId ?? session?.id,
    () => {
      cache.clear();
      void reload();
    },
  );

  const setActiveOrganization = async (organizationId: string | null) => {
    const current = cache.peek();
    if (!current) return;

    const response = await call(`/v1/client/sessions/${current.sessionId}/touch`, {
      method: 'POST',
      body: JSON.stringify({ active_organization_id: organizationId }),
    });
    if (!response.ok) return;

    const body = (await response.json()) as { jwt: string };
    // The new token carries the new org claims; re-boot would work too but costs
    // a round trip for information already in hand.
    applyToken(body.jwt, current.sessionId);
    await reload();
  };

  /*
   * §oauth popup mode: this page may also be running INSIDE the sign-in popup.
   *   - As the landing of a popup whose opener was severed by a
   *     Cross-Origin-Opener-Policy (`#atlas_popup_result=…`): relay the result
   *     to the opener over BroadcastChannel and close. If no opener takes it
   *     (its tab is gone), finish the sign-in here like a redirect.
   *   - After finishing a sign-in here (the redirect flow ran in the popup): tell
   *     the waiting opener and close the popup.
   */
  const boot = async () => {
    const browser = typeof window !== 'undefined';
    const fromUrl = browser ? readRedirectResult(window.location.search) : null;

    let result: RedirectResult | null = fromUrl;
    const landing = browser ? await completeOAuthPopupLanding().catch(() => null) : null;
    if (landing && !landing.delivered) {
      const outcome = mapOAuthPopupPayload(landing.payload);
      if (outcome?.ticket && outcome.attemptId) {
        result = { attemptId: outcome.attemptId, ticket: outcome.ticket };
      } else if (outcome?.continuationUrl) {
        // A second factor / connect / provider error: the redirect flow's page.
        window.location.replace(outcome.continuationUrl);
        return;
      }
    }
    // When the landing was delivered the opener redeems the ticket, not us.
    let exchanged = false;
    if (result?.ticket) {
      const response = await call('/v1/client/tickets/exchange', {
        method: 'POST',
        body: JSON.stringify({ attempt_id: result.attemptId, ticket: result.ticket }),
      }).catch(() => undefined);
      exchanged = !!response?.ok;
    }
    if (fromUrl && browser) {
      window.history.replaceState({}, document.title, stripRedirectParams(window.location.href));
    }
    await reload();
    // Signed in inside the Atlas popup: hand back to the opener and close.
    if (exchanged) void closeOAuthPopupAfterSignIn();
  };

  const destroy = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    stopWatching();
    guard.dispose();
    listeners.clear();
  };

  return {
    publishableKey,
    frontendApi: baseUrl,
    snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    pendingAttempt,
    getToken,
    getProviderToken,
    has: (condition: ProtectCondition) => evaluate(claims, condition).allowed,
    signOut,
    setActiveOrganization,
    reload,
    boot,
    destroy,
  };
}

function decodeClaims(jwt: string): SessionClaims | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(atob(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as SessionClaims;
  } catch {
    return null;
  }
}
