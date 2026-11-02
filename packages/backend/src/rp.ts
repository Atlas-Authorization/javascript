/**
 * `@atlasauth/backend/rp`: the server-side relying party for the hosted
 * redirect, as `(Request) => Response` handlers for any framework.
 *
 *   const rp = createRelyingParty({ issuer, clientId, clientSecret, redirectUri, secret, secretKey });
 *   app.get('/auth/sign-in', (req) => rp.start(req));
 *   app.get('/auth/callback', async (req) => {
 *     const { user, response } = await rp.callback(req);
 *     // create your session for user.sub, keep user.sid on it, then:
 *     response.headers.append('set-cookie', yourSessionCookie);
 *     return response;
 *   });
 *
 * This entry point loads only Web standards (fetch, Web Crypto, Request,
 * Response, URL) and `jose`, itself Web Crypto only: no `Buffer`, no
 * `node:*`. It runs unchanged on Node 18+, Deno, Bun and Workers. The full
 * `@atlasauth/backend` entry (management client, migration bridges, ...) is
 * never pulled in.
 *
 * Everything here is a thin layer over `oidc.start` / `oidc.callback` (state,
 * nonce and PKCE S256 in one sealed short-lived cookie; ID-token checks with the
 * algorithm pinned, `iss`, `aud`/`azp`, `exp`/`iat`, `nonce`, `at_hash`) plus
 * the Atlas session calls a relying party that keeps its own session needs:
 * keep-alive (`POST /v1/sessions/{id}/touch`) and server-side sign-out
 * (`POST /v1/sessions/{id}/revoke`).
 */
import {
  AtlasOidcError,
  OIDC_FLOW_COOKIE,
  isSafeReturnTo,
  oidcCallback,
  oidcLogoutUrl,
  oidcStart,
  type OidcClientAuth,
  type OidcIdentity,
  type OidcStartOptions,
} from './oidc';
import { AtlasApiError, type AtlasErrorItem } from './client/error';
import { DEFAULT_API_URL } from './client/request';

export { AtlasOidcError, isSafeReturnTo, oidcCallback, oidcLogoutUrl, oidcStart, oidcVerifyIdToken, resetOidcCaches } from './oidc';
export type { OidcIdentity, OidcStartOptions, OidcCallbackOptions, AtlasOidcErrorCode } from './oidc';
export { AtlasApiError } from './client/error';
// Back-channel logout: verify the logout_token (typ logout+jwt, events, no nonce, sid/sub, jti replay hook).
export {
  BACKCHANNEL_LOGOUT_EVENT,
  LogoutTokenVerifier,
  memoryLogoutReplayStore,
  verifyLogoutToken,
} from './logout-token';
export type { LogoutReplayStore, LogoutTokenClaims, LogoutTokenResult, LogoutTokenVerifierOptions } from './logout-token';
export {
  expressBackchannelLogout,
  fastifyBackchannelLogout,
  fastifyBackchannelLogoutPlugin,
  fetchBackchannelLogout,
  handleBackchannelLogout,
} from './backchannel-handlers';
export type { BackchannelLogoutOptions } from './backchannel-handlers';
// Webhooks, verified with Web Crypto.
export { ATLAS_WEBHOOK_HEADERS } from './webhook-common';
export { verifyAtlasWebhook, verifyAtlasWebhookRequest } from './webhooks-web';
export type { WebhookVerifyFailure, WebhookVerifyResult } from './webhook-common';
export type { VerifyAtlasWebhookInput } from './webhooks-web';
export { authenticatedWithin, usedMultiFactor } from './recent-auth';

export interface RelyingPartyConfig {
  /** Your instance's issuer: `https://` + its frontend API host. */
  issuer: string;
  /** The OAuth client id. */
  clientId: string;
  /** The client secret (a confidential client). */
  clientSecret?: string;
  /** Token-endpoint authentication. Default `client_secret_basic` with a secret. */
  clientAuth?: OidcClientAuth;
  /** The callback URL, registered on the client exactly. */
  redirectUri: string;
  /** At least 32 characters: seals the short-lived sign-in cookie. */
  secret: string;
  /** Scopes. Default `openid profile email`. */
  scope?: string;
  /** Where the callback response sends the browser when the sign-in carried no return path. Default `/`. */
  afterSignInPath?: string;
  /** Where Atlas sends the browser after sign-out. Must be registered on the client exactly. */
  postLogoutRedirectUri?: string;
  /** The instance secret key (`sk_...`, scope `sessions:write`). Needed for `touchIfDue` and server-side revoke. */
  secretKey?: string;
  /** The Backend API origin. Default `https://api.atlasauth.net`. */
  apiUrl?: string;
  /** Flow cookie name. Default `atlas_oidc`. */
  cookieName?: string;
  /** Minimum time between two keep-alive calls for one session. Default 5 minutes. */
  touchIntervalMs?: number;
  fetchImpl?: typeof fetch;
  /** A clock in epoch milliseconds, for tests. */
  now?: () => number;
}

