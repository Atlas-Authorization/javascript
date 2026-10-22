import {
  effectScope,
  shallowRef,
  watch,
  type App,
  type Plugin,
  type ShallowRef,
} from 'vue';
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
  readPopupLanding,
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
import { ATLAS_VUE_SDK } from './version';
import { applyAppearanceToDom } from '@atlasauth/design/runtime';
import { instanceDesignFrom, renderAppearance, type Appearance, type InstanceDesign } from './appearance';
import { EN_US, withFallback, type Catalog } from './i18n';
import { ATLAS_INJECTION_KEY } from './context';
import type { AtlasOrganizationMembership, AtlasSession, AtlasUser, SessionClaims } from './types';

/**
 * §10.1 `app.use(createAtlas({ publishableKey }))`.
 *
 * The Vue peer of React's `<AtlasProvider>`. Holds exactly one thing that
 * matters: the token, in memory. Not localStorage, not a cookie this code
 * writes — the refresh token is HttpOnly so browser script never touches it,
 * and the short-lived JWT lives only as long as the tab. A client that
 * persisted either would survive the tab and become the thing an XSS reads
 * first.
 */

export type AuthStatus = 'loading' | 'signed_in' | 'signed_out';

/**
 * The reactive auth state + actions provided to the whole app. Every field the
 * React `AtlasContextValue` exposes, but the mutable ones are Vue refs so a
 * composable can hand back a live `computed` rather than a snapshot.
 */
export interface AtlasClient {
  publishableKey: string;
  /** The instance's FAPI origin. */
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
  status: ShallowRef<AuthStatus>;
  user: ShallowRef<AtlasUser | null>;
  session: ShallowRef<AtlasSession | null>;
  claims: ShallowRef<SessionClaims | null>;
  memberships: ShallowRef<AtlasOrganizationMembership[]>;
  /**
   * §5.3: a sign-in attempt handed back by an OAuth redirect that still needs a
   * second factor (no session was issued). Null in the ordinary case. The
   * <SignIn> flow seeds itself from this so the user resumes at the 2FA step
   * instead of starting over. Captured synchronously at install time — before
   * any component reads it — because a `needs_second_factor` redirect carries a
   * status but no ticket, and that is what the 2FA resume seeds from.
   */
  pendingAttempt: { id: string; status: string } | null;
  /**
   * Always fresh: refreshes first if the cached token is close to expiry. With
   * `{ template }`, a short-lived named-template token (e.g. `'chatly'`).
   */
  getToken(options?: { template?: string }): Promise<string | null>;
  /**
   * Listen for sign-out on every path: `reason` is `user`, `other_tab`,
   * `session_expired`, `revoked` (ended elsewhere, seen on the next refresh) or
   * `unknown`. Returns the unsubscribe. Also dispatched as `atlas:signout` on `window`.
   */
  onSignOut(listener: SignOutListener): () => void;
  /**
   * §6.6 the signed-in user's OWN live token at a connected provider (Google,
   * GitHub, …), so the app can call that provider's API. Null when there is no
   * usable token — no linked account, or the provider granted / kept none. The
   * server refreshes a stale token on read; the refresh token is never exposed.
   */
  getProviderToken(provider: string): Promise<ProviderToken | null>;
  /**
   * End the session: revoke it on the Frontend API (retried once), sign out
   * locally, and resolve `{ revoked, activeSessionId? }`. A revoke the server
   * never confirmed still signs out here, and this browser never re-adopts the
   * session (it is remembered and the revoke re-tried in the background);
   * `{ strict: true }` rejects with a `SignOutError` in that case. When the
   * server promotes another account signed in on this browser, it is adopted.
   */
  signOut(options?: SignOutOptions): Promise<SignOutResult>;
  setActiveOrganization(organizationId: string | null): Promise<void>;
  /** Re-boot from the Frontend API. Resolves true when a session now exists in this browser. */
  reload(): Promise<boolean>;
}

export interface CreateAtlasOptions {
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
   * behind a reverse proxy on the app's own origin. Required at runtime —
   * `createAtlas()` throws an `AtlasConfigError` (`FRONTEND_API_REQUIRED` /
   * `FRONTEND_API_INVALID`) when it is missing or malformed. Optional in the
   * type only so existing call sites keep compiling.
   */
  frontendApi?: string;
  appearance?: Appearance;
  localization?: Catalog;
  fetchImpl?: typeof fetch;
  /** Called once each time a signed-in user becomes signed out (see `AtlasClient.onSignOut`). */
  onSignOut?: (event: SignOutEvent) => void;
}

