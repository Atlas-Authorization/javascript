/**
 * Sign in from a browser extension with `chrome.identity.launchWebAuthFlow`.
 *
 * The extension is a PUBLIC, first-party OAuth client of the Atlas instance.
 * The whole sign-in runs on the instance's own pages (every method the instance
 * offers: password, passkeys, Google and the other social connections, MFA), in
 * the browser's auth window, and comes back to the extension's redirect URL:
 *
 *   1. PKCE S256 + `state`, then `launchWebAuthFlow` on `{frontendApi}/oauth2/authorize`
 *      with `redirect_uri = chrome.identity.getRedirectURL()`
 *      (`https://<extension-id>.chromiumapp.org/`, registered EXACTLY on the client).
 *   2. The returned URL must carry our `state`; its `code` is redeemed at
 *      `/oauth2/token` with the verifier.
 *   3. The OAuth access token is traded for a real Atlas SESSION (RFC 8693
 *      token exchange, first-party clients only): a session JWT your backend
 *      verifies with the instance JWKS, plus a rotating refresh token.
 *   4. The session goes into a {@link NativeSessionManager} persisted in
 *      `chrome.storage`, which refreshes it on demand.
 *
 * Silent sign-in (`interactive: false`): the authorize request adds `prompt=none`. If the browser already holds a session on the
 * instance's Frontend API host, Atlas skips every page (a first-party client has no consent screen) and redirects with a code, so
 * the flow completes with no window. If it does not, Atlas redirects to the extension with `error=login_required`, which
 * becomes an {@link AtlasWebAuthFlowError} with code `login_required`. With `interactive: true` the same session also lets the
 * authorize step finish without asking for anything; Chrome only shows the window when a page has to be displayed.
 *
 * Firefox's `browser.identity` has the same two calls; its redirect URL is
 * `https://<hash>.extensions.allizom.org/`. Firefox for Android has no `identity` API at all: when only `tabs` exists, the flow
 * runs in a browser tab ({@link createTabIdentity}) and returns to the same redirect URL.
 */

import { exchangeForSession, resolveFrontendApi, type NativeSessionManager } from '@atlasauth/js';
import { createNativeSessionManager } from './native-session';
import type { TokenStore } from './storage';

/** The slice of `chrome.identity` (or Firefox's `browser.identity`) this flow uses. */
export interface ChromeIdentity {
  getRedirectURL(path?: string): string | Promise<string>;
  launchWebAuthFlow(details: { url: string; interactive?: boolean }): Promise<string | undefined>;
}

/** Why {@link signInWithWebAuthFlow} failed. */
export type WebAuthFlowErrorCode =
  /** Neither `identity` nor `tabs` is available (missing `"identity"` / `"tabs"` permission, or not an extension). */
  | 'identity_unavailable'
  /** The user closed the window. */
  | 'cancelled'
  /** A silent sign-in on the tab fallback (no `browser.identity`) did not come back in 20 seconds, or `silentTabFlow: false` turned it off. Sign in with `interactive: true`. */
  | 'silent_unsupported'
  /** `interactive: false` and the browser has no usable instance session (Atlas answered `login_required`), or the window could not open silently. Sign in with `interactive: true`. */
  | 'login_required'
  /** `interactive: false` and the sign-in needs the user (`interaction_required`, `consent_required`, `account_selection_required`). Sign in with `interactive: true`. */
  | 'interaction_required'
  /** The returned URL was not the answer to this request (wrong redirect or `state`). */
  | 'state_mismatch'
  /** The instance answered with an OAuth error (`error` from the redirect, e.g. `access_denied`). */
  | 'authorization_error'
  /** The code could not be redeemed at `/oauth2/token`. */
  | 'token_error'
  /** The access token could not be exchanged for a session (is the client first-party?). */
  | 'session_exchange_failed';

export class AtlasWebAuthFlowError extends Error {
  constructor(
    readonly code: WebAuthFlowErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AtlasWebAuthFlowError';
  }
}