/** Who signed in: the ID-token claims an app needs, in the token's own names. */
export interface RelyingPartyUser {
  sub: string;
  /** The Atlas session id. Keep it on your session: touch, revoke and back-channel logout all name it. */
  sid: string | null;
  email: string | null;
  /** True only when the ID token says so. Never match accounts on an unverified email. */
  email_verified: boolean;
  name: string | null;
  /** Your own id for the user, when the token carries one. */
  external_id?: string;
  /** The organization the sign-in was made in, when there was one. */
  org_id?: string;
  org_role?: string;
  /** When the user last authenticated, epoch seconds. Store it for {@link RelyingParty.requireRecentAuth}. */
  auth_time: number | null;
}

export interface RelyingPartyTokens {
  id_token: string;
  access_token: string;
  refresh_token?: string;
  /** When the access token expires, epoch milliseconds. */
  expires_at: number;
}

export interface CallbackResult {
  user: RelyingPartyUser;
  tokens: RelyingPartyTokens;
  /** Every verified claim and the organization / SSO context, as `oidc.callback` returns them. */
  identity: OidcIdentity;
  /**
   * A 302 to the return path (or `afterSignInPath`) that already clears the
   * sign-in cookie. Its headers are mutable: append your own session cookie.
   */
  response: Response;
}

/** Per-request overrides for {@link RelyingParty.start}. */
export type StartOverrides = Pick<
  OidcStartOptions,
  'prompt' | 'loginHint' | 'uiLocales' | 'maxAge' | 'organization' | 'returnTo' | 'expectedSub' | 'scope' | 'extraParams'
>;

export type TouchResult =
  /** Touched less than `touchIntervalMs` ago: nothing sent. Keep your `lastTouchedAt`. */
  | { status: 'skipped'; lastTouchedAt: number }
  /** Atlas slid the idle window. Store `lastTouchedAt`. */
  | { status: 'touched'; lastTouchedAt: number; idleExpiresAt: string | null }
  /**
   * The Atlas session has ended (signed out, revoked, timed out, or unknown).
   * End your own session: it is no longer backed by a live Atlas session.
   */
  | { status: 'ended'; reason: 'revoked' | 'idle_expired' | 'expired' | 'not_found' };

export interface SignOutOptions {
  /** The ID token from sign-in: lets Atlas end the session without asking. */
  idToken?: string;
  /** The Atlas session id. With a `secretKey`, it is revoked server-side before the redirect. */
  sid?: string | null;
  /** Override the configured `postLogoutRedirectUri`. */
  postLogoutRedirectUri?: string;
  state?: string;
}

export interface RecentAuthOptions {
  /** The signed-in user's `sub`: the re-authentication must come back as the same user. */
  sub: string;
  /** The `auth_time` you stored at sign-in (or after the last step-up). */
  authTime: number | null | undefined;
  /** Where to come back to after confirming. Default: the request's own path and query. */
  returnTo?: string;
}

