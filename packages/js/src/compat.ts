import { journeyRedirectFrom } from './journey-redirect';
/**
 * `@atlasauth/js/compat` — a drop-in for `@auth0/auth0-spa-js` on Atlas, for
 * framework-free browser apps (what `atlas migrate code --from auth0` rewrites
 * `createAuth0Client` / `new Auth0Client` onto).
 *
 * The client keeps auth0-spa-js's method names and result shapes —
 * `loginWithRedirect`, `handleRedirectCallback`, `isAuthenticated`, `getUser`,
 * `getTokenSilently`, `logout`, … — on top of the Atlas Frontend API: the session
 * lives in Atlas's own cookies, sign-in happens on your instance's hosted pages
 * (or straight at a social provider when `authorizationParams.connection` is
 * given), and tokens are Atlas session tokens. Move call sites to the native
 * `@atlasauth/js` APIs at your own pace.
 */
import {
  FapiClient,
  getAtlasIdIntegrationToken,
  getIntegrationToken,
  getTemplateToken,
  type DpopProofSigner,
  type IntegrationAudienceOptions,
} from './fapi';
import { readRedirectResult, startOauthPopup, startOauthRedirect, stripRedirectParams } from './redirect';
import { revokeSession } from './sign-out';
import { withDevBrowser } from './dev-browser';

export interface Auth0CompatClientOptions {
  /** The instance publishable key. `clientId` is accepted as an alias. */
  publishableKey?: string;
  /** The instance's Frontend API origin (`https://auth.example.com`). `domain` is accepted as an alias. */
  frontendApi?: string;
  /** auth0-spa-js names, accepted so existing option objects keep working. */
  clientId?: string;
  domain?: string;
  authorizationParams?: { redirect_uri?: string; [key: string]: unknown };
  /** Where sign-in happens (default: the instance's hosted page, `<frontendApi>/hosted/sign-in`). */
  signInUrl?: string;
  /** Where sign-up happens (default `<frontendApi>/hosted/sign-up`), used for `screen_hint: 'signup'`. */
  signUpUrl?: string;
  fetchImpl?: typeof fetch;
  [option: string]: unknown;
}

/** The OIDC-profile user auth0-spa-js's `getUser()` returns. */
export interface Auth0CompatUser {
  sub: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  nickname?: string;
  picture?: string;
  email?: string;
  email_verified?: boolean;
  [claim: string]: unknown;
}

export interface Auth0CompatRedirectOptions {
  appState?: unknown;
  authorizationParams?: {
    /** A social provider to go straight to (`github`, `google-oauth2`, …). */
    connection?: string;
    redirect_uri?: string;
    /** `signup` opens the sign-up page. */
    screen_hint?: string;
    [key: string]: unknown;
  };
  /** Called with the URL instead of navigating (auth0-spa-js `openUrl`). */
  openUrl?: (url: string) => void | Promise<void>;
}

export interface Auth0CompatLogoutOptions {
  logoutParams?: { returnTo?: string; [key: string]: unknown };
  /** `false` signs out without navigating; a function receives the URL instead. */
  openUrl?: false | ((url: string) => void | Promise<void>);
}

export interface Auth0CompatTokenOptions extends IntegrationAudienceOptions {
  /** `'off'` always mints a fresh token. */
  cacheMode?: 'on' | 'off' | 'cache-only';
  /** Resolve `{ access_token, id_token, expires_in }` instead of the token string. */
  detailedResponse?: boolean;
  /** An Atlas JWT template name, for a named-template token. */
  template?: string;
  /** An identity integration id (a preset such as `chatly`, or a custom one), for its integration token. */
  for?: string;
  /**
   * With `for`: the Sign in with Atlas access token of a user who is not on
   * this instance. The integration token is minted for that user instead of the
   * session (no session is needed).
   */
  atlasIdAccessToken?: string;
  /** With `atlasIdAccessToken`: a DPoP proof signer, for a DPoP-bound access token. */
  dpop?: DpopProofSigner;
  authorizationParams?: Record<string, unknown>;
}