/**
 * Build the Vue plugin. `app.use(createAtlas({ publishableKey }))` installs the
 * client, provides it for `inject`, paints the appearance tokens onto the host
 * DOM as CSS variables (no iframe — components render in the host DOM so
 * Tailwind/CSS just works), and boots the session.
 */
export function createAtlas(options: CreateAtlasOptions): Plugin {
  const { client, boot, loadInstanceDesign } = createAtlasClient(options);

  return {
    install(app: App) {
      app.provide(ATLAS_INJECTION_KEY, client);

      // Tokens land as CSS variables on the host document root — the Vue peer of
      // React's `<div class="atlas-root" style={cssVars}>`. There is no single
      // element wrapping the whole app in a plugin, so the document root inherits
      // them for every component that renders. With a design (a code-level
      // `preset`/`design`, or the dashboard design once fetched) the root also
      // gets the `data-atlas-*` attributes and the design stylesheet is added to
      // <head> once (see @atlasauth/design `applyAppearanceToDom`).
      if (typeof document !== 'undefined') {
        const root = document.documentElement;
        root.classList.add('atlas-root');
        let applied = applyAppearanceToDom(
          document,
          root,
          renderAppearance(options.appearance, null, { frontendApi: client.frontendApi }),
        );
        if (typeof window !== 'undefined' && options.appearance?.instanceDesign !== false) {
          // Deferred a tick so the session boot request goes first.
          void Promise.resolve().then(loadInstanceDesign).then((design) => {
            if (!design) return;
            applied = applyAppearanceToDom(
              document,
              root,
              renderAppearance(options.appearance, design, { frontendApi: client.frontendApi }),
              applied,
            );
          });
        }
      }

      // Boot once per install. Guarded to the browser: on the server there is no
      // redirect to complete and no cookie jar to read, so the app renders
      // `loading` and hydrates into the real status on the client.
      if (typeof window !== 'undefined') {
        void boot();
      }
    },
  };
}

/**
 * The reactive client. Separated from the plugin wrapper so a test can build it
 * directly, and so a single `createAtlas(...)` result installs one consistent
 * client no matter how many times the returned plugin is `use`d.
 */