export interface RelyingParty {
  /**
   * Begin sign-in: a 302 to `/oauth2/authorize` with the sign-in cookie set.
   * `prompt`, `login_hint`, `ui_locales`, `max_age`, `organization` and
   * `return_to` on the request's query are passed through; `overrides` win.
   */
  start(request: Request, overrides?: StartOverrides): Promise<Response>;
  /**
   * Finish sign-in. Throws {@link AtlasOidcError} on any failure; send its
   * `clearCookie` as `Set-Cookie` on your error response.
   */
  callback(request: Request): Promise<CallbackResult>;
  /**
   * Step-up: `null` when `authTime` is within `maxAgeSeconds`; otherwise a 302
   * that asks the same user to authenticate again (`max_age`, plus
   * `prompt=login` for 0). The callback then refuses another user or an old
   * `auth_time`; store the new `user.auth_time` (and `user.sid`). `0` asks
   * unless the user authenticated in the last {@link CONFIRM_NOW_WINDOW_SECONDS}
   * seconds, so the request that returns from the confirmation goes through.
   */
  requireRecentAuth(request: Request, maxAgeSeconds: number, options: RecentAuthOptions): Promise<Response | null>;
  /**
   * Keep the Atlas session alive while the user is active in your app, at
   * most once per `touchIntervalMs` per session. Call it on each authenticated
   * request with the `sid` and the time you last touched (0 or null at first).
   */
  touchIfDue(sid: string, lastTouchedAt: number | null | undefined): Promise<TouchResult>;
  /**
   * End the Atlas session server-side (`POST /v1/sessions/{id}/revoke`); every
   * app signed in through it gets a back-channel logout. An already-ended
   * session is `revoked` too; `not_found` means this instance has no such
   * session (check you use the same instance's secret key). Other failures throw.
   */
  revokeSession(sid: string): Promise<'revoked' | 'not_found'>;
  /**
   * Sign-out: with a `sid` and a `secretKey`, revokes the Atlas session
   * server-side first, then 302s the browser to `/oauth2/logout`. End your own
   * session (clear your cookie on this response) as well.
   */
  signOut(options?: SignOutOptions): Promise<Response>;
}

const PASSTHROUGH: ReadonlyArray<[string, keyof StartOverrides]> = [
  ['prompt', 'prompt'],
  ['login_hint', 'loginHint'],
  ['ui_locales', 'uiLocales'],
  ['organization', 'organization'],
  ['return_to', 'returnTo'],
];

const DEFAULT_TOUCH_INTERVAL_MS = 5 * 60_000;
/** How long a `requireRecentAuth(…, 0)` confirmation counts, in seconds. */
export const CONFIRM_NOW_WINDOW_SECONDS = 60;

