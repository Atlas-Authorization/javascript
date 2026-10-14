/**
 * The native-session sign-in flow for Capacitor.
 *
 * The shape, end to end:
 *
 *   1. Mint a PKCE pair + `state`, build the first-party authorize URL.
 *   2. Open it in the SYSTEM browser (`@capacitor/browser`) — never an in-app
 *      WebView, so the user authenticates in a trusted, cookie-bearing context.
 *   3. The authorize response redirects to the app's custom-scheme `redirectUri`,
 *      which reopens the app; `@capacitor/app` fires `appUrlOpen` with that URL.
 *   4. Pull the `code` off the callback URL (after checking `state`), redeem it
 *      for a first-party OAuth access token (PKCE `authorization_code` grant).
 *   5. Trade that access token for a cookie-free Atlas SESSION via
 *      {@link exchangeForSession} from `@atlasauth/js`.
 *
 * On the WEB target there is no deep link, so the flow falls back to the STANDARD
 * redirect: it stashes the PKCE verifier + state and navigates the page to the
 * authorize URL. The app finishes on the next load with
 * {@link completeRedirectSignIn}, reading the stashed verifier.
 *
 * Every network step returns `null` — never throws — on failure, so a failed
 * sign-in is "re-run the flow", mirroring `@atlasauth/js`'s native-session.
 */

import { exchangeForSession, type NativeSession } from '@atlasauth/js';
import { createPkcePair, createState, type PkcePair } from './pkce';
import {
  isNativePlatform,
  type AppPlugin,
  type BrowserPlugin,
  type CapacitorGlobal,
  type PluginListenerHandle,
} from './plugins';
import type { TokenStore } from './token-store';

/** The default OAuth scopes requested for a first-party native sign-in. */
export const DEFAULT_SCOPE = 'openid profile email offline_access';

/** The storage key the transient PKCE material is stashed under on the web path. */
export const PKCE_STASH_KEY = 'atlas.capacitor.pkce';

export interface BuildAuthorizeUrlOptions {
  /** The instance's FAPI origin, e.g. `https://fapi.acme.atlasauth.net`. */
  frontendApi: string;
  /** The first-party native OAuth client id. */
  clientId: string;
  /** The app's custom-scheme callback, e.g. `com.acme.app://auth`. */
  redirectUri: string;
  /** base64url(SHA-256(verifier)). */
  codeChallenge: string;
  /** CSRF `state` echoed back on the callback. */
  state: string;
  /** Space-delimited scopes. @default {@link DEFAULT_SCOPE} */
  scope?: string;
}

/**
 * Build the first-party PKCE authorize URL hit at `{frontendApi}/oauth2/authorize`.
 * `response_type=code`, S256 challenge, space-delimited scopes.
 */
