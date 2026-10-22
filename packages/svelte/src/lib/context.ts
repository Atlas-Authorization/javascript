import { getContext, setContext } from 'svelte';
import { derived, get, writable, type Readable } from 'svelte/store';
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
  type ProviderToken,
  type RedirectResult,
  type SignOutOptions,
  type SignOutResult,
  catalogLocale,
  SDK_HEADER,
  SignOutNotifier,
  getTemplateToken,
  reportSdkAdvisory,
  sdkHeaderValue,
  signOutReasonFromClient,
  type SignOutEvent,
  type SignOutListener,
  type SignOutReason,
  configureReferralCapture,
  type ReferralConsent,
  withDevBrowser,
} from '@atlasauth/js';
import { ATLAS_SVELTE_SDK } from './version';
import { EN_US, withFallback, type Catalog } from './i18n';
import { instanceDesignFrom, type Appearance, type InstanceDesign } from './appearance';
import type {
  AtlasOrganizationMembership,
  AtlasSession,
  AtlasUser,
  SessionClaims,
} from './types';

/**
 * §10.1 the Svelte peer of React's `<AtlasProvider>`.
 *
 * React installs the auth engine through a context provider component and hands
 * state out via hooks. The Svelte idiom is the same shape turned inside out: the
 * engine is a plain controller whose reactive state is exposed as Svelte
 * **stores**, installed into component context by {@link initAtlas} so the
 * accessors ({@link useAtlas}, {@link getUser}, …) can `getContext` it back.
 *
 * It holds exactly one thing that matters: the token, in memory. Not
 * localStorage, not a cookie this code writes — the refresh token is HttpOnly so
 * browser script never touches it, and the short-lived JWT lives only as long as
 * the tab. Persisting either would survive the tab and become the thing an XSS
 * reads first.
 */

export type AuthStatus = 'loading' | 'signed_in' | 'signed_out';

/** The context key. A `Symbol` so it cannot collide with an app's own context. */
export const ATLAS_KEY = Symbol('atlas');

export interface AtlasInitOptions {
  publishableKey: string;
  /**
   * Referral attribution: the prebuilt forms send the referral the visitor
   * arrived with on sign-in / sign-up when the instance has referrals on.
   * `false` turns that off.
   */
  referral?: false;
  /**
   * The app's own consent decision for the referral tracking cookie, used only
   * when Cookie Munch is not on the page: `'granted'` (or a function returning
   * it) lets the forms read the cookie. Default: the cookie is not read.
   */
  referralConsent?: ReferralConsent;
  /**
   * The instance's Frontend API: an absolute URL such as
   * `"https://auth.example.com"`, or `"same-origin"` / a path such as `"/atlas"`
   * behind a reverse proxy on the app's own origin. Required at runtime — a
   * missing or malformed value throws an `AtlasConfigError`
   * (`FRONTEND_API_REQUIRED` / `FRONTEND_API_INVALID`). Optional in the type
   * only so existing call sites keep compiling.
   */
  frontendApi?: string;
  appearance?: Appearance;
  localization?: Catalog;
  fetchImpl?: typeof fetch;
  /**
   * Called once each time a signed-in user becomes signed out, on every path
   * (see `AtlasClient.onSignOut`).
   */
  onSignOut?: (event: SignOutEvent) => void;
  /**
   * Skip the automatic browser boot (redirect handling + `/v1/client` load).
   * Useful in tests, or when the caller wants to drive `boot()` by hand.
   */
  manualBoot?: boolean;
}

/**
 * The reactive surface. Every field is a Svelte store, so `$user`, `$session`,
 * `$isSignedIn` work in a `.svelte` template and `get(user)` works in plain TS.
 */
export interface AtlasStores {
  /** `'loading' | 'signed_in' | 'signed_out'`. */
  status: Readable<AuthStatus>;
  user: Readable<AtlasUser | null>;
  session: Readable<AtlasSession | null>;
  claims: Readable<SessionClaims | null>;
  memberships: Readable<AtlasOrganizationMembership[]>;
  /** `status === 'signed_in'`. */
  isSignedIn: Readable<boolean>;
  /** `status !== 'loading'` — the guard against a flash of signed-out content. */
  isLoaded: Readable<boolean>;
}