export interface WebAuthFlowOptions {
  /** The instance's FAPI origin, e.g. `https://fapi.acme.atlasauth.net`. */
  frontendApi: string;
  publishableKey: string;
  /** The extension's OAuth client id: public (`token_endpoint_auth_method: none`) and first-party. */
  clientId: string;
  /** Space-delimited scopes. @default `openid profile email` */
  scope?: string;
  /** @default `identity.getRedirectURL()` — register exactly this on the client. */
  redirectUri?: string;
  /**
   * `false` is a silent sign-in: the request carries `prompt=none`, so Atlas never shows a page. With an instance session in
   * the browser it returns the code straight away; without one it fails fast with `login_required` (or `interaction_required`).
   * @default true
   */
  interactive?: boolean;
  /** Extra authorize parameters, e.g. `{ prompt: 'login', login_hint: 'a@example.com' }`. */
  authorizeParams?: Record<string, string>;
  /** Where the session is persisted (see {@link createNativeSessionManager}). */
  store?: TokenStore;
  /** @default `chrome.identity`, else `browser.identity` */
  identity?: ChromeIdentity;
  /**
   * Only on the tab fallback (no `identity` API, e.g. Firefox for Android): `false` makes `interactive: false` throw
   * `silent_unsupported` at once instead of opening an inactive tab.
   * @default true
   */
  silentTabFlow?: boolean;
  fetchImpl?: typeof fetch;
}

const base64url = (bytes: Uint8Array): string => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const random = (n: number): string => {
  const raw = new Uint8Array(n);
  crypto.getRandomValues(raw);
  return base64url(raw);
};

interface Ext {
  identity?: ChromeIdentity;
  tabs?: TabsApi;
  runtime?: { id?: string };
}
const ext = (): { chrome?: Ext; browser?: Ext } => globalThis as { chrome?: Ext; browser?: Ext };

function defaultIdentity(): ChromeIdentity | undefined {
  return ext().chrome?.identity ?? ext().browser?.identity;
}

interface Evt<A extends unknown[]> {
  addListener(fn: (...args: A) => void): void;
  removeListener(fn: (...args: A) => void): void;
}
/** The slice of `tabs` the tab fallback uses. */
export interface TabsApi {
  create(props: { url: string; active?: boolean }): Promise<{ id?: number }>;
  remove(tabId: number): Promise<void> | void;
  onUpdated: Evt<[number, { url?: string }, { url?: string }]>;
  onRemoved: Evt<[number]>;
}

/** Firefox's redirect URL for an add-on id: `https://<sha1 hex of the id>.extensions.allizom.org/` (desktop and Android). */
export async function firefoxRedirectUrl(addonId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(addonId)));
  return `https://${Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')}.extensions.allizom.org/`;
}

const SILENT_TIMEOUT_MS = 20_000;
const INTERACTIVE_TIMEOUT_MS = 10 * 60_000;

/**
 * An identity built on `tabs`, for browsers with no `identity` API (Firefox for Android). The sign-in opens in a tab and
 * resolves with the first navigation of THAT tab to the redirect URL, then closes the tab. Needs the `tabs` permission.
 */
