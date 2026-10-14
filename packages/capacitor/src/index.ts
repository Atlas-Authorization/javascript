/**
 * `@atlasauth/capacitor` — the Atlas SDK for Capacitor / Ionic.
 *
 * A Capacitor app is a web layer (WebView on iOS/Android, a real browser on the
 * web target) with no cookie against the Atlas FAPI origin, so it cannot carry a
 * session the way a web page does. This package gives it the NATIVE-session flow
 * instead: sign in through the SYSTEM browser, catch the deep-link callback,
 * complete PKCE, trade the code for a cookie-free Atlas session, and keep that
 * session live — auto-refreshing the short-lived JWT and persisting each rotated
 * refresh token into secure storage. It is the Capacitor sibling of
 * `@atlasauth/electron` and `@atlasauth/expo`, wrapping the very same
 * `@atlasauth/js` `NativeSessionManager` / `exchangeForSession` /
 * `refreshNativeSession` core.
 *
 * The one call an app makes is {@link createAtlasCapacitor}; everything else here
 * (the sign-in flow, the token store, the PKCE helpers) is exposed for apps that
 * want to drive the pieces themselves.
 */

import { resolveFrontendApi, type NativeSession, type NativeSessionManager } from '@atlasauth/js';
import {
  isNativePlatform,
  loadCapacitorPlugins,
  type CapacitorPlugins,
} from './plugins';
import {
  completeRedirectSignIn,
  signInWithBrowser,
  PKCE_STASH_KEY,
  type SignInOutcome,
} from './sign-in';
import {
  createInMemoryTokenStore,
  createPreferencesTokenStore,
  DEFAULT_SESSION_KEY,
  type TokenStore,
} from './token-store';
import { clearNativeSession, createNativeSessionManager } from './native-session';

export interface CreateAtlasCapacitorConfig {
  /** The instance publishable key (`pk_…`). */
  publishableKey: string;
  /** The instance's FAPI origin, e.g. `https://fapi.acme.atlasauth.net`. */
  frontendApi: string;
  /** The first-party native OAuth client id. Required to {@link AtlasCapacitor.signIn}. */
  clientId?: string;
  /** The app's custom-scheme callback, e.g. `com.acme.app://auth`. A {@link AtlasCapacitor.signIn} default. */
  redirectUri?: string;
  /** Space-delimited OAuth scopes. A {@link AtlasCapacitor.signIn} default. */
  scope?: string;
  /**
   * Where the rotated session is persisted. Defaults to a `@capacitor/preferences`
   * store when the plugin is present, else a NON-persistent in-memory store. Ship
   * a secure-storage-backed {@link TokenStore} in production — Preferences is
   * plaintext at rest.
   */
  storage?: TokenStore;
  /** Where the transient PKCE material is stashed on the WEB redirect path. */
  pkceStore?: TokenStore;
  /** Inject the Capacitor plugins (tests). Defaults to a lazy, guarded load. */
  plugins?: CapacitorPlugins;
  /** Injectable for tests; defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable clock, epoch ms. Defaults to `Date.now`. */
  now?: () => number;
  /** Navigate the page on the web redirect path. @default `window.location.assign` */
  navigate?: (url: string) => void;
}

/** Per-call overrides for {@link AtlasCapacitor.signIn}. */
export interface SignInOptions {
  clientId?: string;
  redirectUri?: string;
  scope?: string;
}

/**
 * The Atlas handle a Capacitor app holds. Wraps the `@atlasauth/js`
 * {@link NativeSessionManager}: {@link signIn} runs the browser flow and seeds
 * the manager, {@link getToken} hands out a live (auto-refreshing) JWT, and
 * {@link onChange} fires on every session change.
 */
export interface AtlasCapacitor {
  /**
   * Run the native-session sign-in: open the system browser, catch the deep-link
   * callback, complete PKCE, exchange for a session, and store it. On the web
   * target it falls back to the standard redirect (navigates away, `pending:
   * true`) — finish with {@link handleRedirectCallback} on the next load.
   */
  signIn(options?: SignInOptions): Promise<SignInOutcome>;
  /**
   * Finish a WEB redirect sign-in on app load: read the callback `url` (defaults
   * to `window.location.href`), complete PKCE, store the session, and return it
   * (or null when there is nothing to complete).
   */
  handleRedirectCallback(url?: string): Promise<NativeSession | null>;
  /** Forget the session and clear the store (sign-out). */
  signOut(): Promise<void>;
  /** The current session JWT, auto-refreshed near expiry; null when signed out. */
  getToken(): Promise<string | null>;
  /** The headers an authenticated `/v1/client/me/*` call needs (bearer + pk). */
  authHeaders(): Promise<Record<string, string>>;
  /** The current session, or null when signed out. Does NOT refresh. */
  getSession(): NativeSession | null;
  /** Register a listener fired with the session on every change; returns unsubscribe. */
  onChange(listener: (session: NativeSession) => void): () => void;
  /** The underlying `@atlasauth/js` manager, for advanced use. */
  readonly manager: NativeSessionManager;
}

