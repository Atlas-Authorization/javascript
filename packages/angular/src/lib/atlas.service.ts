import {
  Injectable,
  OnDestroy,
  PLATFORM_ID,
  Signal,
  computed,
  inject,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { BehaviorSubject, Observable, Subject, combineLatest } from 'rxjs';
import { distinctUntilChanged, map } from 'rxjs/operators';
import {
  FapiClient,
  SignOutGuard,
  catalogLocale,
  localizedErrorMessage,
  type ErrorLike,
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
  withDevBrowser,
} from '@atlasauth/js';
import { evaluate, type ProtectCondition } from '@atlasauth/authz';
import { ATLAS_OPTIONS } from './atlas.config';
import {
  cssVariables,
  instanceDesignFrom,
  renderAppearance,
  resolveTokens,
  type Appearance,
  type AppearanceRender,
  type InstanceDesign,
} from './appearance';
import { EN_US, withFallback, type Catalog } from './i18n';
import type {
  AtlasOrganizationMembership,
  AtlasSession,
  AtlasUser,
  AuthStatus,
  SessionClaims,
} from './types';
import { ATLAS_ANGULAR_SDK } from './version';

/**
 * `AtlasService` — the Angular peer of React's `<AtlasProvider>` + hooks.
 *
 * It holds exactly one thing that matters in memory: the short-lived JWT, in a
 * {@link TokenCache}. Not localStorage, not a cookie this code writes — the
 * refresh token is HttpOnly so browser script never touches it, and the JWT
 * lives only as long as the tab. Anything persisted would survive the tab and
 * become the first thing an XSS reads.
 *
 * Reactive auth state is exposed two ways so callers can pick their idiom:
 *  - RxJS observables (`user$`, `session$`, `isSignedIn$`, …) — the primary API,
 *    the analogue of the React hooks' return values.
 *  - Angular signals (`user`, `session`, `isSignedIn`, …) — the same values as
 *    `Signal<T>`, for templates and `computed()`.
 *
 * The imperative methods (`signOut`, `getToken`, `getProviderToken`,
 * `setActiveOrganization`, `reload`) mirror the actions the hooks return.
 */
@Injectable({ providedIn: 'root' })
export class AtlasService implements OnDestroy {
  private readonly options = inject(ATLAS_OPTIONS);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);

  private readonly baseUrl: string;
  private readonly publishableKey: string;
  private readonly doFetch: typeof fetch;

  private readonly cache = new TokenCache();
  private readonly fapiClient: FapiClient;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The sessions this browser signed out of (tombstones in localStorage, per
   * Frontend API origin), the revoke and its background re-tries. Every reload /
   * refresh asks it before adopting a session, so a sign-out the server never
   * confirmed is not undone by the still-valid refresh cookie.
   */
  private readonly guard: SignOutGuard;
  private stopWatchingSignOut: (() => void) | null = null;

  private readonly catalog: Catalog;
  /** The language layer of `catalog` (the `localization` bundle alone; `EN_US` when none). */
  private readonly errorCatalog: Catalog;
  /** Sent to the Frontend API as `Accept-Language`: the `localization` bundle's `locale` tag. */
  private readonly requestLocale: string | undefined;

  /**
   * A sign-in attempt handed back by an OAuth redirect that still needs a second
   * factor (no session was issued). Null in the ordinary case; the `<atlas-sign-in>`
   * flow seeds itself from this so the user resumes at the 2FA step. Captured
   * once, synchronously, at construction — before any flow component reads it.
   */
  readonly pendingAttempt: { id: string; status: string } | null;

  // --- Reactive state (source of truth) ---------------------------------------

  private readonly _status = new BehaviorSubject<AuthStatus>('loading');
  private readonly _user = new BehaviorSubject<AtlasUser | null>(null);
  private readonly _session = new BehaviorSubject<AtlasSession | null>(null);
  private readonly _claims = new BehaviorSubject<SessionClaims | null>(null);
  private readonly _memberships = new BehaviorSubject<AtlasOrganizationMembership[]>([]);
  // ATL-S-30 sign-out events, on every path.
  private readonly notifier = new SignOutNotifier();
  private readonly _signOut = new Subject<SignOutEvent>();
  /**
   * Emits once each time a signed-in user becomes signed out: `reason` is
   * `user`, `other_tab`, `session_expired`, `revoked` (ended elsewhere, seen on
   * the next token refresh) or `unknown`. The place to reset an embedded
   * third party (a chat widget). Also dispatched as `atlas:signout` on `window`.
   */
  readonly signOut$: Observable<SignOutEvent> = this._signOut.asObservable();

  /** The three-state auth lifecycle: `loading` → `signed_in` | `signed_out`. */
  readonly status$: Observable<AuthStatus> = this._status.asObservable();
  readonly user$: Observable<AtlasUser | null> = this._user.asObservable();
  readonly session$: Observable<AtlasSession | null> = this._session.asObservable();
  readonly claims$: Observable<SessionClaims | null> = this._claims.asObservable();
  readonly memberships$: Observable<AtlasOrganizationMembership[]> =
    this._memberships.asObservable();

  /**
   * True once the SDK has finished its first boot. Distinguishing "still loading"
   * from "signed out" is what lets a template avoid the flash of a sign-in form
   * on every page load.
   */
  readonly isLoaded$: Observable<boolean> = this.status$.pipe(
    map((s) => s !== 'loading'),
    distinctUntilChanged(),
  );

  readonly isSignedIn$: Observable<boolean> = this.status$.pipe(
    map((s) => s === 'signed_in'),
    distinctUntilChanged(),
  );

  /** The active organization membership, derived from the token's `org_id` claim. */
  readonly organization$: Observable<AtlasOrganizationMembership | null> = combineLatest([
    this._memberships,
    this._claims,
  ]).pipe(
    map(
      ([memberships, claims]) =>
        memberships.find((m) => m.organization.id === claims?.org_id) ?? null,
    ),
  );

  // --- Signal mirror ----------------------------------------------------------

  readonly status: Signal<AuthStatus> = toSignal(this.status$, { initialValue: 'loading' });
  readonly user: Signal<AtlasUser | null> = toSignal(this.user$, { initialValue: null });
  readonly session: Signal<AtlasSession | null> = toSignal(this.session$, { initialValue: null });
  readonly claims: Signal<SessionClaims | null> = toSignal(this.claims$, { initialValue: null });
  readonly memberships: Signal<AtlasOrganizationMembership[]> = toSignal(this.memberships$, {
    initialValue: [] as AtlasOrganizationMembership[],
  });
  readonly isLoaded: Signal<boolean> = computed(() => this.status() !== 'loading');
  readonly isSignedIn: Signal<boolean> = computed(() => this.status() === 'signed_in');
  readonly organization: Signal<AtlasOrganizationMembership | null> = computed(() => {
    const orgId = this.claims()?.org_id;
    return this.memberships().find((m) => m.organization.id === orgId) ?? null;
  });

  constructor() {
    const options = this.options;
    this.publishableKey = options.publishableKey;
    // Throws an `AtlasConfigError` on a missing/invalid value rather than quietly
    // sending every request to a relative path on the app's origin.
    this.baseUrl = resolveFrontendApi(options.frontendApi, {
      component: 'provideAtlas() / AtlasModule.forRoot()',
    });
    // Development instances keep the session in a header where the browser blocks the cookie.
    this.doFetch = withDevBrowser(
      options.publishableKey,
      options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
    );

    this.catalog = options.localization ? withFallback(options.localization) : EN_US;
    this.errorCatalog = options.localization ?? EN_US;
    this.requestLocale = catalogLocale(options.localization);

    // Referral attribution: app-wide options every FAPI client on the page falls back to.
    configureReferralCapture({ referral: options.referral, referralConsent: options.referralConsent });
    this.fapiClient = new FapiClient({
      publishableKey: this.publishableKey,
      baseUrl: this.baseUrl,
      fetchImpl: this.doFetch,
      locale: this.requestLocale,
      sdk: ATLAS_ANGULAR_SDK,
    });

    this.notifier.subscribe((event) => this._signOut.next(event));
    if (options.onSignOut) this.notifier.subscribe(options.onSignOut);

    this.guard = new SignOutGuard({
      request: (path, init) => this.call(path, init),
      frontendApi: this.baseUrl,
    });

    // Captured synchronously (not in an async init) so it is available before any
    // flow component reads it: a needs_second_factor redirect carries a status but
    // no ticket, and that is what the 2FA resume seeds from.
    this.pendingAttempt = this.isBrowser ? this.readPendingAttempt() : null;

    // Boot once, browser only. On the server there is no cookie jar to read a
    // session from, so we leave the state at `loading` and let hydration boot it.
    if (this.isBrowser) {
      // Another tab signed out of THIS session (its tombstone reached the shared
      // store): drop the token and re-check, which then refuses the session.
      this.stopWatchingSignOut = this.guard.watch(
        () => this.cache.peek()?.sessionId ?? this._session.value?.id,
        () => {
          this.notifier.expect('other_tab');
          this.cache.clear();
          void this.reload();
        },
      );
      void this.boot();
    }
  }

  ngOnDestroy(): void {
    this.stopWatchingSignOut?.();
    this.stopWatchingSignOut = null;
    this.guard.dispose();
    this.clearRefreshTimer();
    this._status.complete();
    this._user.complete();
    this._session.complete();
    this._claims.complete();
    this._memberships.complete();
    this._signOut.complete();
  }

  // --- Configuration accessors ------------------------------------------------

  get appearance(): Appearance | undefined {
    return this.options.appearance;
  }

  get localization(): Catalog {
    return this.catalog;
  }

  get frontendApi(): string {
    return this.baseUrl;
  }

  /** The `Accept-Language` sent to the Frontend API: the `localization` bundle's `locale` tag, if any. */
  get locale(): string | undefined {
    return this.requestLocale;
  }

  /**
   * The text to show for a server error, in the app's language: the catalog's
   * `error.<reason>` (looked up in the `localization` bundle, or `EN_US` when
   * none is set), else the server's message, else `error.generic`.
   */
  errorText(error: ErrorLike | string | null | undefined): string {
    return localizedErrorMessage(error, this.errorCatalog, this.catalog);
  }

  /** The catalog server errors are looked up in (see {@link errorText}). */
  get errorLocalization(): Catalog {
    return this.errorCatalog;
  }

  /** Tokens as CSS custom properties, for a host element to inherit. */
  appearanceVariables(): Record<string, string> {
    return cssVariables(resolveTokens(this.options.appearance));
  }

  /**
   * The full appearance render for a root element: inline variables, the
   * `data-atlas-*` attributes and the design stylesheet. Pass the dashboard
   * design (from {@link loadInstanceDesign}) to layer code overrides on it —
   * the same semantics as `@atlasauth/react`.
   */
  appearanceRender(instanceDesign?: InstanceDesign | null): AppearanceRender {
    return renderAppearance(this.options.appearance, instanceDesign ?? null, {
      frontendApi: this.baseUrl,
    });
  }

  /**
   * The design configured in the Atlas dashboard (`GET /v1/appearance`), or null
   * when there is none, it cannot be read, or the app opted out with
   * `appearance.instanceDesign: false`.
   */
  async loadInstanceDesign(): Promise<InstanceDesign | null> {
    if (this.options.appearance?.instanceDesign === false) return null;
    try {
      const response = await this.call('/v1/appearance');
      return response.ok ? instanceDesignFrom(await response.json()) : null;
    } catch {
      return null;
    }
  }

  /** A fresh {@link FapiClient} for driving a sign-in/sign-up flow. */
  createFapiClient(): FapiClient {
    return new FapiClient({
      publishableKey: this.publishableKey,
      baseUrl: this.baseUrl,
      locale: this.requestLocale,
      sdk: ATLAS_ANGULAR_SDK,
    });
  }

  // --- Imperative API (mirrors the React hooks' actions) ----------------------

  /**
   * The current session's JWT, always fresh: if the cached token is within 5s of
   * expiry it is refreshed first rather than handed over. Null when signed out.
   */
  /** The session JWT; with `{ template }` a short-lived named-template token (e.g. `'chatly'`). */
  async getToken(options?: { template?: string }): Promise<string | null> {
    if (options?.template) {
      const sessionId = this.cache.peek()?.sessionId ?? this._session.value?.id ?? null;
      return sessionId ? ((await getTemplateToken(this.fapiClient, sessionId, options.template))?.jwt ?? null) : null;
    }
    const usable = this.cache.get(5_000);
    if (usable) return usable.jwt;

    await this.refresh();
    return this.cache.get(5_000)?.jwt ?? null;
  }

  /**
   * The signed-in user's OWN live access token at a connected provider (Google,
   * GitHub, …), so the app can call that provider's API from the browser. Null
   * when there is no usable token — no linked account, or the provider granted /
   * kept none. The server refreshes a stale token on read; the refresh token is
   * never exposed.
   */
  /** Listen for sign-out on every path (see {@link signOut$}); returns the unsubscribe. */
  onSignOut(listener: SignOutListener): () => void {
    return this.notifier.subscribe(listener);
  }

  getProviderToken(provider: string): Promise<ProviderToken | null> {
    return fetchProviderToken(this.fapiClient, provider);
  }

  /** Imperative `has()` — the same evaluation `*atlasProtect` renders on. */
  has(condition: ProtectCondition): boolean {
    return evaluate(this._claims.value, condition).allowed;
  }

  /**
   * Revoke the current session server-side and drop all local auth state.
   *
   * The session id is remembered before the revoke (a tombstone shared by every
   * tab), so a reload, a token refresh, a sibling tab or a tab opened later never
   * re-adopts it — even when the revoke failed (it is retried once, then again in
   * the background) and the refresh cookie is still valid. Resolves
   * `{ revoked, activeSessionId? }`; with `{ strict: true }` an unconfirmed revoke
   * rejects with a `SignOutError` instead (after the local sign-out). A parked
   * session the server promoted on revoke is adopted. Front-channel logout runs
   * unless `{ frontchannel: false }`.
   */
  async signOut(options: SignOutOptions = {}): Promise<SignOutResult> {
    // With no cached token the guard finds the cookie session itself
    // (GET /v1/client), so a missing JWT never skips the revoke.
    const sessionId = this.cache.peek()?.sessionId ?? this._session.value?.id ?? null;
    this.notifier.expect('user');
    const attempt = await this.guard.revoke(sessionId, options);
    this.clearLocalState('user');
    if (this.guard.promoted(attempt)) await this.reload();
    return this.guard.settle(attempt, options);
  }

  /**
   * Switch the active organization (or `null` for the personal account). The
   * new token carries the new org claims, so the app's permission checks update
   * without a re-login.
   */
  async setActiveOrganization(organizationId: string | null): Promise<void> {
    const current = this.cache.peek();
    if (!current) return;

    const response = await this.call(`/v1/client/sessions/${current.sessionId}/touch`, {
      method: 'POST',
      body: JSON.stringify({ active_organization_id: organizationId }),
    });
    if (!response.ok) return;

    const body = (await response.json()) as { jwt: string };
    this.applyToken(body.jwt, current.sessionId);
    await this.reload();
  }

  /** Re-read `/v1/client`: refresh user, session, memberships and status. */
  /** Re-boot from the Frontend API. Resolves true when a session now exists in this browser. */
  async reload(): Promise<boolean> {
    try {
      const response = await this.call('/v1/client');
      if (!response.ok) throw new Error('boot failed');

      const body = (await response.json()) as {
        session: AtlasSession | null;
        user: AtlasUser | null;
        jwt?: string;
        organization_memberships?: AtlasOrganizationMembership[];
      };

      // A session this browser signed out of is never re-adopted from the
      // refresh cookie; the guard re-tries its revoke in the background.
      if (!body.session || !body.user || this.guard.refuse(body.session.id)) {
        this.clearLocalState(body.session ? 'other_tab' : signOutReasonFromClient(body));
        return false;
      }
      this.notifier.clear();

      this._user.next(body.user);
      this._session.next(body.session);
      this._memberships.next(body.organization_memberships ?? []);
      if (body.jwt) this.applyToken(body.jwt, body.session.id);
      this._status.next('signed_in');
      this.scheduleRefresh();
      return true;
    } catch {
      // A failed boot is NOT signed-out. Rendering a sign-in form because the
      // network hiccuped throws away a perfectly good session and forces a
      // needless re-authentication. Only promote loading → signed_out.
      if (this._status.value === 'loading') this._status.next('signed_out');
      return false;
    }
  }

  // --- Internals --------------------------------------------------------------

  /**
   * §6.3 step 3: complete a redirect-based sign-in, then boot. An OAuth or
   * hosted-page flow lands back with a one-time ticket in the URL; exchange it
   * for cookies, scrub the URL so a reload cannot replay it, THEN read the
   * session. A redirect carrying only a status (a second factor is still owed)
   * has no ticket, so nothing is exchanged and the app boots signed-out.
   */
  private async boot(): Promise<void> {
    const fromUrl = readRedirectResult(window.location.search);
    let result: RedirectResult | null = fromUrl;

    // §oauth popup mode: this page may be the landing of a sign-in popup whose
    // opener a Cross-Origin-Opener-Policy severed (`#atlas_popup_result=…`).
    // The result is relayed to the opener, which redeems the ticket, and this
    // window closes. If no opener takes it (its tab is gone), finish here like
    // a redirect.
    const landing = await completeOAuthPopupLanding().catch(() => null);
    if (landing && !landing.delivered) {
      const outcome = mapOAuthPopupPayload(landing.payload);
      if (outcome?.ticket && outcome.attemptId) {
        result = { attemptId: outcome.attemptId, ticket: outcome.ticket };
      } else if (outcome?.continuationUrl) {
        // A second factor / connect step / provider error: the redirect flow's page.
        window.location.replace(outcome.continuationUrl);
        return;
      }
    }

    let exchanged = false;
    if (result?.ticket) {
      const response = await this.call('/v1/client/tickets/exchange', {
        method: 'POST',
        body: JSON.stringify({ attempt_id: result.attemptId, ticket: result.ticket }),
      }).catch(() => undefined);
      exchanged = !!response?.ok;
    }
    if (fromUrl) {
      window.history.replaceState({}, document.title, stripRedirectParams(window.location.href));
    }
    await this.reload();
    // Signed in inside the Atlas popup (the redirect flow ran in it): hand back
    // to the waiting opener and close. A no-op in an ordinary tab.
    if (exchanged) void closeOAuthPopupAfterSignIn();
  }

  private readPendingAttempt(): { id: string; status: string } | null {
    const result = readRedirectResult(window.location.search);
    return result?.status && !result.ticket
      ? { id: result.attemptId, status: result.status }
      : null;
  }

  private async call(path: string, init?: RequestInit): Promise<Response> {
    const response = await this.doFetch(`${this.baseUrl}${path}`, {
      ...init,
      // Cookies carry the session; a request without this is indistinguishable
      // from being signed out.
      credentials: 'include',
      headers: {
        'x-publishable-key': this.publishableKey,
        // Names this SDK so the Frontend API can flag a version with a known bug.
        [SDK_HEADER]: sdkHeaderValue(ATLAS_ANGULAR_SDK),
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
    reportSdkAdvisory(response, ATLAS_ANGULAR_SDK);
    return response;
  }

  private applyToken(jwt: string, sessionId: string): void {
    // An in-flight refresh must not resurrect a session signed out meanwhile.
    if (this.guard.isSignedOut(sessionId)) return;
    const expiresAt = readExpiry(jwt);
    if (!expiresAt) return;

    this.cache.set({ jwt, expiresAt, sessionId });
    this._claims.next(decodeClaims(jwt));
  }

  private async refresh(): Promise<void> {
    const current = this.cache.peek();
    if (!current) return;

    try {
      const response = await this.call(`/v1/client/sessions/${current.sessionId}/tokens`, {
        method: 'POST',
      });
      if (!response.ok) throw new Error('refresh failed');

      const body = (await response.json()) as { jwt: string; session_id: string };
      this.applyToken(body.jwt, body.session_id);
      this.scheduleRefresh();
    } catch {
      // The session may genuinely be gone. Re-boot rather than guess.
      await this.reload();
    }
  }

  private clearLocalState(reason?: SignOutReason): void {
    // A signed-in → signed-out transition tells the sign-out listeners why.
    const ended =
      this._status.value === 'signed_in'
        ? (this._session.value?.id ?? this.cache.peek()?.sessionId ?? null)
        : undefined;
    this.clearRefreshTimer();
    this.cache.clear();
    this._status.next('signed_out');
    this._user.next(null);
    this._session.next(null);
    this._claims.next(null);
    this._memberships.next([]);
    if (ended !== undefined) this.notifier.signedOut(ended, reason);
    else this.notifier.clear();
  }

  /** §7.4: proactive, jittered refresh scheduled from the token's own expiry. */
  private scheduleRefresh(): void {
    this.clearRefreshTimer();
    if (this._status.value !== 'signed_in') return;

    const token = this.cache.peek();
    if (!token) return;

    const delay = msUntilRefresh({ token, now: Date.now() });
    this.refreshTimer = setTimeout(() => void this.refresh(), delay);
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}

/** Decode a JWT payload without verifying it — a scheduling/UI hint only. */
function decodeClaims(jwt: string): SessionClaims | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(
      atob(parts[1]!.replace(/-/g, '+').replace(/_/g, '/')),
    ) as SessionClaims;
  } catch {
    return null;
  }
}