export interface AtlasClient extends AtlasStores {
  publishableKey: string;
  frontendApi: string;
  appearance?: Appearance;
  catalog: Catalog;
  /**
   * The language layer of `catalog` (the `localization` bundle, without the
   * English defaults underneath; `EN_US` when none is set). Server errors are
   * looked up here as `error.<reason>`, falling back to the server's message.
   */
  errorCatalog?: Catalog;
  /** Sent to the Frontend API as `Accept-Language`: the `locale` tag of the `localization` bundle. */
  locale?: string;
  /**
   * §5.3: a sign-in attempt handed back by an OAuth redirect that still needs a
   * second factor (no session was issued). Null in the ordinary case. `<SignIn>`
   * seeds itself from this so the user resumes at the 2FA step.
   */
  pendingAttempt: { id: string; status: string } | null;
  /** The session JWT; with `{ template }` a short-lived named-template token (e.g. `'chatly'`). */
  getToken(options?: { template?: string }): Promise<string | null>;
  /**
   * Listen for sign-out on every path: `reason` is `user`, `other_tab`,
   * `session_expired`, `revoked` (ended elsewhere, seen on the next refresh) or
   * `unknown`. Returns the unsubscribe. Also dispatched as `atlas:signout` on `window`.
   */
  onSignOut(listener: SignOutListener): () => void;
  /**
   * §6.6 the signed-in user's OWN live token at a connected provider (Google,
   * GitHub, …). Null when there is no usable token. The refresh token is never
   * exposed; the server refreshes a stale token on read.
   */
  getProviderToken(provider: string): Promise<ProviderToken | null>;
  /**
   * Sign out of the active session: revoke it on the Frontend API (retried
   * once), run front-channel logout, and drop all in-memory state.
   *
   * Resolves `{ revoked, activeSessionId? }`. `revoked: false` means the server
   * could not confirm the revoke; the user is still signed out locally and this
   * browser will not re-adopt the session (a reload, a refresh, a sibling tab or
   * a tab opened later), while the revoke is re-tried in the background. When
   * the server promotes another session signed in on this browser
   * (`activeSessionId`), the client adopts it. With `{ strict: true }` a failed
   * revoke rejects with a `SignOutError` (after the local sign-out).
   */
  signOut(options?: SignOutOptions): Promise<SignOutResult>;
  setActiveOrganization(organizationId: string | null): Promise<void>;
  /** Re-boot from the Frontend API. Resolves true when a session now exists in this browser. */
  reload(): Promise<boolean>;
  /**
   * Redirect handling + the first `/v1/client` load. Runs once, in the browser
   * only. {@link initAtlas} calls it automatically unless `manualBoot` is set;
   * `<AtlasProvider>` also calls it in `onMount`, and a second call is a no-op.
   */
  boot(): Promise<void>;
  /**
   * The design configured in the Atlas dashboard (`GET /v1/appearance`), or null
   * when there is none or it cannot be read. `<AtlasProvider>` applies it.
   */
  loadInstanceDesign(): Promise<InstanceDesign | null>;
  /**
   * Cancel the scheduled refresh, the sibling-tab sign-out watch and any
   * background revoke re-tries — call from a component's `onDestroy`.
   */
  destroy(): void;
}