/**
 * Create the Atlas handle for a Capacitor app.
 *
 * Async because it lazily loads the Capacitor plugins and rehydrates the session
 * manager from the store, so a returning user is signed in before the first
 * request. Call it once at startup and keep the result.
 *
 * ```ts
 * import { createAtlasCapacitor } from '@atlasauth/capacitor';
 *
 * const atlas = await createAtlasCapacitor({
 *   publishableKey: 'pk_live_…',
 *   frontendApi: 'https://fapi.acme.atlasauth.net',
 *   clientId: 'client_…',
 *   redirectUri: 'com.acme.app://auth',
 * });
 * await atlas.signIn();
 * const token = await atlas.getToken();
 * ```
 */
export async function createAtlasCapacitor(
  config: CreateAtlasCapacitorConfig,
): Promise<AtlasCapacitor> {
  // Validated (and normalised — no trailing slash) before anything else: a
  // missing value, "same-origin" or a bare path throws an `AtlasConfigError`.
  // The OAuth URLs below are built from it, and a native app has no origin of
  // its own to resolve a relative one against.
  const frontendApi = resolveFrontendApi(config.frontendApi, {
    component: 'createAtlasCapacitor()',
    allowSameOrigin: false,
  });
  const plugins = config.plugins ?? (await loadCapacitorPlugins());

  const storage =
    config.storage ??
    (plugins.Preferences
      ? createPreferencesTokenStore(plugins.Preferences, DEFAULT_SESSION_KEY)
      : createInMemoryTokenStore());

  const pkceStore =
    config.pkceStore ??
    (plugins.Preferences
      ? createPreferencesTokenStore(plugins.Preferences, PKCE_STASH_KEY)
      : createInMemoryTokenStore());

  const manager = await createNativeSessionManager({
    frontendApi,
    publishableKey: config.publishableKey,
    clientId: config.clientId,
    storage,
    fetchImpl: config.fetchImpl,
    now: config.now,
  });

  const requireString = (value: string | undefined, name: string): string => {
    if (!value) throw new Error(`Atlas: \`${name}\` is required to sign in.`);
    return value;
  };

  return {
    manager,

    async signIn(options = {}) {
      const clientId = requireString(options.clientId ?? config.clientId, 'clientId');
      const redirectUri = requireString(options.redirectUri ?? config.redirectUri, 'redirectUri');
      const outcome = await signInWithBrowser({
        frontendApi,
        clientId,
        redirectUri,
        scope: options.scope ?? config.scope,
        browser: plugins.Browser,
        app: plugins.App,
        capacitor: plugins.Capacitor,
        pkceStore,
        fetchImpl: config.fetchImpl,
        navigate: config.navigate,
      });
      if (outcome.session) manager.setSession(outcome.session);
      return outcome;
    },

    async handleRedirectCallback(url) {
      // Only meaningful on the web redirect path; a native target never lands here.
      if (isNativePlatform({ Capacitor: plugins.Capacitor })) return null;
      const landingUrl =
        url ?? (typeof window !== 'undefined' ? window.location.href : undefined);
      if (!landingUrl) return null;
      const clientId = requireString(config.clientId, 'clientId');
      const redirectUri = requireString(config.redirectUri, 'redirectUri');
      const session = await completeRedirectSignIn({
        frontendApi,
        clientId,
        redirectUri,
        url: landingUrl,
        pkceStore,
        fetchImpl: config.fetchImpl,
      });
      if (session) manager.setSession(session);
      return session;
    },

    async signOut() {
      manager.clear();
      await clearNativeSession(storage);
    },

    getToken() {
      return manager.getToken();
    },

    authHeaders() {
      return manager.authHeaders();
    },

    getSession() {
      return manager.current;
    },

    onChange(listener) {
      return manager.onChange(listener);
    },
  };
}

// ── Re-exports: the pieces, for apps that drive the flow themselves ──────────
export * from './plugins';
export * from './pkce';
export * from './token-store';
export * from './sign-in';
export {
  createNativeSessionManager,
  clearNativeSession,
  NativeSessionManager,
  exchangeForSession,
  refreshNativeSession,
  type NativeSession,
  type NativeSessionConfig,
} from './native-session';