/** The per-call audience fields of a token request. */
const audienceOf = (o: IntegrationAudienceOptions): IntegrationAudienceOptions => ({
  ...(o.audience ? { audience: o.audience } : {}),
  ...(o.cbid ? { cbid: o.cbid } : {}),
  ...(o.audienceParams ? { audienceParams: o.audienceParams } : {}),
});

/** auth0-spa-js-style errors: `error` carries the OAuth-ish code apps branch on. */
export class Auth0CompatError extends Error {
  constructor(
    readonly error: 'login_required' | 'popup_closed' | 'popup_blocked' | 'timeout' | 'missing_transaction' | 'start_failed',
    message: string,
  ) {
    super(message);
    this.name = 'Auth0CompatError';
  }
}

interface AtlasClientBody {
  session: { id: string } | null;
  user: {
    id: string;
    first_name: string | null;
    last_name: string | null;
    username: string | null;
    image_url: string | null;
    email_addresses?: Array<{ email_address: string; verified: boolean; primary: boolean }>;
  } | null;
  jwt?: string;
}

/** Auth0 connection names → Atlas provider keys (others pass through). */
const CONNECTIONS: Record<string, string> = {
  'google-oauth2': 'google',
  windowslive: 'microsoft',
  'microsoft-account': 'microsoft',
  github: 'github',
  apple: 'apple',
  facebook: 'facebook',
  linkedin: 'linkedin',
  twitter: 'twitter',
  discord: 'discord',
  gitlab: 'gitlab',
  bitbucket: 'bitbucket',
};

const APP_STATE_KEY = 'atlas:compat:appState';

/** Decode a JWT's payload (no verification: it came from our own FAPI). */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const part = jwt.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    const json = decodeURIComponent(
      Array.from(atob(b64), (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''),
    );
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Project the Frontend API user onto the OIDC profile shape. */
export function auth0UserFromClient(user: AtlasClientBody['user']): Auth0CompatUser | undefined {
  if (!user) return undefined;
  const emails = user.email_addresses ?? [];
  const email = emails.find((e) => e.primary) ?? emails.find((e) => e.verified) ?? emails[0];
  const out: Auth0CompatUser = { sub: user.id };
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username;
  if (name) out.name = name;
  if (user.first_name) out.given_name = user.first_name;
  if (user.last_name) out.family_name = user.last_name;
  if (user.username) out.nickname = user.username;
  if (user.image_url) out.picture = user.image_url;
  if (email) {
    out.email = email.email_address;
    out.email_verified = email.verified;
  }
  return out;
}

function frontendApiFrom(options: Auth0CompatClientOptions): string {
  const raw = options.frontendApi ?? options.domain ?? '';
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, '');
}

function withRedirect(url: string, redirectUrl: string | undefined): string {
  if (!redirectUrl) return url;
  return `${url}${url.includes('?') ? '&' : '?'}redirect_url=${encodeURIComponent(redirectUrl)}`;
}