export function createTabIdentity(tabs: TabsApi, runtimeId: string, options: { silentTabFlow?: boolean } = {}): ChromeIdentity {
  return {
    getRedirectURL: () => firefoxRedirectUrl(runtimeId),
    async launchWebAuthFlow({ url, interactive = true }) {
      if (!interactive && options.silentTabFlow === false) {
        throw new AtlasWebAuthFlowError('silent_unsupported', 'Silent sign-in is turned off on the tab flow (silentTabFlow: false).');
      }
      const target = new URL(await firefoxRedirectUrl(runtimeId));
      const isRedirect = (u?: string): u is string => {
        if (!u) return false;
        try {
          const parsed = new URL(u);
          return parsed.origin === target.origin && parsed.pathname.startsWith(target.pathname);
        } catch {
          return false;
        }
      };
      let tabId: number | undefined;
      let finish: (r: { url: string } | { error: AtlasWebAuthFlowError }) => void = () => {};
      const done = new Promise<{ url: string } | { error: AtlasWebAuthFlowError }>((resolve) => (finish = resolve));
      // A redirect can arrive before tabs.create resolves with the tab's id: keep it and match it once the id is known.
      const early: Array<{ id: number; url: string }> = [];
      const onUpdated = (id: number, change: { url?: string }, tab: { url?: string }) => {
        const hit = [change.url, tab?.url].find(isRedirect);
        if (!hit) return;
        if (tabId === undefined) early.push({ id, url: hit });
        else if (id === tabId) finish({ url: hit });
      };
      const onRemoved = (id: number) => {
        if (tabId !== undefined && id === tabId) {
          tabId = undefined; // already gone: nothing to remove
          finish({ error: new AtlasWebAuthFlowError('cancelled', 'The sign-in tab was closed.') });
        }
      };
      const timer = setTimeout(
        () =>
          finish({
            error: interactive
              ? new AtlasWebAuthFlowError('cancelled', 'The sign-in timed out.')
              : new AtlasWebAuthFlowError('silent_unsupported', 'The silent sign-in did not return in time. Sign in with interactive: true.'),
          }),
        interactive ? INTERACTIVE_TIMEOUT_MS : SILENT_TIMEOUT_MS,
      );
      tabs.onUpdated.addListener(onUpdated);
      tabs.onRemoved.addListener(onRemoved);
      try {
        const tab = await tabs.create({ url, active: interactive });
        tabId = tab.id;
        const seen = early.find((e) => e.id === tabId);
        if (seen) finish({ url: seen.url });
        const result = await done;
        if ('error' in result) throw result.error;
        return result.url;
      } finally {
        clearTimeout(timer);
        tabs.onUpdated.removeListener(onUpdated);
        tabs.onRemoved.removeListener(onRemoved);
        if (tabId !== undefined) {
          try {
            await tabs.remove(tabId);
          } catch {
            // already closed
          }
        }
      }
    },
  };
}

function fallbackIdentity(silentTabFlow: boolean | undefined): ChromeIdentity | undefined {
  const tabs = ext().browser?.tabs ?? ext().chrome?.tabs;
  const id = ext().browser?.runtime?.id ?? ext().chrome?.runtime?.id;
  return tabs && id ? createTabIdentity(tabs, id, { silentTabFlow }) : undefined;
}

/**
 * Run the sign-in and return a {@link NativeSessionManager} holding the new,
 * persisted session: `await manager.getToken()` is the session JWT for your
 * backend (`Authorization: Bearer …`), refreshed when it is about to expire.
 * Throws {@link AtlasWebAuthFlowError} on any failure; nothing is stored then.
 */
