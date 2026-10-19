'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  FapiClient,
  SessionTombstones,
  catalogLocale,
  SignOutError,
  TokenCache,
  bestChannel,
  getProviderToken as fetchProviderToken,
  msUntilRefresh,
  readExpiry,
  readRedirectResult,
  completeOAuthPopupLanding,
  closeOAuthPopupAfterSignIn,
  mapOAuthPopupPayload,
  type RedirectResult,
  resolveFrontendApi,
  revokeSession,
  stripRedirectParams,
  type Channel,
  type ProviderToken,
  type RevokeSessionOutcome,
  type SignOutOptions,
  type SignOutResult,
  type TombstoneStore,
  type AtlasInitialState,
  runFrontChannelLogoutFromResponse,
  SDK_HEADER,
  SignOutNotifier,
  getTemplateToken,
  reportSdkAdvisory,
  sdkHeaderValue,
  signOutReasonFromClient,
  type SignOutEvent,
  type SignOutListener,
} from '@atlasauth/js';
import { ATLAS_REACT_SDK } from './version';
import { resolveLocale, type SupportedLocale } from '@atlasauth/localizations';
import {
  classFor,
  instanceDesignFrom,
  renderAppearance,
  type Appearance,
  type InstanceDesign,
} from './appearance';
import { ATLAS_STYLES_CSS, ATLAS_STYLE_ELEMENT_ID } from './styles';
import { EN_US, withFallback, type Catalog } from './i18n';
import { instanceSettingsFrom, type InstanceSettings } from './instance-settings';
import type {
  AtlasOrganizationMembership,
  AtlasSession,
  AtlasSessionResource,
  AtlasUser,
  SessionClaims,
} from './types';

/**
 * §10.1 `<AtlasProvider publishableKey>`.
 *
 * Holds exactly one thing that matters: the token, in memory. Not
 * localStorage, not a cookie this code writes — the refresh token is HttpOnly
 * so browser script never touches it, and the short-lived JWT lives only as
 * long as the tab. A provider that persisted either would survive the tab and
 * become the thing an XSS reads first.
 */

export type AuthStatus = 'loading' | 'signed_in' | 'signed_out';

interface AtlasContextValue {
  publishableKey: string;
  frontendApi: string;
  status: AuthStatus;
  user: AtlasUser | null;
  session: AtlasSession | null;
  /**
   * §L1 every account signed in on this browser (multi-session), active first.
   * A single-session client is a one-element list. Surfaced by `useSessionList`.
   */
  sessions: AtlasSessionResource[];
  claims: SessionClaims | null;
  memberships: AtlasOrganizationMembership[];
  appearance?: Appearance;
  /**
   * The instance's public sign-in / sign-up settings (per-flow captcha, sign-up
   * fields, legal consent) from `GET /v1/appearance`. Null until loaded, or when
   * the server could not be reached — the components then fall back to their
   * defaults and the server still enforces every gate.
   */
  instanceSettings: InstanceSettings | null;
  /**
   * The raw `GET /v1/client/environment` body (sign-in methods, social buttons),
   * or null until loaded. Seeded from `initialState` when the server fetched it.
   */
  environment: unknown;
  /** The raw `GET /v1/appearance` body, or null until loaded (seeded from `initialState`). */
  appearanceData: unknown;
  /**
   * Fetch the client environment once for the whole provider and share it: the
   * social buttons and the Google button read the same response instead of each
   * requesting it. Resolves null when the server can't be reached.
   */
  loadEnvironment(): Promise<unknown>;
  /** §oauth popup mode — app-wide default for social/OIDC sign-in (see AtlasProviderProps). */
  oauthMode?: 'popup' | 'redirect';
  catalog: Catalog;
  /**
   * The language layer of `catalog` — the `locale` bundle plus `localization`,
   * WITHOUT the English defaults underneath (en-US itself when neither is set).
   * Server errors are looked up here (`error.<reason>`), so a key the app's
   * language lacks falls back to the server's own (localised) message rather
   * than to an English catalog string.
   */
  errorCatalog?: Catalog;
  /**
   * The tag sent to the Frontend API as `Accept-Language`: the `locale` prop,
   * else the `locale` a `localization` bundle declares. Undefined sends none.
   */
  locale?: string;
  /**
   * §5.3: a sign-in attempt handed back by an OAuth redirect that still needs a
   * second factor (no session was issued). Null in the ordinary case. The
   * <SignIn> flow seeds itself from this so the user resumes at the 2FA step
   * instead of starting over.
   */
  pendingAttempt: { id: string; status: string } | null;
  /**
   * The session JWT, or with `{ template }` a short-lived token from a named JWT
   * template (e.g. `'chatly'` for a support-chat identity). Null when signed out
   * or the template does not exist.
   */
  getToken(options?: { template?: string }): Promise<string | null>;
  /**
   * Listen for sign-out on every path (this tab, another tab, session expiry,
   * a session ended elsewhere detected on the next refresh). Returns the
   * unsubscribe. `<AtlasProvider onSignOut>` and `useSignOutListener` wrap it.
   */
  addSignOutListener(listener: SignOutListener): () => void;
  /**
   * §6.6 the signed-in user's OWN live token at a connected provider (Google,
   * GitHub, …), so the app can call that provider's API. Null when there is no
   * usable token — no linked account, or the provider granted / kept none. The
   * server refreshes a stale token on read; the refresh token is never exposed.
   */
  getProviderToken(provider: string): Promise<ProviderToken | null>;
  /**
   * Sign out of the active session: revoke it on the Frontend API (retried
   * once), run front-channel logout, drop local state and sign sibling tabs out.
   *
   * Resolves `{ revoked, activeSessionId? }`. `revoked: false` means the server
   * could not confirm the revoke; the user is still signed out locally and this
   * browser never re-adopts that session. `activeSessionId` is set when another
   * account signed in on this browser was promoted (multi-session) — the
   * provider adopts it. With `{ strict: true }` a failed revoke rejects with a
   * `SignOutError` (after the local sign-out).
   */
  signOut(options?: SignOutOptions): Promise<SignOutResult>;
  /**
   * Tell other tabs of this app that auth changed here, so they re-check.
   * `reload()` deliberately does not do this (a received signal must not loop);
   * call it after completing a sign-in yourself.
   */
  broadcastSessionChange(): void;
  setActiveOrganization(organizationId: string | null): Promise<void>;
  /**
   * §L1 switch which signed-in account is active on this browser (Clerk
   * `setActive({ session })`). Accepts a session id or a session resource from
   * `useSessionList()`. Re-boots the client and nudges other tabs.
   */
  setActiveSession(session: string | { id: string }): Promise<void>;
  reload(): Promise<void>;
}