function currentHref(): string | undefined {
  return typeof window === 'undefined' ? undefined : window.location.href;
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** The auth0-spa-js `Auth0Client`, on Atlas. */
export class Auth0CompatClient {
  readonly publishableKey: string;
  readonly frontendApi: string;
  private readonly fapi: FapiClient;
  private readonly raw: (path: string, init?: RequestInit) => Promise<Response>;
  private readonly options: Auth0CompatClientOptions;
  private state: { body: AtlasClientBody; at: number } | null = null;
  private token: { jwt: string; exp: number; sessionId: string } | null = null;

  constructor(options: Auth0CompatClientOptions) {
    const publishableKey = options.publishableKey ?? options.clientId;
    if (!publishableKey) throw new Error('Auth0CompatClient: publishableKey is required.');
    this.publishableKey = publishableKey;
    this.frontendApi = frontendApiFrom(options);
    this.options = options;
    const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.fapi = new FapiClient({ publishableKey, baseUrl: this.frontendApi, fetchImpl });
    const doFetch = withDevBrowser(publishableKey, fetchImpl);
    this.raw = (path, init = {}) =>
      doFetch(`${this.frontendApi}${path}`, {
        ...init,
        credentials: 'include',
        headers: {
          'x-publishable-key': publishableKey,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(init.headers as Record<string, string> | undefined),
        },
      });
  }

  private signInUrl(signUp = false): string {
    if (signUp) return this.options.signUpUrl ?? `${this.frontendApi}/hosted/sign-up`;
    return this.options.signInUrl ?? `${this.frontendApi}/hosted/sign-in`;
  }

  /** Read the Frontend API client state (session, user, token). */
  private async load(force = false): Promise<AtlasClientBody> {
    if (!force && this.state && Date.now() - this.state.at < 2_000) return this.state.body;
    const response = await this.raw('/v1/client');
    if (!response.ok) throw new Error(`Atlas: could not read the session (HTTP ${response.status}).`);
    const body = (await response.json()) as AtlasClientBody;
    this.state = { body, at: Date.now() };
    if (body.session && body.jwt) this.keepToken(body.jwt, body.session.id);
    if (!body.session) this.token = null;
    return body;
  }

  private keepToken(jwt: string, sessionId: string): void {
    const exp = Number(decodeJwtPayload(jwt)?.exp ?? 0) * 1000;
    this.token = { jwt, exp, sessionId };
  }

  /** `checkSession()`: refresh the local view of the session; never throws. */
  async checkSession(): Promise<void> {
    try {
      await this.load(true);
    } catch {
      // auth0-spa-js swallows login_required here too.
    }
  }

  async isAuthenticated(): Promise<boolean> {
    const body = await this.load();
    return Boolean(body.session && body.user);
  }

  async getUser<TUser extends Auth0CompatUser = Auth0CompatUser>(): Promise<TUser | undefined> {
    const body = await this.load();
    return body.session ? (auth0UserFromClient(body.user) as TUser | undefined) : undefined;
  }

  async getIdTokenClaims(): Promise<(Record<string, unknown> & { __raw: string }) | undefined> {
    const jwt = await this.getTokenSilently().catch(() => null);
    if (typeof jwt !== 'string') return undefined;
    const claims = decodeJwtPayload(jwt);
    return claims ? { ...claims, __raw: jwt } : undefined;
  }

  /** The Atlas session token (or a named-template token), refreshed when close to expiry. */
  async getTokenSilently(options: Auth0CompatTokenOptions & { detailedResponse: true }): Promise<{ access_token: string; id_token: string; expires_in: number }>;
  async getTokenSilently(options?: Auth0CompatTokenOptions): Promise<string>;
  async getTokenSilently(options: Auth0CompatTokenOptions = {}): Promise<string | { access_token: string; id_token: string; expires_in: number }> {
    if (options.for && options.atlasIdAccessToken) {
      // A Sign in with Atlas user who is not on this instance: no session needed.
      const t = await getAtlasIdIntegrationToken(this.fapi, options.for, options.atlasIdAccessToken, { dpop: options.dpop, ...audienceOf(options) });
      if (!t) throw new Auth0CompatError('login_required', `No token for integration ${options.for}`);
      return options.detailedResponse ? { access_token: t.jwt, id_token: t.jwt, expires_in: t.expiresIn } : t.jwt;
    }
    const body = await this.load(options.cacheMode === 'off');
    if (!body.session) throw new Auth0CompatError('login_required', 'Login required');
    let jwt: string | null = null;
    let expiresIn = 0;
    if (options.for) {
      const t = await getIntegrationToken(this.fapi, body.session.id, options.for, audienceOf(options));
      if (!t) throw new Auth0CompatError('login_required', `No token for integration ${options.for}`);
      jwt = t.jwt;
      expiresIn = t.expiresIn;
    } else if (options.template) {
      const t = await getTemplateToken(this.fapi, body.session.id, options.template);
      if (!t) throw new Auth0CompatError('login_required', `No token for template ${options.template}`);
      jwt = t.jwt;
      expiresIn = t.expiresIn;
    } else {
      const usable = this.token && this.token.sessionId === body.session.id && this.token.exp - Date.now() > 10_000;
      if (!usable || options.cacheMode === 'off') {
        if (options.cacheMode === 'cache-only') throw new Auth0CompatError('login_required', 'No cached token');
        const response = await this.raw(`/v1/client/sessions/${encodeURIComponent(body.session.id)}/tokens`, { method: 'POST' });
        if (!response.ok) throw new Auth0CompatError('login_required', 'Login required');
        const minted = (await response.json()) as { jwt: string; session_id: string };
        this.keepToken(minted.jwt, minted.session_id);
      }
      jwt = this.token!.jwt;
      expiresIn = Math.max(0, Math.floor((this.token!.exp - Date.now()) / 1000));
    }
    return options.detailedResponse ? { access_token: jwt, id_token: jwt, expires_in: expiresIn } : jwt;
  }

  /** Sign in in a popup when needed, then return a token. */
  async getTokenWithPopup(options: Auth0CompatTokenOptions & Auth0CompatRedirectOptions = {}): Promise<string | undefined> {
    if (!(await this.isAuthenticated())) await this.loginWithPopup(options);
    return this.getTokenSilently({ ...options, detailedResponse: false });
  }

  /**
   * Navigate to sign-in. With `authorizationParams.connection` the user goes
   * straight to that social provider; otherwise to the instance's hosted page.
   * `appState` comes back from {@link handleRedirectCallback}.
   */
  async loginWithRedirect(options: Auth0CompatRedirectOptions = {}): Promise<void> {
    const params = options.authorizationParams ?? {};
    const returnTo = (params.redirect_uri as string | undefined) ?? this.options.authorizationParams?.redirect_uri ?? currentHref();
    if (options.appState !== undefined) storage()?.setItem(APP_STATE_KEY, JSON.stringify(options.appState));
    let url: string;
    if (params.connection) {
      const started = await startOauthRedirect(this.fapi, {
        provider: CONNECTIONS[params.connection] ?? params.connection,
        redirectUrl: returnTo ?? '/',
      });
      if (!started) throw new Auth0CompatError('start_failed', `Could not start sign-in with ${params.connection}.`);
      url = started.authorizationUrl;
    } else {
      url = withRedirect(this.signInUrl(params.screen_hint === 'signup'), returnTo);
    }
    if (options.openUrl) await options.openUrl(url);
    else if (typeof window !== 'undefined') window.location.assign(url);
  }

  /**
   * Finish a redirect sign-in on the page you came back to: exchanges the
   * one-time ticket in the URL (if any), removes it from the address bar, and
   * returns the `appState` passed to `loginWithRedirect`.
   */
  async handleRedirectCallback(url?: string): Promise<{ appState?: unknown; redirectUrl?: string }> {
    const href = url ?? currentHref() ?? '';
    const search = href.includes('?') ? href.slice(href.indexOf('?')) : '';
    const result = readRedirectResult(search.split('#')[0] ?? '');
    // Where the sign-in journey says to go next, returned for the app to follow.
    let journeyUrl: string | null = null;
    if (result?.ticket) {
      const response = await this.raw('/v1/client/tickets/exchange', {
        method: 'POST',
        body: JSON.stringify({ attempt_id: result.attemptId, ticket: result.ticket }),
      });
      if (!response.ok) throw new Auth0CompatError('login_required', 'The sign-in could not be completed.');
      journeyUrl = await journeyRedirectFrom(response);
    } else if (result?.status && result.status !== 'complete') {
      throw new Auth0CompatError('login_required', `Sign-in needs another step (${result.status}).`);
    }
    if (!url && typeof window !== 'undefined' && result) {
      window.history.replaceState({}, document.title, stripRedirectParams(window.location.href));
    }
    await this.load(true);
    const raw = storage()?.getItem(APP_STATE_KEY);
    storage()?.removeItem(APP_STATE_KEY);
    let appState: unknown;
    try {
      appState = raw ? JSON.parse(raw) : undefined;
    } catch {
      appState = undefined;
    }
    return { ...(appState === undefined ? {} : { appState }), ...(journeyUrl ? { redirectUrl: journeyUrl } : {}) };
  }

  /**
   * Sign in in a popup: straight at a social provider with
   * `authorizationParams.connection`, otherwise the hosted sign-in page (this
   * waits until a session appears or the popup is closed, up to 5 minutes).
   */
  async loginWithPopup(options: Auth0CompatRedirectOptions & { timeoutInSeconds?: number } = {}): Promise<void> {
    const params = options.authorizationParams ?? {};
    if (params.connection) {
      const outcome = await startOauthPopup(this.fapi, {
        provider: CONNECTIONS[params.connection] ?? params.connection,
        redirectUrl: currentHref() ?? '/',
      });
      if (outcome.blocked) throw new Auth0CompatError('popup_blocked', 'The sign-in popup was blocked.');
      if (outcome.ticket && outcome.attemptId) {
        await this.raw('/v1/client/tickets/exchange', {
          method: 'POST',
          body: JSON.stringify({ attempt_id: outcome.attemptId, ticket: outcome.ticket }),
        });
      } else if (!outcome.sessionDetected) {
        throw new Auth0CompatError(outcome.error === 'popup_closed' ? 'popup_closed' : 'start_failed', outcome.error ?? 'Sign-in did not complete.');
      }
      await this.load(true);
      return;
    }
    const popup = typeof window !== 'undefined' ? window.open(this.signInUrl(params.screen_hint === 'signup'), 'atlas-sign-in', 'width=500,height=650') : null;
    if (!popup) throw new Auth0CompatError('popup_blocked', 'The sign-in popup was blocked.');
    const deadline = Date.now() + (options.timeoutInSeconds ?? 300) * 1000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1_000));
      if (await this.isSignedInNow()) {
        try {
          popup.close();
        } catch {
          /* cross-origin close */
        }
        return;
      }
      if (popup.closed) throw new Auth0CompatError('popup_closed', 'The sign-in popup was closed.');
      if (Date.now() > deadline) throw new Auth0CompatError('timeout', 'Timed out waiting for sign-in.');
    }
  }

  private async isSignedInNow(): Promise<boolean> {
    try {
      return Boolean((await this.load(true)).session);
    } catch {
      return false;
    }
  }

  /** Sign out (revokes the Atlas session), then go to `logoutParams.returnTo` (default: this site). */
  async logout(options: Auth0CompatLogoutOptions = {}): Promise<void> {
    const body = this.state?.body ?? (await this.load().catch(() => null));
    if (body?.session) await revokeSession(this.raw, body.session.id);
    this.state = null;
    this.token = null;
    const url = options.logoutParams?.returnTo ?? (typeof window !== 'undefined' ? window.location.origin : '/');
    if (options.openUrl === false) return;
    if (typeof options.openUrl === 'function') await options.openUrl(url);
    else if (typeof window !== 'undefined') window.location.assign(url);
  }
}

/** `createAuth0Client(options)`: a client that has already checked the session. */
export async function createAuth0CompatClient(options: Auth0CompatClientOptions): Promise<Auth0CompatClient> {
  const client = new Auth0CompatClient(options);
  await client.checkSession();
  return client;
}