export function buildAuthorizeUrl(options: BuildAuthorizeUrlOptions): string {
  const url = new URL('/oauth2/authorize', options.frontendApi);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('scope', options.scope ?? DEFAULT_SCOPE);
  url.searchParams.set('state', options.state);
  url.searchParams.set('code_challenge', options.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/** The outcome of reading a deep-link / redirect callback URL. */
export type AuthCallback =
  | { code: string; error?: undefined }
  | { code?: undefined; error: string };

/**
 * Read an authorization callback URL. Returns the `code` when `state` matches the
 * value we sent, an `{ error }` when the server reported one (also state-checked),
 * or `null` when the URL is not our callback (a foreign deep link, or a state
 * mismatch) — the `appUrlOpen` listener fires for EVERY deep link, so a non-match
 * must be ignored, not treated as a failure.
 */
export function parseAuthCallback(rawUrl: string, expectedState: string): AuthCallback | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  // A custom-scheme URL may carry its params in the query OR the fragment.
  const params = url.searchParams;
  const state = params.get('state');
  if (state !== expectedState) return null;
  const error = params.get('error');
  if (error) return { error };
  const code = params.get('code');
  return code ? { code } : null;
}

export interface RedeemAuthorizationCodeOptions {
  frontendApi: string;
  clientId: string;
  redirectUri: string;
  /** The `code` from the callback URL. */
  code: string;
  /** The PKCE verifier that matches the challenge sent on the authorize URL. */
  codeVerifier: string;
  fetchImpl?: typeof fetch;
}

/**
 * Redeem an authorization code for a first-party OAuth access token via the PKCE
 * `authorization_code` grant at `{frontendApi}/oauth2/token`. Returns the access
 * token, or `null` — never throws — on a network failure, a non-2xx, or a body
 * with no `access_token`.
 */
export async function redeemAuthorizationCode(
  options: RedeemAuthorizationCodeOptions,
): Promise<string | null> {
  const doFetch = options.fetchImpl ?? fetch;
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    code: options.code,
    code_verifier: options.codeVerifier,
  });

  let response: Response;
  try {
    response = await doFetch(`${options.frontendApi}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  let body: { access_token?: unknown } | null = null;
  try {
    body = (await response.json()) as { access_token?: unknown };
  } catch {
    return null;
  }
  return body && typeof body.access_token === 'string' ? body.access_token : null;
}

/**
 * The flow tail shared by the native and web paths: redeem the code for an OAuth
 * access token, then {@link exchangeForSession} it for an Atlas {@link
 * NativeSession}. `null` at either step is `null` out — re-run the flow.
 */
export async function exchangeAuthCode(
  options: RedeemAuthorizationCodeOptions,
): Promise<NativeSession | null> {
  const accessToken = await redeemAuthorizationCode(options);
  if (!accessToken) return null;
  return exchangeForSession({
    baseUrl: options.frontendApi,
    clientId: options.clientId,
    accessToken,
    fetchImpl: options.fetchImpl,
  });
}

/** Resolve a listener handle whether `addListener` returned it or a promise of it. */
async function resolveHandle(
  handle: PluginListenerHandle | Promise<PluginListenerHandle>,
): Promise<PluginListenerHandle> {
  return await Promise.resolve(handle);
}

export interface SignInWithBrowserOptions {
  frontendApi: string;
  clientId: string;
  /** The app's custom-scheme callback, e.g. `com.acme.app://auth`. */
  redirectUri: string;
  scope?: string;

  // ── Injected collaborators (createAtlasCapacitor wires these) ──────────────
  /** `@capacitor/browser`'s `Browser`. Required on native. */
  browser: BrowserPlugin | null;
  /** `@capacitor/app`'s `App`. Required on native. */
  app: AppPlugin | null;
  /** `@capacitor/core`'s `Capacitor`, to decide native vs web. */
  capacitor: CapacitorGlobal | null;
  /** Where the transient PKCE material is stashed for the WEB redirect path. */
  pkceStore: TokenStore;
  fetchImpl?: typeof fetch;
  /** Navigate the page (web path). @default `window.location.assign` */
  navigate?: (url: string) => void;
  /** Injectable PKCE pair (tests). @default {@link createPkcePair} */
  makePkce?: () => Promise<PkcePair>;
  /** Injectable state (tests). @default {@link createState} */
  makeState?: () => string;
}

/**
 * The outcome of {@link signInWithBrowser}. On native it carries the completed
 * session; on the web redirect path it carries `pending: true` (the page is
 * navigating away — the app finishes with {@link completeRedirectSignIn} on the
 * next load), never a session.
 */
export type SignInOutcome =
  | { session: NativeSession; pending?: false }
  | { session: null; pending: true }
  | { session: null; pending?: false };

/**
 * Run the sign-in flow. On NATIVE: open the system browser, wait for the
 * `appUrlOpen` deep link, complete the exchange, resolve the session. On WEB:
 * stash the PKCE verifier + state and navigate to the authorize URL (standard
 * redirect) — resolves `{ session: null, pending: true }`, and the app completes
 * via {@link completeRedirectSignIn}.
 */
export async function signInWithBrowser(options: SignInWithBrowserOptions): Promise<SignInOutcome> {
  const makePkce = options.makePkce ?? createPkcePair;
  const makeState = options.makeState ?? createState;
  const pkce = await makePkce();
  const state = makeState();
  const authorizeUrl = buildAuthorizeUrl({
    frontendApi: options.frontendApi,
    clientId: options.clientId,
    redirectUri: options.redirectUri,
    codeChallenge: pkce.challenge,
    state,
    scope: options.scope,
  });

  const native = isNativePlatform({ Capacitor: options.capacitor });

  if (!native) {
    // Web: stash the verifier + state so the next page load can finish, then
    // navigate. The page is about to unload, so there is no session to return.
    await options.pkceStore.setToken(JSON.stringify({ verifier: pkce.verifier, state }));
    const navigate =
      options.navigate ??
      ((url: string) => {
        if (typeof window !== 'undefined') window.location.assign(url);
      });
    navigate(authorizeUrl);
    return { session: null, pending: true };
  }

  if (!options.browser || !options.app) {
    // Native target but a required plugin is missing — nothing to open.
    return { session: null };
  }
  const browser = options.browser;
  const app = options.app;

  // Register the deep-link listener BEFORE opening the browser, so a very fast
  // callback cannot race ahead of the handler.
  const code = await new Promise<string | null>((resolve) => {
    let settled = false;
    let handle: PluginListenerHandle | null = null;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      void handle?.remove();
      void browser.close?.();
      resolve(value);
    };
    void resolveHandle(
      app.addListener('appUrlOpen', (event) => {
        const parsed = parseAuthCallback(event.url, state);
        if (!parsed) return; // not our callback — ignore foreign deep links.
        finish(parsed.code ?? null);
      }),
    ).then((h) => {
      handle = h;
      // If the flow already finished during handle setup, drop the listener now.
      if (settled) void h.remove();
    });

    browser.open({ url: authorizeUrl }).catch(() => finish(null));
  });

  if (!code) return { session: null };

  const session = await exchangeAuthCode({
    frontendApi: options.frontendApi,
    clientId: options.clientId,
    redirectUri: options.redirectUri,
    code,
    codeVerifier: pkce.verifier,
    fetchImpl: options.fetchImpl,
  });
  return session ? { session } : { session: null };
}