interface ClientBody {
  session: AtlasSession | null;
  user: AtlasUser | null;
  jwt?: string;
  organization_memberships?: AtlasOrganizationMembership[];
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

/**
 * Build the auth controller. Framework-agnostic aside from the Svelte stores it
 * exposes; {@link initAtlas} is the thin wrapper that also `setContext`s it.
 */
export function createAtlasClient(options: AtlasInitOptions): AtlasClient {
  const { publishableKey } = options;
  // Throws on a missing/invalid value rather than quietly sending every request
  // to a relative path on the app's origin.
  const baseUrl = resolveFrontendApi(options.frontendApi, {
    component: '<AtlasProvider> / initAtlas()',
  });
  const rawFetch = options.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined);
  // Development instances keep the session in a header where the browser blocks the cookie.
  const doFetch = rawFetch ? withDevBrowser(options.publishableKey, rawFetch) : undefined;
  const catalog = options.localization ? withFallback(options.localization) : EN_US;
  const errorCatalog = options.localization ?? EN_US;
  const locale = catalogLocale(options.localization);

  const status = writable<AuthStatus>('loading');
  const user = writable<AtlasUser | null>(null);
  const session = writable<AtlasSession | null>(null);
  const claims = writable<SessionClaims | null>(null);
  const memberships = writable<AtlasOrganizationMembership[]>([]);

  const cache = new TokenCache();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let booted = false;

  /**
   * Captured synchronously at construction (not after boot) so it is in context
   * before `<SignIn>` reads it — a needs_second_factor redirect carries a status
   * but no ticket, and that is what the 2FA resume seeds from.
   */
  const pendingAttempt: { id: string; status: string } | null = (() => {
    if (typeof window === 'undefined') return null;
    const result = readRedirectResult(window.location.search);
    return result?.status && !result.ticket
      ? { id: result.attemptId, status: result.status }
      : null;
  })();