export async function signInWithWebAuthFlow(options: WebAuthFlowOptions): Promise<NativeSessionManager> {
  const identity = options.identity ?? defaultIdentity() ?? fallbackIdentity(options.silentTabFlow);
  if (!identity) {
    throw new AtlasWebAuthFlowError('identity_unavailable', 'chrome.identity and browser.tabs are unavailable: add "identity" (or, on Firefox for Android, "tabs") to the manifest permissions.');
  }
  const baseUrl = resolveFrontendApi(options.frontendApi, { component: 'signInWithWebAuthFlow()', allowSameOrigin: false });
  const redirectUri = options.redirectUri ?? await identity.getRedirectURL();
  const fetchImpl = options.fetchImpl ?? fetch;

  const verifier = random(32);
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = random(16);

  const authorize = new URL(`${baseUrl}/oauth2/authorize`);
  for (const [k, v] of Object.entries(options.authorizeParams ?? {})) authorize.searchParams.set(k, v);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', options.clientId);
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('scope', options.scope ?? 'openid profile email');
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('code_challenge_method', 'S256');
  // Silent sign-in: Atlas answers login_required / interaction_required to the redirect URI instead of showing a page.
  const interactive = options.interactive ?? true;
  if (!interactive) authorize.searchParams.set('prompt', 'none');

  let returned: string | undefined;
  try {
    returned = await identity.launchWebAuthFlow({ url: authorize.toString(), interactive });
  } catch (error) {
    if (error instanceof AtlasWebAuthFlowError) throw error;
    // A silent flow the browser could not complete without a window is "no session", not a closed window.
    throw new AtlasWebAuthFlowError(interactive ? 'cancelled' : 'login_required', error instanceof Error && error.message ? error.message : 'The sign-in window was closed.');
  }
  if (!returned) throw new AtlasWebAuthFlowError(interactive ? 'cancelled' : 'login_required', interactive ? 'The sign-in window was closed.' : 'There is no instance session in this browser.');

  // Only the answer to THIS request counts: our redirect URI, our state.
  let callback: URL;
  try {
    callback = new URL(returned);
  } catch {
    throw new AtlasWebAuthFlowError('state_mismatch', 'The sign-in returned an unreadable URL.');
  }
  const expected = new URL(redirectUri);
  if (callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.searchParams.get('state') !== state) {
    throw new AtlasWebAuthFlowError('state_mismatch', 'The sign-in returned to an unexpected URL or with the wrong state.');
  }
  const oauthError = callback.searchParams.get('error');
  if (oauthError) {
    if (!interactive && oauthError === 'login_required') {
      throw new AtlasWebAuthFlowError('login_required', 'There is no instance session in this browser. Sign in with interactive: true.');
    }
    if (!interactive && (oauthError === 'interaction_required' || oauthError === 'consent_required' || oauthError === 'account_selection_required')) {
      throw new AtlasWebAuthFlowError('interaction_required', `${oauthError}: the sign-in needs the user. Sign in with interactive: true.`);
    }
    const description = callback.searchParams.get('error_description');
    throw new AtlasWebAuthFlowError('authorization_error', description ? `${oauthError}: ${description}` : oauthError);
  }
  const code = callback.searchParams.get('code');
  if (!code) throw new AtlasWebAuthFlowError('authorization_error', 'The sign-in returned no authorization code.');

  let accessToken: unknown;
  try {
    const res = await fetchImpl(`${baseUrl}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: options.clientId,
        redirect_uri: redirectUri,
        code,
        code_verifier: verifier,
      }).toString(),
    });
    const body = (await res.json().catch(() => null)) as { access_token?: unknown; error?: unknown; error_description?: unknown } | null;
    if (!res.ok) {
      throw new AtlasWebAuthFlowError('token_error', `Token request failed (${res.status}${typeof body?.error === 'string' ? ` ${body.error}` : ''})${typeof body?.error_description === 'string' ? `: ${body.error_description}` : ''}.`);
    }
    accessToken = body?.access_token;
  } catch (error) {
    if (error instanceof AtlasWebAuthFlowError) throw error;
    throw new AtlasWebAuthFlowError('token_error', 'The token request could not be sent.');
  }
  if (typeof accessToken !== 'string') throw new AtlasWebAuthFlowError('token_error', 'The token response had no access_token.');

  const session = await exchangeForSession({ baseUrl, clientId: options.clientId, accessToken, fetchImpl });
  if (!session) {
    throw new AtlasWebAuthFlowError('session_exchange_failed', 'The access token could not be exchanged for a session. The OAuth client must be first-party.');
  }

  const manager = await createNativeSessionManager({
    frontendApi: baseUrl,
    publishableKey: options.publishableKey,
    clientId: options.clientId,
    ...(options.store ? { store: options.store } : {}),
    fetchImpl,
  });
  manager.setSession(session);
  return manager;
}