export interface CompleteRedirectSignInOptions {
  frontendApi: string;
  clientId: string;
  redirectUri: string;
  /** The redirect URL the web app landed on (carries `code` + `state`). */
  url: string;
  /** The same store {@link signInWithBrowser} stashed the PKCE material in. */
  pkceStore: TokenStore;
  fetchImpl?: typeof fetch;
}

/**
 * Finish the WEB redirect flow. Reads the stashed PKCE verifier + state, checks
 * the callback URL against them, redeems + exchanges, and clears the stash.
 * Returns `null` when there is nothing to complete (no stash, not our callback,
 * or a failed exchange). Call it once on app load when the URL looks like a
 * callback.
 */
export async function completeRedirectSignIn(
  options: CompleteRedirectSignInOptions,
): Promise<NativeSession | null> {
  const raw = await options.pkceStore.getToken();
  if (!raw) return null;
  let stash: { verifier?: unknown; state?: unknown } | null = null;
  try {
    stash = JSON.parse(raw) as { verifier?: unknown; state?: unknown };
  } catch {
    return null;
  }
  if (!stash || typeof stash.verifier !== 'string' || typeof stash.state !== 'string') {
    return null;
  }

  const parsed = parseAuthCallback(options.url, stash.state);
  if (!parsed || !parsed.code) return null;

  const session = await exchangeAuthCode({
    frontendApi: options.frontendApi,
    clientId: options.clientId,
    redirectUri: options.redirectUri,
    code: parsed.code,
    codeVerifier: stash.verifier,
    fetchImpl: options.fetchImpl,
  });
  // Single-use: clear the stash whether or not the exchange succeeded.
  await options.pkceStore.clearToken();
  return session;
}