  async function call(path: string, init?: RequestInit): Promise<Response> {
    if (!doFetch) throw new Error('No fetch implementation available.');
    const response = await doFetch(`${baseUrl}${path}`, {
      ...init,
      // Cookies carry the session; a fetch without this looks identical to being
      // signed out.
      credentials: 'include',
      headers: {
        'x-publishable-key': publishableKey,
        // Names this SDK so the Frontend API can flag a version with a known bug.
        [SDK_HEADER]: sdkHeaderValue(ATLAS_SVELTE_SDK),
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
    reportSdkAdvisory(response, ATLAS_SVELTE_SDK);
    return response;
  }

  // ATL-S-30 one sign-out notifier for the client's lifetime.
  const notifier = new SignOutNotifier();
  if (options.onSignOut) notifier.subscribe(options.onSignOut);

  /**
   * The sessions this browser signed out of (tombstones, shared by every tab via
   * localStorage per Frontend API). Nothing here re-adopts one — not a reload, a
   * refresh, nor a tab opened later — even while the refresh cookie the revoke
   * did not clear is still valid; the revoke is re-tried in the background.
   */
  const guard = new SignOutGuard({ request: call, frontendApi: baseUrl });

  // Another tab signed out of THIS session (its tombstone reached the shared
  // store): drop the token and re-check, which refuses the session.
  const stopWatch =
    typeof window !== 'undefined'
      ? guard.watch(
          () => cache.peek()?.sessionId ?? get(session)?.id,
          () => {
            notifier.expect('other_tab');
            cache.clear();
            void reload();
          },
        )
      : () => undefined;

  function applyToken(jwt: string, sessionId: string): void {
    // An in-flight refresh must not resurrect a session this browser signed out of.
    if (guard.isSignedOut(sessionId)) return;
    const expiresAt = readExpiry(jwt);
    if (!expiresAt) return;
    cache.set({ jwt, expiresAt, sessionId });
    claims.set(decodeClaims(jwt));
  }

  function clearSession(reason?: SignOutReason): void {
    // A signed-in → signed-out transition tells the sign-out listeners why.
    const ended = get(status) === 'signed_in' ? (get(session)?.id ?? cache.peek()?.sessionId ?? null) : undefined;
    cache.clear();
    status.set('signed_out');
    user.set(null);
    session.set(null);
    claims.set(null);
    memberships.set([]);
    if (ended !== undefined) notifier.signedOut(ended, reason);
    else notifier.clear();
  }

  function scheduleRefresh(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    if (get(status) !== 'signed_in') return;
    const token = cache.peek();
    if (!token) return;
    // §7.4: proactive, jittered refresh scheduled from the token's own expiry.
    const delay = msUntilRefresh({ token, now: Date.now() });
    timer = setTimeout(() => void refresh(), delay);
  }

  async function reload(): Promise<boolean> {
    try {
      const response = await call('/v1/client');
      if (!response.ok) throw new Error('boot failed');

      const body = (await response.json()) as ClientBody;
      // A session this browser signed out of (the revoke never landed) is
      // refused: stay signed out; the guard re-tries the revoke in the background.
      if (!body.session || !body.user || guard.refuse(body.session.id)) {
        clearSession(body.session ? 'other_tab' : signOutReasonFromClient(body));
        return false;
      }
      notifier.clear();

      user.set(body.user);
      session.set(body.session);
      memberships.set(body.organization_memberships ?? []);
      if (body.jwt) applyToken(body.jwt, body.session.id);
      status.set('signed_in');
      scheduleRefresh();
      return true;
    } catch {
      /**
       * A failed boot is NOT signed-out. Rendering a sign-in form because the
       * network hiccuped throws away a perfectly good session and makes the user
       * re-authenticate for no reason.
       */
      status.update((current) => (current === 'loading' ? 'signed_out' : current));
      return false;
    }
  }

  async function refresh(): Promise<void> {
    const current = cache.peek();
    if (!current) return;
    try {
      const response = await call(`/v1/client/sessions/${current.sessionId}/tokens`, {
        method: 'POST',
      });
      if (!response.ok) throw new Error('refresh failed');
      const body = (await response.json()) as { jwt: string; session_id: string };
      applyToken(body.jwt, body.session_id);
      scheduleRefresh();
    } catch {
      // The session may genuinely be gone. Re-boot rather than guess.
      await reload();
    }
  }

  async function getToken(opts?: { template?: string }): Promise<string | null> {
    if (opts?.template) {
      const sessionId = cache.peek()?.sessionId ?? get(session)?.id ?? null;
      return sessionId ? ((await getTemplateToken(fapiClient, sessionId, opts.template))?.jwt ?? null) : null;
    }
    // A 5s skew so a token that would die inside the caller's request is
    // refreshed first rather than handed over.
    const usable = cache.get(5_000);
    if (usable) return usable.jwt;
    await refresh();
    return cache.get(5_000)?.jwt ?? null;
  }

  // Referral attribution: app-wide options every FAPI client on the page falls back to.
  configureReferralCapture({ referral: options.referral, referralConsent: options.referralConsent });
  const fapiClient = new FapiClient({ publishableKey, baseUrl, fetchImpl: doFetch, locale, sdk: ATLAS_SVELTE_SDK });

  function getProviderToken(provider: string): Promise<ProviderToken | null> {
    return fetchProviderToken(fapiClient, provider);
  }

  async function signOut(options?: SignOutOptions): Promise<SignOutResult> {
    // The session to end: from the token cache, else the booted session, else
    // (no state yet) whatever session the cookies carry — the guard looks it up,
    // so a missing in-memory token never skips the server-side sign-out. It
    // tombstones the session first, revokes it (retried once) and runs OIDC
    // front-channel logout.
    notifier.expect('user');
    const attempt = await guard.revoke(cache.peek()?.sessionId ?? get(session)?.id ?? null, options);
    if (timer) clearTimeout(timer);
    timer = null;
    clearSession('user');
    // The server promoted another session signed in on this browser: adopt it
    // deliberately (the revoke response already set its cookies).
    if (guard.promoted(attempt)) await reload();
    return guard.settle(attempt, options);
  }

  async function setActiveOrganization(organizationId: string | null): Promise<void> {
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
  }

  async function boot(): Promise<void> {
    if (booted) return;
    booted = true;

    /**
     * §6.3 step 3: complete a redirect-based sign-in. An OAuth or hosted-page
     * flow lands back here with a one-time ticket in the URL; exchange it for
     * cookies, scrub the URL so a reload can't replay it, THEN boot. A redirect
     * that only carries a `__atlas_status` (a second factor is still owed) has no
     * ticket, so nothing is exchanged and the app boots signed-out.
     *
     * §oauth popup mode: this page may also be running INSIDE the sign-in popup.
     *   - As the landing of a popup whose opener was severed by a
     *     Cross-Origin-Opener-Policy (`#atlas_popup_result=…`): relay the result
     *     to the opener over BroadcastChannel and close. If no opener takes it
     *     (its tab is gone), finish the sign-in here like a redirect.
     *   - After finishing a sign-in here (the redirect flow ran in the popup):
     *     tell the waiting opener and close the popup.
     */
    const fromUrl =
      typeof window !== 'undefined' ? readRedirectResult(window.location.search) : null;

    let result: RedirectResult | null = fromUrl;
    const landing =
      typeof window !== 'undefined' ? await completeOAuthPopupLanding().catch(() => null) : null;
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

    let exchanged = false;
    if (result?.ticket) {
      const response = await call('/v1/client/tickets/exchange', {
        method: 'POST',
        body: JSON.stringify({ attempt_id: result.attemptId, ticket: result.ticket }),
      }).catch(() => undefined);
      exchanged = !!response?.ok;
    }
    if (fromUrl && typeof window !== 'undefined') {
      window.history.replaceState({}, document.title, stripRedirectParams(window.location.href));
    }
    await reload();
    // Signed in inside the Atlas popup: hand back to the opener and close.
    if (exchanged) void closeOAuthPopupAfterSignIn();
  }

  async function loadInstanceDesign(): Promise<InstanceDesign | null> {
    try {
      const response = await call('/v1/appearance');
      return response.ok ? instanceDesignFrom(await response.json()) : null;
    } catch {
      return null;
    }
  }

  function destroy(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    stopWatch();
    guard.dispose();
  }

  const isSignedIn = derived(status, ($status) => $status === 'signed_in');
  const isLoaded = derived(status, ($status) => $status !== 'loading');

  const client: AtlasClient = {
    publishableKey,
    frontendApi: baseUrl,
    appearance: options.appearance,
    catalog,
    errorCatalog,
    locale,
    pendingAttempt,
    status: { subscribe: status.subscribe },
    user: { subscribe: user.subscribe },
    session: { subscribe: session.subscribe },
    claims: { subscribe: claims.subscribe },
    memberships: { subscribe: memberships.subscribe },
    isSignedIn,
    isLoaded,
    getToken,
    onSignOut: (listener: SignOutListener) => notifier.subscribe(listener),
    getProviderToken,
    signOut,
    setActiveOrganization,
    reload,
    boot,
    loadInstanceDesign,
    destroy,
  };

  // Kick off the browser boot immediately unless the caller opts out. Guarded to
  // the browser so SvelteKit SSR never touches window / a credentialed fetch.
  if (!options.manualBoot && typeof window !== 'undefined') {
    void boot();
  }

  return client;
}

/**
 * Install the Atlas client into Svelte component context and return it.
 *
 * Call from the `<script>` of a top-level component (or `<AtlasProvider>`), the
 * peer of mounting React's `<AtlasProvider>`. Everything below in the tree can
 * then reach the stores and actions through {@link useAtlas} and friends.
 */
export function initAtlas(options: AtlasInitOptions): AtlasClient {
  const client = createAtlasClient(options);
  setContext(ATLAS_KEY, client);
  return client;
}

/**
 * The installed client, from any descendant of a component that called
 * {@link initAtlas}. Throws rather than returning a null-ish default: a store of
 * `null` outside the provider is indistinguishable from a signed-out user, and
 * the developer spends an afternoon on it.
 */
export function useAtlas(): AtlasClient {
  const client = getContext<AtlasClient | undefined>(ATLAS_KEY);
  if (!client) {
    throw new Error('Atlas accessors must be used under a component that called initAtlas().');
  }
  return client;
}