const AtlasContext = createContext<AtlasContextValue | null>(null);

/** §R3.2 the cross-tab "auth changed here, re-check" signal. Carries no token —
 *  a receiving tab re-boots from the shared cookies, never from the channel. */
const SESSION_SIGNAL = 'atlas:session';

/** The cross-tab signal. `signedOut` carries session ids (never tokens) a tab
 *  signed out of, so siblings refuse to re-adopt them on their re-check. */
interface SessionSignal {
  type: typeof SESSION_SIGNAL;
  signedOut?: string[];
}

export interface AtlasProviderProps {
  publishableKey: string;
  /**
   * The instance's Frontend API origin — REQUIRED.
   *
   * The publishable key is `pk_(live|test)_<instanceId>`: it encodes the
   * instance id (sent as the `x-publishable-key` header on every request) but
   * NOT a host, so the FAPI origin cannot be derived from the key. An unclaimed
   * instance has no per-instance subdomain provisioned either, so synthesising
   * `https://<instanceId>.atlasauth.net` would point at a host that does not
   * resolve. The origin is therefore passed explicitly:
   *   - on the hosted fleet, before you verify a custom domain, the shared host
   *     `https://atlasauth.net` (FAPI resolves the instance from the key);
   *   - once a custom domain is verified, that host, e.g. `https://auth.acme.com`;
   *   - `"same-origin"` (or a path such as `"/atlas"`) for a reverse-proxy setup
   *     where you serve FAPI under your own origin (requests then go to
   *     relative paths).
   *
   * `""` is the deprecated same-origin spelling: it still works, with a
   * one-time console warning. Missing or malformed values throw an `AtlasConfigError`
   * (`code: 'FRONTEND_API_REQUIRED'` / `'FRONTEND_API_INVALID'`) when the
   * provider renders, instead of silently sending requests to the app's own
   * origin. Plain `http:` is accepted only for localhost and local development
   * hosts.
   */
  frontendApi: string;
  appearance?: Appearance;
  /**
   * The UI language, as a BCP-47 tag: `"en"`, `"en-US"`, `"es"`, `"es-ES"`,
   * `"fr"`, `"fr-FR"`, `"de"`, `"de-DE"`, `"pt-BR"`, `"ja"`, `"nl"`, … A region
   * the catalogs don't have falls back to its language (`"es-MX"` → Spanish);
   * an unknown language falls back to English. Defaults to English.
   */
  locale?: SupportedLocale | (string & {});
  /**
   * String overrides, key by key (`{ 'signIn.title': 'Welcome back' }`), or a
   * whole bundle from `@atlasauth/localizations`. Applied on top of `locale`.
   */
  localization?: Catalog;
  /**
   * §oauth popup mode — the app-wide default for social/OIDC sign-in. `"popup"`
   * completes in a GSI-style popup (no page navigation), auto-falling back to a
   * redirect when the popup is blocked. A `<SignIn oauthMode>` overrides it per
   * mount. Defaults to `"redirect"`.
   */
  oauthMode?: 'popup' | 'redirect';
  /**
   * Fires ONCE when a user goes from signed-out to signed-in — the reliable
   * "sign-in completed" hook, including right after a popup handoff (where the
   * opener re-boots via a session reload). Does NOT fire on a page load that
   * boots already-signed-in from a cached session, so it's safe for one-time
   * actions (redirect, toast, analytics).
   */
  onSignedIn?: (user: AtlasUser) => void;
  /**
   * Fires ONCE when a signed-in user becomes signed out, whatever the path:
   * `reason` is `user` (this tab signed out), `other_tab`, `session_expired`,
   * `revoked` (ended elsewhere: another device, an admin, a ban — detected on
   * the next token refresh, within the token lifetime) or `unknown`. The place
   * to reset embedded third parties (a chat widget, a docs reader session).
   * Not fired on a page load that boots signed out. The same event is also
   * dispatched on `window` as `atlas:signout`.
   */
  onSignOut?: (event: SignOutEvent) => void;
  children: ReactNode;
  fetchImpl?: typeof fetch;
  /**
   * Where to keep the ids of sessions this app signed out of, for a runtime
   * without `localStorage` (React Native / Expo, Electron's main process, an
   * extension service worker). A two-method adapter over the platform's
   * persistent store (`getItem` / `setItem`, sync or async). Without it the
   * tombstones live in `localStorage` per Frontend API (memory only where there
   * is none, so an app restart could re-adopt a session whose revoke failed).
   * Read once, on first render.
   */
  tombstoneStore?: TombstoneStore;
  /**
   * The instance's public sign-in data, fetched on the server with
   * `fetchAtlasInitialState()` (or `getAtlasInitialState()` from
   * `@atlasauth/nextjs/server`). With it the panel renders fully styled, with its
   * social buttons, in the server HTML, and the browser skips those requests.
   * Without it everything is fetched in the browser, as before.
   */
  initialState?: AtlasInitialState;
}