function createAtlasClient(options: CreateAtlasOptions): {
  client: AtlasClient;
  boot: () => Promise<void>;
  loadInstanceDesign: () => Promise<InstanceDesign | null>;
} {
  const publishableKey = options.publishableKey;
  // Throws (synchronously, from `createAtlas()`) on a missing/invalid value
  // rather than quietly sending every request to a relative path.
  const baseUrl = resolveFrontendApi(options.frontendApi, { component: '`createAtlas()`' });
  // Development instances keep the session in a header where the browser blocks the cookie.
  const doFetch = withDevBrowser(options.publishableKey, options.fetchImpl ?? fetch);

  const status = shallowRef<AuthStatus>('loading');
  const user = shallowRef<AtlasUser | null>(null);
  const session = shallowRef<AtlasSession | null>(null);
  const claims = shallowRef<SessionClaims | null>(null);
  const memberships = shallowRef<AtlasOrganizationMembership[]>([]);

  const cache = new TokenCache();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const pendingAttempt: { id: string; status: string } | null = (() => {
    if (typeof window === 'undefined') return null;
    const result = readRedirectResult(window.location.search);
    return result?.status && !result.ticket
      ? { id: result.attemptId, status: result.status }
      : null;
  })();

  const call = async (path: string, init?: RequestInit) => {
    const response = await doFetch(`${baseUrl}${path}`, {
      ...init,
      // Cookies carry the session; a fetch without this looks identical to
      // being signed out.
      credentials: 'include',
      headers: {
        'x-publishable-key': publishableKey,
        // Names this SDK so the Frontend API can flag a version with a known bug.
        [SDK_HEADER]: sdkHeaderValue(ATLAS_VUE_SDK),
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
    reportSdkAdvisory(response, ATLAS_VUE_SDK);
    return response;
  };

  // ATL-S-30 one sign-out notifier for the app's lifetime.
  const notifier = new SignOutNotifier();
  if (options.onSignOut) notifier.subscribe(options.onSignOut);

  // The safer sign-out shared with every framework SDK: tombstones (kept in
  // localStorage per FAPI origin, so a tab opened later stays signed out), the
  // retried revoke and front-channel logout, the background re-try.
  const guard = new SignOutGuard({ request: call, frontendApi: baseUrl });

  const clearState = (reason?: SignOutReason) => {
    // A signed-in → signed-out transition tells the sign-out listeners why.
    const ended = status.value === 'signed_in' ? (session.value?.id ?? cache.peek()?.sessionId ?? null) : undefined;
    cache.clear();
    status.value = 'signed_out';
    user.value = null;
    session.value = null;
    claims.value = null;
    memberships.value = [];
    if (ended !== undefined) notifier.signedOut(ended, reason);
    else notifier.clear();
  };

  const applyToken = (jwt: string, sessionId: string) => {
    // A refresh that was in flight when the user signed out must not put the
    // signed-out session's token back.
    if (guard.isSignedOut(sessionId)) return;
    const expiresAt = readExpiry(jwt);
    if (!expiresAt) return;
    cache.set({ jwt, expiresAt, sessionId });
    claims.value = decodeClaims(jwt);
  };

  const reload = async (): Promise<boolean> => {
    try {
      const response = await call('/v1/client');
      if (!response.ok) throw new Error('boot failed');

      const body = (await response.json()) as {
        session: AtlasSession | null;
        user: AtlasUser | null;
        jwt?: string;
        organization_memberships?: AtlasOrganizationMembership[];
      };

      // The browser may still hold a refresh cookie for a session this browser
      // signed out of (the revoke never landed): stay signed out. The guard
      // re-tries the revoke in the background and drops the tombstone once it lands.
      if (!body.session || !body.user || guard.refuse(body.session.id)) {
        clearState(body.session ? 'other_tab' : signOutReasonFromClient(body));
        return false;
      }
      notifier.clear();

      user.value = body.user;
      session.value = body.session;
      memberships.value = body.organization_memberships ?? [];
      if (body.jwt) applyToken(body.jwt, body.session.id);
      status.value = 'signed_in';
      return true;
    } catch {
      // A failed boot is NOT signed-out. Rendering a sign-in form because the
      // network hiccuped throws away a perfectly good session and makes the
      // user re-authenticate for no reason.
      if (status.value === 'loading') status.value = 'signed_out';
      return false;
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
    } catch {
      // The session may genuinely be gone. Re-boot rather than guess.
      await reload();
    }
  };

  /** §7.4: proactive, jittered refresh scheduled from the token's own expiry. */
  const scheduleRefresh = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (status.value !== 'signed_in') return;
    const token = cache.peek();
    if (!token) return;
    const delay = msUntilRefresh({ token, now: Date.now() });
    timer = setTimeout(() => void refresh(), delay);
  };

  const getToken = async (opts?: { template?: string }) => {
    if (opts?.template) {
      const sessionId = currentSessionId();
      return sessionId ? ((await getTemplateToken(fapiClient, sessionId, opts.template))?.jwt ?? null) : null;
    }
    // A 5s skew so a token that would die inside the caller's request is
    // refreshed first rather than handed over.
    const usable = cache.get(5_000);
    if (usable) return usable.jwt;
    await refresh();
    return cache.get(5_000)?.jwt ?? null;
  };

  // The FAPI client for the token-vault read. Reuses the same publishable key
  // and fetch so the framework-agnostic `@atlasauth/js` helper is the single
  // implementation the Vue SDK surfaces.
  const locale = catalogLocale(options.localization);
  // Referral attribution: app-wide options every FAPI client on the page falls back to.
  configureReferralCapture({ referral: options.referral, referralConsent: options.referralConsent });
  const fapiClient = new FapiClient({ publishableKey, baseUrl, fetchImpl: doFetch, locale, sdk: ATLAS_VUE_SDK });
  const getProviderToken = (provider: string) => fetchProviderToken(fapiClient, provider);

  /** The session this client holds: the token cache's, else the booted one. */
  const currentSessionId = () => cache.peek()?.sessionId ?? session.value?.id ?? null;

  const signOut = async (options?: SignOutOptions): Promise<SignOutResult> => {
    // Tombstone → revoke (retried once) → front-channel logout. With no session
    // in memory (e.g. called before boot finished) the guard finds the one the
    // cookies carry, so a missing token never skips the server-side sign-out.
    notifier.expect('user');
    const attempt = await guard.revoke(currentSessionId(), options);
    clearState('user');
    // §L1 the server promoted another account signed in on this browser: adopt
    // it deliberately (the revoke response already set its cookies).
    if (guard.promoted(attempt)) await reload();
    return guard.settle(attempt, options);
  };

  const setActiveOrganization = async (organizationId: string | null) => {
    const current = cache.peek();
    if (!current) return;

    const response = await call(`/v1/client/sessions/${current.sessionId}/touch`, {
      method: 'POST',
      body: JSON.stringify({ active_organization_id: organizationId }),
    });
    if (!response.ok) return;

    const body = (await response.json()) as { jwt: string };
    // The new token carries the new org claims; re-boot would work too but
    // costs a round trip for information already in hand.
    applyToken(body.jwt, current.sessionId);
    await reload();
  };

  const catalog = options.localization ? withFallback(options.localization) : EN_US;
  const errorCatalog = options.localization ?? EN_US;

  // §7.4 the refresh timer is driven off the reactive state. Any change to
  // status or claims (a new token has new claims and a new expiry) reschedules
  // the proactive refresh — the Vue peer of React's expiry effect. A detached
  // scope so the watcher lives for the app's lifetime and never attaches to a
  // component that happens to install the plugin.
  const scope = effectScope(true);
  scope.run(() => {
    watch([status, claims], () => scheduleRefresh(), { flush: 'post' });
  });

  // Another tab signed out of THIS session (its tombstone reached the shared
  // localStorage): drop the token and re-check, which now refuses it. Lives for
  // the app's lifetime, like the refresh watcher.
  guard.watch(currentSessionId, () => {
    notifier.expect('other_tab');
    cache.clear();
    void reload();
  });

  /**
   * §6.3 step 3: complete a redirect-based sign-in. An OAuth or hosted-page flow
   * lands back here with a one-time ticket in the URL; exchange it for cookies,
   * scrub the URL so a reload can't replay it, THEN boot. A redirect that only
   * carries a `__atlas_status` (a second factor is still owed) has no ticket, so
   * nothing is exchanged and the app boots signed-out — exactly as intended.
   *
   * §oauth popup mode: this page may also be running INSIDE the sign-in popup.
   *   - As the landing of a popup whose opener was severed by a
   *     Cross-Origin-Opener-Policy (`#atlas_popup_result=…`): relay the result
   *     to the opener over BroadcastChannel and close. If no opener takes it
   *     (its tab is gone), finish the sign-in here like a redirect.
   *   - After finishing a sign-in here (the redirect flow ran in the popup): tell
   *     the waiting opener and close the popup.
   */
  const boot = async () => {
    const fromUrl =
      typeof window !== 'undefined' ? readRedirectResult(window.location.search) : null;

    let result: RedirectResult | null = fromUrl;
    // Checked synchronously first so an ordinary page load sends the session
    // request before anything else (the design fetch is deferred behind it).
    const landing =
      typeof window !== 'undefined' && readPopupLanding(window.location.hash)
        ? await completeOAuthPopupLanding().catch(() => null)
        : null;
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
  };

  /** The dashboard design from `GET /v1/appearance`; null on any failure (best-effort). */
  const loadInstanceDesign = async (): Promise<InstanceDesign | null> => {
    try {
      const response = await call('/v1/appearance');
      return response.ok ? instanceDesignFrom(await response.json()) : null;
    } catch {
      return null;
    }
  };

  // `boot` is returned separately, not on the client — it is an install-time
  // concern the plugin drives exactly once, so the public `AtlasClient` surface
  // stays identical to React's context value.
  return {
    client: {
      publishableKey,
      frontendApi: baseUrl,
      appearance: options.appearance,
      catalog,
      errorCatalog,
      locale,
      status,
      user,
      session,
      claims,
      memberships,
      pendingAttempt,
      getToken,
      onSignOut: (listener: SignOutListener) => notifier.subscribe(listener),
      getProviderToken,
      signOut,
      setActiveOrganization,
      reload,
    },
    boot,
    loadInstanceDesign,
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