/** Create the relying party once, at startup; reuse it for every request. */
export function createRelyingParty(config: RelyingPartyConfig): RelyingParty {
  if (typeof config.secret !== 'string' || config.secret.length < 32) {
    throw new TypeError('createRelyingParty: `secret` (at least 32 characters) is required to seal the sign-in cookie.');
  }
  const afterSignIn = config.afterSignInPath ?? '/';
  if (!isSafeReturnTo(afterSignIn)) throw new TypeError('createRelyingParty: `afterSignInPath` must be a path starting with a single `/`.');
  const base = {
    issuer: config.issuer,
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    secret: config.secret,
    cookieName: config.cookieName ?? OIDC_FLOW_COOKIE,
    fetchImpl: config.fetchImpl,
    now: config.now,
  };
  const clock = () => (config.now ?? Date.now)();
  const doFetch = (input: string, init: RequestInit) => (config.fetchImpl ?? fetch)(input, init);
  const interval = config.touchIntervalMs ?? DEFAULT_TOUCH_INTERVAL_MS;

  async function start(request: Request, overrides: StartOverrides = {}): Promise<Response> {
    const query = new URL(request.url).searchParams;
    const fromQuery: StartOverrides = {};
    for (const [param, key] of PASSTHROUGH) {
      const v = query.get(param);
      // A bad return_to from the query is dropped, never an error page.
      if (v && (key !== 'returnTo' || isSafeReturnTo(v))) (fromQuery as unknown as Record<string, string>)[key] = v;
    }
    const maxAge = query.get('max_age');
    if (maxAge !== null && /^\d{1,9}$/.test(maxAge)) fromQuery.maxAge = Number(maxAge);
    const { url, cookie } = await oidcStart({ ...base, scope: config.scope, ...fromQuery, ...overrides });
    return redirect(url, [cookie]);
  }

  async function callback(request: Request): Promise<CallbackResult> {
    const identity = await oidcCallback({
      ...base,
      clientSecret: config.clientSecret,
      clientAuth: config.clientAuth,
      query: new URL(request.url).searchParams,
      cookie: request.headers.get('cookie'),
    });
    const c = identity.claims;
    const user: RelyingPartyUser = {
      sub: identity.sub,
      sid: identity.sid,
      email: identity.email,
      email_verified: identity.emailVerified,
      name: identity.name,
      ...(typeof c.external_id === 'string' && c.external_id ? { external_id: c.external_id } : {}),
      ...(identity.organization ? { org_id: identity.organization.id, org_role: identity.organization.role } : {}),
      auth_time: identity.authTime,
    };
    const tokens: RelyingPartyTokens = {
      id_token: identity.idToken,
      access_token: identity.accessToken,
      ...(identity.refreshToken ? { refresh_token: identity.refreshToken } : {}),
      expires_at: identity.expiresAt,
    };
    return { user, tokens, identity, response: redirect(identity.returnTo ?? afterSignIn, [identity.clearCookie]) };
  }

  async function requireRecentAuth(request: Request, maxAgeSeconds: number, options: RecentAuthOptions): Promise<Response | null> {
    if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 0) {
      throw new TypeError('requireRecentAuth: `maxAgeSeconds` must be a whole number of seconds, 0 or more.');
    }
    if (typeof options?.sub !== 'string' || !options.sub) throw new TypeError('requireRecentAuth: `sub` is required.');
    const at = options.authTime;
    // 0 means "confirm now": it still passes for a minute after the confirmation,
    // or the request that comes back from it would be sent to confirm again, forever.
    const allowed = maxAgeSeconds === 0 ? CONFIRM_NOW_WINDOW_SECONDS : maxAgeSeconds;
    if (typeof at === 'number' && Number.isFinite(at) && clock() / 1000 - at <= allowed) return null;
    const here = new URL(request.url);
    const returnTo = options.returnTo ?? `${here.pathname}${here.search}`;
    const { url, cookie } = await oidcStart({
      ...base,
      scope: config.scope,
      maxAge: maxAgeSeconds,
      expectedSub: options.sub,
      ...(maxAgeSeconds === 0 ? { prompt: 'login' } : {}),
      ...(isSafeReturnTo(returnTo) ? { returnTo } : {}),
    });
    return redirect(url, [cookie]);
  }

  function sessionCall(sid: string, action: 'touch' | 'revoke'): Promise<Response> {
    if (!config.secretKey) throw new TypeError(`${action === 'touch' ? 'touchIfDue' : 'revokeSession'}: \`secretKey\` is not configured.`);
    if (typeof sid !== 'string' || !sid) throw new TypeError('A session id (`sid`) is required.');
    const url = `${(config.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '')}/v1/sessions/${encodeURIComponent(sid)}/${action}`;
    return doFetch(url, { method: 'POST', headers: { authorization: `Bearer ${config.secretKey}`, accept: 'application/json' } });
  }

  async function touchIfDue(sid: string, lastTouchedAt: number | null | undefined): Promise<TouchResult> {
    const now = clock();
    if (typeof lastTouchedAt === 'number' && now - lastTouchedAt < interval && now >= lastTouchedAt) {
      return { status: 'skipped', lastTouchedAt };
    }
    const res = await sessionCall(sid, 'touch');
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok) {
      return { status: 'touched', lastTouchedAt: now, idleExpiresAt: typeof body?.idle_expires_at === 'string' ? body.idle_expires_at : null };
    }
    if (res.status === 404) return { status: 'ended', reason: 'not_found' };
    if (res.status === 409) {
      const code = errorsOf(body)[0]?.code;
      if (code === 'SESSION_REVOKED') return { status: 'ended', reason: 'revoked' };
      if (code === 'SESSION_IDLE_EXPIRED') return { status: 'ended', reason: 'idle_expired' };
      return { status: 'ended', reason: 'expired' };
    }
    // A key, scope or availability problem is not "signed out": say so loudly.
    throw new AtlasApiError(res.status, errorsOf(body));
  }

  async function revokeSession(sid: string): Promise<'revoked' | 'not_found'> {
    const res = await sessionCall(sid, 'revoke');
    if (res.ok) return 'revoked';
    if (res.status === 404) return 'not_found';
    throw new AtlasApiError(res.status, errorsOf(await res.json().catch(() => null)));
  }

  async function signOut(options: SignOutOptions = {}): Promise<Response> {
    if (options.sid && config.secretKey) await revokeSession(options.sid);
    const url = await oidcLogoutUrl({
      ...base,
      postLogoutRedirectUri: options.postLogoutRedirectUri ?? config.postLogoutRedirectUri,
      idTokenHint: options.idToken,
      state: options.state,
    });
    return redirect(url, []);
  }

  return { start, callback, requireRecentAuth, touchIfDue, revokeSession, signOut };
}

/** A 302 built with `new Response` (not `Response.redirect`), so its headers stay mutable. */
function redirect(location: string, cookies: string[]): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(null, { status: 302, headers });
}

function errorsOf(body: unknown): AtlasErrorItem[] {
  const errors = (body as { errors?: unknown } | null)?.errors;
  return Array.isArray(errors) ? (errors as AtlasErrorItem[]) : [];
}
