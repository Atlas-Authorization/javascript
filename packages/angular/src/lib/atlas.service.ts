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
import { BehaviorSubject, Observable, combineLatest } from 'rxjs';
import { distinctUntilChanged, map } from 'rxjs/operators';
import {
  FapiClient,
  TokenCache,
  getProviderToken as fetchProviderToken,
  msUntilRefresh,
  readExpiry,
  readRedirectResult,
  stripRedirectParams,
  type ProviderToken,
} from '@atlasauth/js';
import { evaluate, type ProtectCondition } from '@atlasauth/authz';
import { ATLAS_OPTIONS } from './atlas.config';
import { cssVariables, resolveTokens, type Appearance } from './appearance';
import { EN_US, withFallback, type Catalog } from './i18n';
import type {
  AtlasOrganizationMembership,
  AtlasSession,
  AtlasUser,
  AuthStatus,
  SessionClaims,
} from './types';

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

  private readonly catalog: Catalog;

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
    this.baseUrl = options.frontendApi ?? '';
    this.doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

    this.catalog = options.localization ? withFallback(options.localization) : EN_US;

    this.fapiClient = new FapiClient({
      publishableKey: this.publishableKey,
      baseUrl: this.baseUrl,
      fetchImpl: this.doFetch,
    });

    // Captured synchronously (not in an async init) so it is available before any
    // flow component reads it: a needs_second_factor redirect carries a status but
    // no ticket, and that is what the 2FA resume seeds from.
    this.pendingAttempt = this.isBrowser ? this.readPendingAttempt() : null;

    // Boot once, browser only. On the server there is no cookie jar to read a
    // session from, so we leave the state at `loading` and let hydration boot it.
    if (this.isBrowser) {
      void this.boot();
    }
  }

  ngOnDestroy(): void {
    this.clearRefreshTimer();
    this._status.complete();
    this._user.complete();
    this._session.complete();
    this._claims.complete();
    this._memberships.complete();
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

  /** Tokens as CSS custom properties, for a host element to inherit. */
  appearanceVariables(): Record<string, string> {
    return cssVariables(resolveTokens(this.options.appearance));
  }

  /** A fresh {@link FapiClient} for driving a sign-in/sign-up flow. */
  createFapiClient(): FapiClient {
    return new FapiClient({ publishableKey: this.publishableKey, baseUrl: this.baseUrl });
  }

  // --- Imperative API (mirrors the React hooks' actions) ----------------------

  /**
   * The current session's JWT, always fresh: if the cached token is within 5s of
   * expiry it is refreshed first rather than handed over. Null when signed out.
   */
  async getToken(): Promise<string | null> {
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
  getProviderToken(provider: string): Promise<ProviderToken | null> {
    return fetchProviderToken(this.fapiClient, provider);
  }

  /** Imperative `has()` — the same evaluation `*atlasProtect` renders on. */
  has(condition: ProtectCondition): boolean {
    return evaluate(this._claims.value, condition).allowed;
  }

  /** Revoke the current session server-side and drop all local auth state. */
  async signOut(): Promise<void> {
    const current = this.cache.peek();
    if (current) {
      await this.call(`/v1/client/sessions/${current.sessionId}/revoke`, {
        method: 'POST',
      }).catch(() => undefined);
    }
    this.clearRefreshTimer();
    this.cache.clear();
    this._status.next('signed_out');
    this._user.next(null);
    this._session.next(null);
    this._claims.next(null);
    this._memberships.next([]);
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
  async reload(): Promise<void> {
    try {
      const response = await this.call('/v1/client');
      if (!response.ok) throw new Error('boot failed');

      const body = (await response.json()) as {
        session: AtlasSession | null;
        user: AtlasUser | null;
        jwt?: string;
        organization_memberships?: AtlasOrganizationMembership[];
      };

      if (!body.session || !body.user) {
        this.clearRefreshTimer();
        this.cache.clear();
        this._status.next('signed_out');
        this._user.next(null);
        this._session.next(null);
        this._claims.next(null);
        this._memberships.next([]);
        return;
      }

      this._user.next(body.user);
      this._session.next(body.session);
      this._memberships.next(body.organization_memberships ?? []);
      if (body.jwt) this.applyToken(body.jwt, body.session.id);
      this._status.next('signed_in');
      this.scheduleRefresh();
    } catch {
      // A failed boot is NOT signed-out. Rendering a sign-in form because the
      // network hiccuped throws away a perfectly good session and forces a
      // needless re-authentication. Only promote loading → signed_out.
      if (this._status.value === 'loading') this._status.next('signed_out');
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
    const result = readRedirectResult(window.location.search);

    if (result?.ticket) {
      await this.call('/v1/client/tickets/exchange', {
        method: 'POST',
        body: JSON.stringify({ attempt_id: result.attemptId, ticket: result.ticket }),
      }).catch(() => undefined);
    }
    if (result) {
      window.history.replaceState({}, document.title, stripRedirectParams(window.location.href));
    }
    await this.reload();
  }

  private readPendingAttempt(): { id: string; status: string } | null {
    const result = readRedirectResult(window.location.search);
    return result?.status && !result.ticket
      ? { id: result.attemptId, status: result.status }
      : null;
  }

  private call(path: string, init?: RequestInit): Promise<Response> {
    return this.doFetch(`${this.baseUrl}${path}`, {
      ...init,
      // Cookies carry the session; a request without this is indistinguishable
      // from being signed out.
      credentials: 'include',
      headers: {
        'x-publishable-key': this.publishableKey,
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  }

  private applyToken(jwt: string, sessionId: string): void {
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