export function AtlasProvider(props: AtlasProviderProps) {
  const { publishableKey, children, appearance, localization, locale } = props;
  // What the Frontend API is told the UI language is, so its error messages
  // match the components'.
  const requestLocale = locale ?? catalogLocale(localization);
  // Throws an AtlasConfigError at render for a missing/malformed value — the
  // old silent `?? ''` fallback sent every request to the app's own origin.
  const baseUrl = useMemo(
    () => resolveFrontendApi(props.frontendApi, { component: '<AtlasProvider>' }),
    [props.frontendApi],
  );
  const doFetch = props.fetchImpl ?? fetch;

  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AtlasUser | null>(null);
  const [session, setSession] = useState<AtlasSession | null>(null);
  const [sessions, setSessions] = useState<AtlasSessionResource[]>([]);
  const [claims, setClaims] = useState<SessionClaims | null>(null);
  const [memberships, setMemberships] = useState<AtlasOrganizationMembership[]>([]);
  // Filled from GET /v1/appearance (see the effect beside the dashboard design).
  // Read once: a server-fetched `initialState` seeds the first render, so the
  // server HTML and the hydrating client agree, and the browser skips the fetch.
  const [initial] = useState(() => props.initialState ?? {});
  const [instanceSettings, setInstanceSettings] = useState<InstanceSettings | null>(() =>
    initial.appearance ? instanceSettingsFrom(initial.appearance) : null,
  );
  const [environment, setEnvironment] = useState<unknown>(initial.environment ?? null);
  const [appearanceData, setAppearanceData] = useState<unknown>(initial.appearance ?? null);

  const cache = useRef(new TokenCache());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // §R3.2 cross-tab session channel + refs the tab-propagation effect reads
  // without re-subscribing on every render.
  const channel = useRef<Channel | null>(null);
  const statusRef = useRef<AuthStatus>('loading');
  const reloadRef = useRef<() => Promise<void>>(() => Promise.resolve());
  // Sessions this browser signed out of (shared by every tab, per Frontend
  // API): never re-adopted from a still-valid refresh cookie, even when the
  // revoke did not reach the server — not by a reload, nor by a tab opened later.
  const tombstones = useRef<SessionTombstones | null>(null);
  if (!tombstones.current) {
    tombstones.current = new SessionTombstones({
      frontendApi: baseUrl,
      ...(props.tombstoneStore ? { store: props.tombstoneStore } : {}),
    });
  }
  const sessionIdRef = useRef<string | null>(null);
  // ATL-S-30 sign-out events: one notifier per provider; reasons are hinted by
  // the code path that is about to sign the tab out, and fired on the
  // signed_in → signed_out transition below.
  const notifier = useRef<SignOutNotifier | null>(null);
  if (!notifier.current) notifier.current = new SignOutNotifier();

  /**
   * Captured synchronously during the first render (not in an effect) so it is
   * already in context before <SignIn> reads it — a needs_second_factor redirect
   * carries a status but no ticket, and that is what the 2FA resume seeds from.
   */
  const [pendingAttempt] = useState<{ id: string; status: string } | null>(() => {
    if (typeof window === 'undefined') return null;
    const result = readRedirectResult(window.location.search);
    return result?.status && !result.ticket
      ? { id: result.attemptId, status: result.status }
      : null;
  });

  const call = useCallback(
    async (path: string, init?: RequestInit) => {
      const response = await doFetch(`${baseUrl}${path}`, {
        ...init,
        // Cookies carry the session; a fetch without this looks identical to
        // being signed out.
        credentials: 'include',
        headers: {
          'x-publishable-key': publishableKey,
          // Names this SDK so the Frontend API can flag a version with a known bug.
          [SDK_HEADER]: sdkHeaderValue(ATLAS_REACT_SDK),
          ...(init?.body ? { 'content-type': 'application/json' } : {}),
          ...init?.headers,
        },
      });
      reportSdkAdvisory(response, ATLAS_REACT_SDK);
      return response;
    },
    [baseUrl, doFetch, publishableKey],
  );

  const applyToken = useCallback((jwt: string, sessionId: string) => {
    // A refresh that was in flight when the user signed out must not put the
    // signed-out session's token back.
    if (tombstones.current?.has(sessionId)) return;
    const expiresAt = readExpiry(jwt);
    if (!expiresAt) return;

    cache.current.set({ jwt, expiresAt, sessionId });
    setClaims(decodeClaims(jwt));
  }, []);

  const reload = useCallback(async () => {
    try {
      // A custom tombstone store may answer asynchronously: never decide whether
      // to adopt a session before it has (settled at once for localStorage).
      await tombstones.current?.ready;
      const response = await call('/v1/client');
      if (!response.ok) throw new Error('boot failed');

      const body = (await response.json()) as {
        session: AtlasSession | null;
        sessions?: AtlasSessionResource[];
        user: AtlasUser | null;
        jwt?: string;
        organization_memberships?: AtlasOrganizationMembership[];
      };

      const tombstoned = body.session ? tombstones.current?.has(body.session.id) : false;
      if (tombstoned && body.session) {
        // The browser still holds a refresh cookie for a session this tab signed
        // out of (the revoke never landed). Stay signed out, and try the revoke
        // again in the background — when it lands the server clears the cookies
        // (or promotes a parked account, which the next re-check adopts), and
        // the tombstone has done its job.
        const staleId = body.session.id;
        void revokeSession(call, staleId, { retries: 0 }).then((outcome) => {
          if (outcome.revoked) tombstones.current?.remove(staleId);
        });
      }

      if (!body.session || !body.user || tombstoned) {
        // Why we are signed out, when we were signed in: a path that already
        // said (this tab, another tab) wins; otherwise the server's reason.
        if (sessionIdRef.current) {
          notifier.current?.expect(tombstoned ? 'other_tab' : signOutReasonFromClient(body));
        }
        sessionIdRef.current = null;
        cache.current.clear();
        setStatus('signed_out');
        setUser(null);
        setSession(null);
        setSessions([]);
        setClaims(null);
        setMemberships([]);
        return;
      }

      sessionIdRef.current = body.session.id;
      // Still (or newly) signed in: a hint from a signal that did not sign us
      // out must not be reported by a later, unrelated sign-out.
      notifier.current?.clear();
      setUser(body.user);
      setSession(body.session);
      // §L1 the multi-session list, active first. Older servers omit it; fall
      // back to a one-element list built from the active session + user.
      setSessions(
        body.sessions ?? [
          {
            object: 'session',
            id: body.session.id,
            status: body.session.status,
            last_active_organization_id: body.session.last_active_organization_id,
            user: body.user,
          },
        ],
      );
      setMemberships(body.organization_memberships ?? []);
      if (body.jwt) applyToken(body.jwt, body.session.id);
      setStatus('signed_in');
    } catch {
      /**
       * A failed boot is NOT signed-out. Rendering a sign-in form because the
       * network hiccuped throws away a perfectly good session and makes the
       * user re-authenticate for no reason.
       */
      setStatus((current) => (current === 'loading' ? 'signed_out' : current));
    }
  }, [applyToken, call]);

  const refresh = useCallback(async () => {
    const current = cache.current.peek();
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
  }, [applyToken, call, reload]);

  /** §7.4: proactive, jittered refresh scheduled from the token's own expiry. */
  useEffect(() => {
    if (status !== 'signed_in') return;
    const token = cache.current.peek();
    if (!token) return;

    const delay = msUntilRefresh({ token, now: Date.now() });
    timer.current = setTimeout(() => void refresh(), delay);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [status, claims, refresh]);

  /** §R3.2 tell sibling tabs that auth changed here, so they re-check. */
  const announceSessionChange = useCallback((signedOut?: string[]) => {
    const message: SessionSignal = signedOut?.length
      ? { type: SESSION_SIGNAL, signedOut }
      : { type: SESSION_SIGNAL };
    channel.current?.post(message);
  }, []);
  const broadcastSessionChange = useCallback(() => announceSessionChange(), [announceSessionChange]);

  // Keep refs current for the once-mounted tab-propagation effect below, so it
  // reads live `status`/`reload` without re-subscribing every render.
  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);

  /**
   * §R3.2 cross-tab + on-focus session propagation — THE stranded-tab fix.
   *
   * A redirect sign-in (or one that completes in a popup/new tab, like the
   * Google button's fallback) leaves the tab that STARTED it sitting on the
   * sign-in form, because nothing tells it a session now exists. Two signals
   * close that gap:
   *   - a BroadcastChannel (with a localStorage fallback) message that a
   *     signing-in/out tab posts, which sibling tabs answer by re-booting from
   *     the shared cookies;
   *   - a visibility/focus listener, so a tab the user simply returns to
   *     re-checks even when no channel is available (Safari private mode) or the
   *     message was missed. It re-checks only when NOT already signed in, so a
   *     focused signed-in tab never reloads on every alt-tab.
   *
   * `reload()` never broadcasts, so a received signal cannot loop.
   */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const ch = bestChannel('atlas-session');
    channel.current = ch;
    const unsub = ch?.subscribe((msg) => {
      const signal = msg as Partial<SessionSignal> | null;
      if (signal?.type !== SESSION_SIGNAL) return;
      // Learn the sessions a sibling signed out of BEFORE re-checking, so this
      // tab cannot re-adopt one from a refresh cookie the revoke did not clear.
      if (Array.isArray(signal.signedOut)) {
        const ids = signal.signedOut.filter((id): id is string => typeof id === 'string');
        tombstones.current?.add(...ids);
        if (sessionIdRef.current && ids.includes(sessionIdRef.current)) {
          notifier.current?.expect('other_tab');
          cache.current.clear();
        }
      }
      void reloadRef.current();
    });
    // Another tab signed out of THIS session (its tombstone reached the shared
    // store before, or without, its broadcast): drop the token and re-check.
    const unsubTombstones = tombstones.current?.subscribe((ids) => {
      if (sessionIdRef.current && ids.includes(sessionIdRef.current)) {
        notifier.current?.expect('other_tab');
        cache.current.clear();
        void reloadRef.current();
      }
    });
    const onVisible = () => {
      if (document.visibilityState === 'visible' && statusRef.current !== 'signed_in') {
        void reloadRef.current();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      unsub?.();
      unsubTombstones?.();
      ch?.close();
      channel.current = null;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);

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
  useEffect(() => {
    const fromUrl =
      typeof window !== 'undefined' ? readRedirectResult(window.location.search) : null;

    void (async () => {
      let result: RedirectResult | null = fromUrl;
      const landing = typeof window !== 'undefined' ? await completeOAuthPopupLanding().catch(() => null) : null;
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
      // §R3.2 if this was the tab that completed a sign-in, wake any sibling tab
      // (e.g. the one that opened the Google window) so it leaves the form too.
      if (result?.ticket) announceSessionChange();
      // Signed in inside the Atlas popup: hand back to the opener and close.
      if (exchanged) void closeOAuthPopupAfterSignIn();
    })();
    // Runs once on mount (empty deps): the redirect is handled exactly once, and
    // re-running would only re-read an already-scrubbed URL. `reload`/`call` are
    // stable across renders.
  }, []);

  const getToken = useCallback(
    async (options?: { template?: string }) => {
      if (options?.template) {
        // A named-template token for the current session; minted fresh (never
        // cached): it is short-lived and usually handed to a third party once.
        const sessionId = cache.current.peek()?.sessionId ?? sessionIdRef.current;
        if (!sessionId) return null;
        return (await getTemplateToken(fapiClientRef.current!, sessionId, options.template))?.jwt ?? null;
      }
      // A 5s skew so a token that would die inside the caller's request is
      // refreshed first rather than handed over.
      const usable = cache.current.get(5_000);
      if (usable) return usable.jwt;

      await refresh();
      return cache.current.get(5_000)?.jwt ?? null;
    },
    [refresh],
  );

  /**
   * The FAPI client for the token-vault read. Reuses the exact same
   * credentials-and-publishable-key request `call` makes, so the browser sends
   * one consistent shape and the framework-agnostic `@atlasauth/js` helper is the
   * single implementation the React SDK surfaces.
   */
  const fapiClient = useMemo(
    () => new FapiClient({ publishableKey, baseUrl, fetchImpl: doFetch, locale: requestLocale, sdk: ATLAS_REACT_SDK }),
    [publishableKey, baseUrl, doFetch, requestLocale],
  );
  const fapiClientRef = useRef(fapiClient);
  fapiClientRef.current = fapiClient;

  const getProviderToken = useCallback(
    (provider: string) => fetchProviderToken(fapiClient, provider),
    [fapiClient],
  );

  const signOut = useCallback(
    async (options?: SignOutOptions): Promise<SignOutResult> => {
      // The session to end: from the token cache, else the booted session, else
      // (no state yet — e.g. called before boot finished) whatever session the
      // browser's cookies carry. The revoke route works from the cookies, so a
      // missing in-memory token never skips the server-side sign-out.
      let sessionId = cache.current.peek()?.sessionId ?? sessionIdRef.current;
      let outcome: RevokeSessionOutcome = { revoked: true, status: 200 };
      if (!sessionId) {
        try {
          const response = await call('/v1/client');
          if (!response.ok) throw new Error('boot failed');
          const body = (await response.json()) as { session?: { id?: string } | null };
          sessionId = body.session?.id ?? null;
        } catch {
          outcome = { revoked: false, status: 0 };
        }
      }
      notifier.current?.expect('user');
      if (sessionId) {
        // Remember it first: from here on nothing in this tab may re-adopt it.
        tombstones.current?.add(sessionId);
        outcome = await revokeSession(call, sessionId);
        // OIDC Front-Channel Logout: let the apps signed in through this session
        // clear theirs in this browser (hidden iframes, capped at 5 s). Best-effort.
        if (options?.frontchannel !== false) await runFrontChannelLogoutFromResponse(outcome.response);
      }

      sessionIdRef.current = null;
      cache.current.clear();
      setStatus('signed_out');
      setUser(null);
      setSession(null);
      setSessions([]);
      setClaims(null);
      setMemberships([]);

      // §L1 the server promoted another account signed in on this browser: adopt
      // it deliberately (the revoke response already set its cookies).
      if (outcome.activeSessionId && !tombstones.current?.has(outcome.activeSessionId)) {
        await reload();
      }

      // §R3.2 sign every sibling tab out too, so a shared device doesn't leave a
      // live-looking session in another tab after the user signed out here.
      announceSessionChange(sessionId ? [sessionId] : undefined);

      if (!outcome.revoked && options?.strict) {
        throw new SignOutError(sessionId ?? '', outcome.status);
      }
      return outcome.activeSessionId
        ? { revoked: outcome.revoked, activeSessionId: outcome.activeSessionId }
        : { revoked: outcome.revoked };
    },
    [announceSessionChange, call, reload],
  );

  const setActiveOrganization = useCallback(
    async (organizationId: string | null) => {
      const current = cache.current.peek();
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
      // §R3.2 the active org is session state other tabs reflect — nudge them.
      announceSessionChange();
    },
    [announceSessionChange, applyToken, call, reload],
  );

  const setActiveSession = useCallback(
    async (target: string | { id: string }) => {
      const id = typeof target === 'string' ? target : target.id;
      const response = await call(`/v1/client/sessions/${id}/set_active`, { method: 'POST' });
      if (!response.ok) return;
      const body = (await response.json()) as { jwt?: string; id?: string };
      // The response mints the newly-active session's JWT; apply it before the
      // re-boot so an immediate getToken() already reflects the switch.
      if (body.jwt && body.id) applyToken(body.jwt, body.id);
      await reload();
      // §R3.2 the active account is session state other tabs reflect — nudge them.
      announceSessionChange();
    },
    [announceSessionChange, applyToken, call, reload],
  );

  const catalog = useMemo(() => {
    // A built-in language bundle, then the app's own overrides key by key.
    const base = locale ? resolveLocale(locale) : undefined;
    if (locale && !base) warnUnknownLocale(locale);
    if (!base && !localization) return EN_US;
    return withFallback({ ...(base as unknown as Catalog | undefined), ...localization });
  }, [locale, localization]);

  const errorCatalog = useMemo<Catalog>(() => {
    const base = locale ? resolveLocale(locale) : undefined;
    if (!locale && !localization) return EN_US;
    return { ...(base as unknown as Catalog | undefined), ...localization };
  }, [locale, localization]);

  // §onSignedIn: fire once on a genuine signed_out → signed_in transition (a NEW
  // sign-in, including the post-popup re-boot), never on a cached-boot load. Uses
  // a ref for the callback so a new function identity each render can't re-fire it.
  const onSignedInRef = useRef(props.onSignedIn);
  onSignedInRef.current = props.onSignedIn;
  const prevStatusRef = useRef<AuthStatus>('loading');
  // ATL-S-30 the session that was signed in, for the sign-out event.
  const lastSessionRef = useRef<string | null>(null);
  useEffect(() => {
    const was = prevStatusRef.current;
    prevStatusRef.current = status;
    if (was === 'signed_out' && status === 'signed_in' && user) {
      onSignedInRef.current?.(user);
    }
    if (status === 'signed_in') lastSessionRef.current = session?.id ?? lastSessionRef.current;
    if (was === 'signed_in' && status === 'signed_out') {
      const ended = lastSessionRef.current;
      lastSessionRef.current = null;
      notifier.current?.signedOut(ended);
    }
  }, [status, user, session]);

  // `<AtlasProvider onSignOut>`: through a ref, so a new function each render
  // neither re-subscribes nor fires twice.
  const onSignOutRef = useRef(props.onSignOut);
  onSignOutRef.current = props.onSignOut;
  useEffect(() => notifier.current!.subscribe((event) => onSignOutRef.current?.(event)), []);
  const addSignOutListener = useCallback(
    (listener: SignOutListener) => notifier.current!.subscribe(listener),
    [],
  );

  const environmentRequest = useRef<Promise<unknown> | null>(
    initial.environment ? Promise.resolve(initial.environment) : null,
  );
  const loadEnvironment = useCallback((): Promise<unknown> => {
    if (!environmentRequest.current) {
      environmentRequest.current = call('/v1/client/environment')
        .then(async (response) => (response.ok ? ((await response.json()) as unknown) : null))
        .catch(() => null)
        .then((body) => {
          // A failure is not cached, so a later mount can try again.
          if (body) setEnvironment(body);
          else environmentRequest.current = null;
          return body;
        });
    }
    return environmentRequest.current;
  }, [call]);

  const value = useMemo<AtlasContextValue>(
    () => ({
      publishableKey,
      frontendApi: baseUrl,
      oauthMode: props.oauthMode,
      status,
      user,
      session,
      sessions,
      claims,
      memberships,
      appearance,
      instanceSettings,
      environment,
      appearanceData,
      loadEnvironment,
      catalog,
      errorCatalog,
      locale: requestLocale,
      pendingAttempt,
      getToken,
      addSignOutListener,
      getProviderToken,
      signOut,
      broadcastSessionChange,
      setActiveOrganization,
      setActiveSession,
      reload,
    }),
    [
      appearance,
      instanceSettings,
      environment,
      appearanceData,
      loadEnvironment,
      baseUrl,
      broadcastSessionChange,
      publishableKey,
      props.oauthMode,
      catalog,
      errorCatalog,
      requestLocale,
      claims,
      getToken,
      addSignOutListener,
      getProviderToken,
      memberships,
      pendingAttempt,
      reload,
      session,
      sessions,
      setActiveOrganization,
      setActiveSession,
      signOut,
      status,
      user,
    ],
  );

  /**
   * The design configured in the Atlas dashboard, from `GET /v1/appearance`.
   * Best-effort: a failure (older server, network) leaves it null and the
   * components render exactly as before. Skipped when the app opted out.
   */
  const wantsInstanceDesign = appearance?.instanceDesign !== false;
  const [instanceDesign, setInstanceDesign] = useState<InstanceDesign | null>(() =>
    initial.appearance && wantsInstanceDesign ? instanceDesignFrom(initial.appearance) : null,
  );
  useEffect(() => {
    // Already in hand from the server: nothing to fetch.
    if (initial.appearance) return;
    let alive = true;
    void (async () => {
      try {
        const response = await call('/v1/appearance');
        if (!response.ok) return;
        const body: unknown = await response.json();
        if (!alive) return;
        // The sign-in / sign-up settings (captcha, fields, consent) are read even
        // when the app opted out of the dashboard DESIGN: they are behaviour, not
        // styling, and the server enforces them either way.
        setAppearanceData(body);
        setInstanceSettings(instanceSettingsFrom(body));
        if (wantsInstanceDesign) setInstanceDesign(instanceDesignFrom(body));
      } catch {
        // No dashboard design / default settings are the safe fallback.
      }
    })();
    return () => {
      alive = false;
    };
  }, [call, wantsInstanceDesign, initial]);

  const rendered = useMemo(
    () => renderAppearance(appearance, instanceDesign, { frontendApi: baseUrl }),
    [appearance, instanceDesign, baseUrl],
  );
  const style = rendered.style as React.CSSProperties;

  return (
    <AtlasContext.Provider value={value}>
      {/*
        §10.3 base component styles, rendered in the provider's own output so
        they are present in the SERVER HTML (no SSR flash of unstyled content)
        AND on the client — the prebuilt components are styled on first paint
        with no stylesheet import. Rendering it (rather than a client-only
        effect) is what makes SSR zero-FOUC. `.atlas-root`-scoped + token-driven,
        so customer CSS / appearance.elements still layer on top. A stable id
        lets `injectAtlasStyles()` (exported for manual use) no-op when present.
      */}
      <style id={ATLAS_STYLE_ELEMENT_ID} dangerouslySetInnerHTML={{ __html: ATLAS_STYLES_CSS }} />
      {/*
        The design stylesheet: custom properties only, compiled client-side from
        validated settings (never the raw text of a prop or a response), scoped
        to `.atlas-root[data-atlas-design="<key>"]` so two providers with
        different designs cannot collide. Rendered in the provider's output like
        the base styles, so a code-level preset/design is in the SERVER HTML.
      */}
      {rendered.css ? (
        <style data-atlas-design={rendered.key} dangerouslySetInnerHTML={{ __html: rendered.css }} />
      ) : null}
      {/*
        Connection hints, in the server HTML: open the connection to the Frontend
        API early, and start downloading Google's sign-in script before the
        component asks for it when the instance uses native Google sign-in.
      */}
      <link rel="preconnect" href={baseUrl} crossOrigin="use-credentials" />
      {usesNativeGoogleEnv(environment) ? <link rel="preload" as="script" href={GSI_SCRIPT_URL} /> : null}
      {rendered.fontStylesheets.map((href) => (
        <link key={href} rel="stylesheet" href={href} data-atlas-font="" />
      ))}
      {/* Tokens land as CSS variables on a host-DOM element — no iframe. */}
      <div
        {...rendered.attributes}
        className={classFor('root', appearance, 'atlas-root')}
        style={style}
      >
        {children}
      </div>
    </AtlasContext.Provider>
  );
}

export function useAtlas(): AtlasContextValue {
  const value = useContext(AtlasContext);
  if (!value) {
    /**
     * A thrown error rather than a null-ish default. A hook returning
     * `{ user: null }` outside the provider is indistinguishable from a
     * signed-out user, and the developer spends an afternoon on it.
     */
    throw new Error('Atlas hooks must be used inside <AtlasProvider>.');
  }
  return value;
}

const warnedLocales = new Set<string>();
function warnUnknownLocale(locale: string): void {
  if (warnedLocales.has(locale) || typeof console === 'undefined') return;
  warnedLocales.add(locale);
  console.warn(`[Atlas] No built-in strings for locale "${locale}"; falling back to English.`);
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

const GSI_SCRIPT_URL = 'https://accounts.google.com/gsi/client';

/** Whether the environment lists Google as a native (GSI) provider with a client id. */
function usesNativeGoogleEnv(environment: unknown): boolean {
  const providers = (environment as { social_providers?: unknown } | null)?.social_providers;
  if (!Array.isArray(providers)) return false;
  return providers.some((p) => {
    const entry = p as { provider?: unknown; native?: unknown; mode?: unknown; client_id?: unknown; allow_sign_in?: unknown } | null;
    return (
      entry?.provider === 'google' &&
      entry.native === true &&
      entry.mode !== 'redirect' &&
      entry.allow_sign_in !== false &&
      typeof entry.client_id === 'string' &&
      entry.client_id !== ''
    );
  });
}
