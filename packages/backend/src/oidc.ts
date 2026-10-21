import { createLocalJWKSet, errors as joseErrors, jwtVerify, type JWTPayload } from 'jose';
import { createPkcePair } from './handshake';
import { JwksCache } from './jwks-cache';

/**
 * Server-side OpenID Connect relying party for the hosted-redirect integration.
 *
 * The three calls an app needs, in order:
 *
 *   const { url, cookie } = await oidc.start({ issuer, clientId, redirectUri, secret });
 *   // → Set-Cookie: cookie, 302 to url
 *   const identity = await oidc.callback({ issuer, clientId, clientSecret, redirectUri, query, cookie, secret });
 *   // → Set-Cookie: identity.clearCookie, start your own session for identity.namespacedSub
 *   const logout = await oidc.logoutUrl({ issuer, clientId, postLogoutRedirectUri, idTokenHint });
 *
 * What it does so the integrator does not have to:
 *  - state, nonce and a PKCE (S256) pair per sign-in, carried to the callback in
 *    ONE short-lived httpOnly flow cookie scoped to the callback path. With a
 *    `secret` the cookie is sealed (AES-256-GCM, key derived with HKDF), so it
 *    can be neither read nor forged; the verifier never reaches page JavaScript
 *    either way.
 *  - discovery (cached per issuer for an hour; a failure is remembered for a
 *    minute so a burst of callbacks cannot become an outbound request flood),
 *    the code exchange with the client's authentication method, and the JWKS
 *    (the package's rate-limited kid-miss cache).
 *  - ID-token verification with the algorithm PINNED to RS256 (so `alg: none`
 *    and HS* confusion are refused), `iss` exact, `aud` containing the client id
 *    (and `azp` equal to it when there are several audiences or an `azp` at all),
 *    `nonce` equal to the cookie's, `exp`/`iat` with a small tolerance, and
 *    `at_hash` when the token carries one.
 *
 * Every failure is an {@link AtlasOidcError} with a stable `code`. Only Web
 * standard globals are used (fetch, crypto.subtle, TextEncoder, atob/btoa), so
 * this runs unchanged on Node 18+, Bun, Deno and edge runtimes.
 */

// ── errors ──────────────────────────────────────────────────────────────────

/**
 * Stable failure codes. `access_denied` also stands for the OAuth `error` the
 * authorization server redirected back with; that exact value is in
 * {@link AtlasOidcError.oauthError}.
 */
export type AtlasOidcErrorCode =
  | 'state_mismatch'
  | 'issuer_mismatch'
  | 'invalid_request'
  | 'invalid_token'
  | 'token_exchange_failed'
  | 'access_denied'
  | 'discovery_failed';

export class AtlasOidcError extends Error {
  readonly code: AtlasOidcErrorCode;
  /** The OAuth `error` value from the authorization or token endpoint, when there was one. */
  readonly oauthError?: string;
  /** The OAuth `error_description`, when there was one. */
  readonly description?: string;
  /** HTTP status of the token endpoint's answer, for `token_exchange_failed`. */
  readonly status?: number;
  /**
   * A `Set-Cookie` value that removes the flow cookie. Send it with your error
   * response too, so a failed sign-in leaves nothing behind. Set on every error
   * thrown by {@link oidcCallback}.
   */
  clearCookie?: string;
  declare readonly cause?: unknown;

  constructor(
    code: AtlasOidcErrorCode,
    message: string,
    extra: { cause?: unknown; oauthError?: string; description?: string; status?: number } = {},
  ) {
    super(message);
    this.name = 'AtlasOidcError';
    this.code = code;
    if (extra.cause !== undefined) (this as { cause?: unknown }).cause = extra.cause;
    if (extra.oauthError !== undefined) this.oauthError = extra.oauthError;
    if (extra.description !== undefined) this.description = extra.description;
    if (extra.status !== undefined) this.status = extra.status;
  }
}

// ── shared options ──────────────────────────────────────────────────────────

interface OidcBaseOptions {
  /** Your instance's issuer: `https://` + its frontend API host. */
  issuer: string;
  /** The OAuth client id (`client_id`). */
  clientId: string;
  /**
   * Override the discovery document URL. Defaults to
   * `${issuer}/.well-known/openid-configuration`.
   */
  discoveryUrl?: string;
  fetchImpl?: typeof fetch;
  /** A clock in epoch milliseconds, for deterministic tests. */
  now?: () => number;
}

/** The default flow cookie name. */
export const OIDC_FLOW_COOKIE = 'atlas_oidc';
/** How long a started sign-in stays valid, in seconds. */
export const OIDC_FLOW_MAX_AGE_SECONDS = 600;

// ── start ───────────────────────────────────────────────────────────────────

export interface OidcStartOptions extends OidcBaseOptions {
  /** The callback URL, registered on the client exactly. */
  redirectUri: string;
  /** Space-delimited scopes. Default `openid profile email`; `openid` is added if missing. */
  scope?: string;
  /** OIDC `prompt` (`login`, `none`, `consent`, `select_account`, `create`). */
  prompt?: string;
  /** OIDC `login_hint`: prefill the sign-in page with this email or identifier. */
  loginHint?: string;
  /** Sent as `audience_hint`. */
  audienceHint?: string;
  /**
   * Any other authorize parameters. They cannot override the ones this helper
   * owns (`response_type`, `client_id`, `redirect_uri`, `state`, `nonce`,
   * `code_challenge`, `code_challenge_method`).
   */
  extraParams?: Record<string, string | undefined>;
  /** The flow cookie name. Default `atlas_oidc`. Pass the same name to `callback`. */
  cookieName?: string;
  /**
   * A server-side secret (at least 32 characters) that seals the flow cookie.
   * Strongly recommended: without it the cookie is still httpOnly but only
   * encoded, not encrypted or signed. Pass the same value to `callback`.
   */
  secret?: string;
}

export interface OidcStartResult {
  /** Redirect the browser here. */
  url: string;
  /** A `Set-Cookie` header value for the flow cookie. Send it with the redirect. */
  cookie: string;
  state: string;
  nonce: string;
}

const OWNED_PARAMS = new Set([
  'response_type',
  'client_id',
  'redirect_uri',
  'state',
  'nonce',
  'code_challenge',
  'code_challenge_method',
]);

/**
 * Begin a sign-in: build the authorize URL and the flow cookie. Send `cookie`
 * as `Set-Cookie` and redirect to `url`.
 */
export async function oidcStart(options: OidcStartOptions): Promise<OidcStartResult> {
  requireString(options.issuer, 'issuer');
  requireString(options.clientId, 'clientId');
  const redirect = parseRedirectUri(options.redirectUri);
  const discovery = await discover(options);

  const state = randomToken();
  const nonce = randomToken();
  const pkce = await createPkcePair();
  const scope = normaliseScope(options.scope);

  const url = new URL(discovery.authorization_endpoint);
  for (const [key, value] of Object.entries(options.extraParams ?? {})) {
    if (value !== undefined && !OWNED_PARAMS.has(key)) url.searchParams.set(key, value);
  }
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (options.prompt) url.searchParams.set('prompt', options.prompt);
  if (options.loginHint) url.searchParams.set('login_hint', options.loginHint);
  if (options.audienceHint) url.searchParams.set('audience_hint', options.audienceHint);

  const payload: FlowPayload = {
    s: state,
    n: nonce,
    v: pkce.verifier,
    r: options.redirectUri,
    i: stripSlash(options.issuer),
    c: options.clientId,
    t: Math.floor(clock(options) / 1000),
  };
  const value = await sealFlow(payload, options.secret);
  const cookie = serializeCookie(options.cookieName ?? OIDC_FLOW_COOKIE, value, {
    path: redirect.pathname,
    maxAge: OIDC_FLOW_MAX_AGE_SECONDS,
    secure: redirect.protocol === 'https:',
  });

  return { url: url.toString(), cookie, state, nonce };
}

// ── callback ────────────────────────────────────────────────────────────────

export type OidcClientAuth = 'client_secret_basic' | 'client_secret_post' | 'none';

export interface OidcCallbackOptions extends OidcBaseOptions {
  /** The same callback URL `start` used. */
  redirectUri: string;
  /** The client secret. Omit for a public client (`clientAuth: 'none'`). */
  clientSecret?: string;
  /**
   * How to authenticate at the token endpoint. Default `client_secret_basic`
   * when `clientSecret` is set, otherwise `none`.
   */
  clientAuth?: OidcClientAuth;
  /**
   * The callback's query: a `URLSearchParams`, the request URL (or just its
   * query string), or a framework's parsed query object.
   */
  query: URLSearchParams | string | Record<string, string | string[] | undefined>;
  /** The request's `Cookie` header, or just the flow cookie's value. */
  cookie: string | null | undefined;
  /** The flow cookie name `start` used. Default `atlas_oidc`. */
  cookieName?: string;
  /** The secret `start` used. */
  secret?: string;
  /** Allowed clock skew for `exp`/`iat`, in seconds. Default 60. */
  clockToleranceSec?: number;
}

export interface OidcIdentity {
  /** The Atlas user id (`sub`). Unique within one issuer. */
  sub: string;
  /**
   * `${issuer}#${sub}`: unique across issuers. Key your users on this when you
   * accept more than one instance (development and production, or several
   * tenants), so two instances' users can never collide.
   */
  namespacedSub: string;
  email: string | null;
  /** `true` only when the ID token says `email_verified: true`. */
  emailVerified: boolean;
  name: string | null;
  /** The raw, verified ID token. Keep it for `logoutUrl({ idTokenHint })`. */
  idToken: string;
  accessToken: string;
  /** Present when the client may use refresh tokens and the grant included one. */
  refreshToken?: string;
  /** When the access token expires, in epoch milliseconds. */
  expiresAt: number;
  /** Every verified ID-token claim. */
  claims: JWTPayload & Record<string, unknown>;
  /** A `Set-Cookie` value that removes the flow cookie. Send it with your response. */
  clearCookie: string;
}

/**
 * Finish a sign-in: check `state`, exchange the code (with PKCE and client
 * authentication), verify the ID token, and return who signed in.
 */
export async function oidcCallback(options: OidcCallbackOptions): Promise<OidcIdentity> {
  const name = options.cookieName ?? OIDC_FLOW_COOKIE;
  const clearCookie = oidcClearCookie({ redirectUri: options.redirectUri, cookieName: name });
  try {
    return { ...(await runCallback(options, name)), clearCookie };
  } catch (error) {
    const failure =
      error instanceof AtlasOidcError
        ? error
        : new AtlasOidcError('invalid_request', (error as Error)?.message ?? String(error), { cause: error });
    failure.clearCookie = clearCookie;
    throw failure;
  }
}

async function runCallback(
  options: OidcCallbackOptions,
  cookieName: string,
): Promise<Omit<OidcIdentity, 'clearCookie'>> {
  requireString(options.issuer, 'issuer');
  requireString(options.clientId, 'clientId');
  const issuer = stripSlash(options.issuer);
  const query = toParams(options.query);

  // The flow cookie first: without it nothing in the query can be trusted, and
  // an authorization `error` for a flow we never started is not ours to report.
  const raw = readFlowCookie(options.cookie, cookieName);
  if (!raw) throw new AtlasOidcError('state_mismatch', 'The sign-in flow cookie is missing or expired. Start sign-in again.');
  const flow = await openFlow(raw, options.secret);
  if (!flow) throw new AtlasOidcError('state_mismatch', 'The sign-in flow cookie could not be read. Start sign-in again.');

  const state = query.get('state');
  if (!state || !timingSafeEqual(state, flow.s)) {
    throw new AtlasOidcError('state_mismatch', 'The `state` returned to the callback does not match this browser\'s sign-in.');
  }
  const nowSec = Math.floor(clock(options) / 1000);
  if (nowSec - flow.t > OIDC_FLOW_MAX_AGE_SECONDS) {
    throw new AtlasOidcError('state_mismatch', 'This sign-in took longer than 10 minutes. Start sign-in again.');
  }
  if (flow.i !== issuer || flow.c !== options.clientId || flow.r !== options.redirectUri) {
    throw new AtlasOidcError('state_mismatch', 'This sign-in was started for a different issuer, client or redirect URI.');
  }

  // RFC 9207: an authorization server that names itself must be the one we sent the user to.
  const returnedIss = query.get('iss');
  if (returnedIss !== null && stripSlash(returnedIss) !== issuer) {
    throw new AtlasOidcError('issuer_mismatch', `The callback came from ${returnedIss}, not ${issuer}.`);
  }

  const oauthError = query.get('error');
  if (oauthError) {
    const description = query.get('error_description') ?? undefined;
    throw new AtlasOidcError(
      'access_denied',
      `Sign-in did not complete: ${oauthError}${description ? ` (${description})` : ''}.`,
      { oauthError, description },
    );
  }

  const code = query.get('code');
  if (!code) throw new AtlasOidcError('invalid_request', 'The callback has no `code` parameter.');

  const discovery = await discover(options);
  const tokens = await exchangeCode(discovery, options, code, flow.v);

  const claims = await verifyIdToken(tokens.id_token, discovery, {
    clientId: options.clientId,
    nonce: flow.n,
    accessToken: tokens.access_token,
    clockToleranceSec: options.clockToleranceSec ?? 60,
    fetchImpl: options.fetchImpl,
    now: options.now,
  });

  const sub = claims.sub as string;
  const expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : Number(tokens.expires_in);
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0
    ? clock(options) + expiresIn * 1000
    : (claims.exp as number) * 1000;

  return {
    sub,
    namespacedSub: `${issuer}#${sub}`,
    email: typeof claims.email === 'string' ? claims.email : null,
    emailVerified: claims.email_verified === true,
    name: typeof claims.name === 'string' ? claims.name : null,
    idToken: tokens.id_token,
    accessToken: tokens.access_token,
    ...(typeof tokens.refresh_token === 'string' ? { refreshToken: tokens.refresh_token } : {}),
    expiresAt,
    claims,
  };
}

interface TokenResponse {
  id_token: string;
  access_token: string;
  refresh_token?: string;
  expires_in?: number | string;
  token_type?: string;
}

async function exchangeCode(
  discovery: DiscoveryDocument,
  options: OidcCallbackOptions,
  code: string,
  verifier: string,
): Promise<TokenResponse> {
  const method: OidcClientAuth = options.clientAuth ?? (options.clientSecret ? 'client_secret_basic' : 'none');
  if (method !== 'none' && !options.clientSecret) {
    throw new AtlasOidcError('token_exchange_failed', `clientAuth '${method}' needs \`clientSecret\`.`);
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: options.redirectUri,
    code_verifier: verifier,
  });
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  if (method === 'client_secret_basic') {
    // RFC 6749 §2.3.1: both halves are form-encoded before Basic encoding.
    headers.authorization = `Basic ${btoa(
      `${encodeURIComponent(options.clientId)}:${encodeURIComponent(options.clientSecret!)}`,
    )}`;
  } else {
    body.set('client_id', options.clientId);
    if (method === 'client_secret_post') body.set('client_secret', options.clientSecret!);
  }

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(discovery.token_endpoint, { method: 'POST', headers, body });
  } catch (cause) {
    throw new AtlasOidcError('token_exchange_failed', `The token endpoint could not be reached: ${errText(cause)}.`, { cause });
  }
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const oauthError = typeof json?.error === 'string' ? json.error : undefined;
    const description = typeof json?.error_description === 'string' ? json.error_description : undefined;
    throw new AtlasOidcError(
      'token_exchange_failed',
      `The token endpoint answered ${response.status}${oauthError ? ` ${oauthError}` : ''}${description ? `: ${description}` : ''}.`,
      { oauthError, description, status: response.status },
    );
  }
  if (!json || typeof json.id_token !== 'string' || typeof json.access_token !== 'string') {
    throw new AtlasOidcError(
      'token_exchange_failed',
      'The token response has no `id_token`. Request the `openid` scope.',
      { status: response.status },
    );
  }
  return json as unknown as TokenResponse;
}

// ── ID-token verification ───────────────────────────────────────────────────

/** Options for {@link verifyIdToken}. */
export interface VerifyIdTokenOptions {
  issuer: string;
  clientId: string;
  /** The nonce sent on the authorize request. Required: an ID token without the right nonce is refused. */
  nonce: string;
  /** When given and the token has `at_hash`, the access token must match it. */
  accessToken?: string;
  clockToleranceSec?: number;
  discoveryUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Verify an ID token on its own (for an app that does its own code exchange).
 * Same checks as {@link oidcCallback}. Throws {@link AtlasOidcError}.
 */
export async function oidcVerifyIdToken(
  idToken: string,
  options: VerifyIdTokenOptions,
): Promise<JWTPayload & Record<string, unknown>> {
  const discovery = await discover({ ...options, clientId: options.clientId });
  return verifyIdToken(idToken, discovery, {
    clientId: options.clientId,
    nonce: options.nonce,
    accessToken: options.accessToken,
    clockToleranceSec: options.clockToleranceSec ?? 60,
    fetchImpl: options.fetchImpl,
    now: options.now,
  });
}

async function verifyIdToken(
  idToken: string,
  discovery: DiscoveryDocument,
  opts: {
    clientId: string;
    nonce: string;
    accessToken?: string;
    clockToleranceSec: number;
    fetchImpl?: typeof fetch;
    now?: () => number;
  },
): Promise<JWTPayload & Record<string, unknown>> {
  const invalid = (why: string, cause?: unknown) =>
    new AtlasOidcError('invalid_token', `The ID token was refused: ${why}.`, cause === undefined ? {} : { cause });

  const header = decodeHeader(idToken);
  if (!header) throw invalid('it is not a JWT');
  // Pinned before any key lookup, so `none` and HS* never get near a key.
  if (header.alg !== 'RS256') throw invalid(`its algorithm is ${String(header.alg)}, not RS256`);

  const keys = await jwksFor(discovery.jwks_uri, opts).get(typeof header.kid === 'string' ? header.kid : undefined);
  if (!keys || keys.keys.length === 0) {
    throw new AtlasOidcError('discovery_failed', `The issuer's signing keys could not be fetched from ${discovery.jwks_uri}.`);
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, createLocalJWKSet(keys as never), {
      algorithms: ['RS256'],
      issuer: discovery.issuer,
      audience: opts.clientId,
      clockTolerance: opts.clockToleranceSec,
      currentDate: opts.now ? new Date(opts.now()) : undefined,
      requiredClaims: ['sub', 'iat', 'exp'],
    }));
  } catch (cause) {
    throw invalid(joseReason(cause), cause);
  }

  // OIDC Core §3.1.3.7 (4)-(5): several audiences need an azp, and any azp must be us.
  const aud = payload.aud;
  if (Array.isArray(aud) && aud.length > 1 && payload.azp === undefined) {
    throw invalid('it has several audiences and no azp');
  }
  if (payload.azp !== undefined && payload.azp !== opts.clientId) {
    throw invalid(`its azp is ${String(payload.azp)}, not this client`);
  }
  if (typeof payload.nonce !== 'string' || !timingSafeEqual(payload.nonce, opts.nonce)) {
    throw invalid('its nonce does not match this sign-in');
  }
  const nowSec = Math.floor((opts.now ?? Date.now)() / 1000);
  if (typeof payload.iat === 'number' && payload.iat > nowSec + opts.clockToleranceSec) {
    throw invalid('it was issued in the future');
  }
  if (opts.accessToken && typeof payload.at_hash === 'string') {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(opts.accessToken)));
    if (!timingSafeEqual(base64url(digest.slice(0, 16)), payload.at_hash)) {
      throw invalid('its at_hash does not match the access token');
    }
  }
  return payload as JWTPayload & Record<string, unknown>;
}

function joseReason(error: unknown): string {
  if (error instanceof joseErrors.JWTExpired) return 'it has expired';
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    if (error.claim === 'aud') return 'its audience is not this client';
    if (error.claim === 'iss') return 'its issuer is not the configured issuer';
    return `its ${error.claim} claim is invalid`;
  }
  if (error instanceof joseErrors.JWSSignatureVerificationFailed) return 'its signature does not verify';
  if (error instanceof joseErrors.JWKSNoMatchingKey) return 'no published key matches it';
  return errText(error);
}

// ── logout ──────────────────────────────────────────────────────────────────

export interface OidcLogoutUrlOptions extends OidcBaseOptions {
  /** Where Atlas sends the user afterwards. Must be registered on the client exactly. */
  postLogoutRedirectUri?: string;
  /** The ID token from sign-in. Lets Atlas skip asking which session to end. */
  idTokenHint?: string;
  /** Echoed back on the post-logout redirect. */
  state?: string;
}

/**
 * The RP-initiated logout URL (`end_session_endpoint` from discovery). End your
 * own session first, then redirect here so the Atlas session ends too.
 */
export async function oidcLogoutUrl(options: OidcLogoutUrlOptions): Promise<string> {
  const discovery = await discover(options);
  if (!discovery.end_session_endpoint) {
    throw new AtlasOidcError('discovery_failed', 'The issuer does not advertise an end_session_endpoint.');
  }
  const url = new URL(discovery.end_session_endpoint);
  url.searchParams.set('client_id', options.clientId);
  if (options.idTokenHint) url.searchParams.set('id_token_hint', options.idTokenHint);
  if (options.postLogoutRedirectUri) url.searchParams.set('post_logout_redirect_uri', options.postLogoutRedirectUri);
  if (options.state) url.searchParams.set('state', options.state);
  return url.toString();
}

/** A `Set-Cookie` value that removes the flow cookie for this callback path. */
export function oidcClearCookie(options: { redirectUri: string; cookieName?: string }): string {
  const redirect = parseRedirectUri(options.redirectUri);
  return serializeCookie(options.cookieName ?? OIDC_FLOW_COOKIE, '', {
    path: redirect.pathname,
    maxAge: 0,
    secure: redirect.protocol === 'https:',
  });
}

/**
 * The relying-party helpers as one namespace: `oidc.start`, `oidc.callback`,
 * `oidc.logoutUrl`, `oidc.verifyIdToken`, `oidc.clearCookie`. Import the
 * standalone `oidcStart` / `oidcCallback` / … for the smallest bundle.
 */
export const oidc = {
  start: oidcStart,
  callback: oidcCallback,
  logoutUrl: oidcLogoutUrl,
  verifyIdToken: oidcVerifyIdToken,
  clearCookie: oidcClearCookie,
} as const;

/** The type of {@link oidc}. */
export type AtlasOidc = typeof oidc;

/** Clear the discovery and key caches (tests, or after an issuer change). */
export function resetOidcCaches(): void {
  discoveryCaches = new WeakMap();
  jwksCaches = new WeakMap();
}

// ── discovery ───────────────────────────────────────────────────────────────

interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

const DISCOVERY_TTL_MS = 3_600_000;
const DISCOVERY_RETRY_MS = 60_000;

type DiscoveryEntry =
  | { ok: true; doc: DiscoveryDocument; at: number }
  | { ok: false; error: AtlasOidcError; at: number };

// Keyed by the fetch implementation first, so two test issuers (or a test and
// production code) never share a cached document.
let discoveryCaches = new WeakMap<object, Map<string, DiscoveryEntry | Promise<DiscoveryDocument>>>();
let jwksCaches = new WeakMap<object, Map<string, JwksCache>>();

function cacheKeyFor(fetchImpl: typeof fetch | undefined): object {
  return (fetchImpl ?? globalThis.fetch) as unknown as object;
}

async function discover(options: OidcBaseOptions): Promise<DiscoveryDocument> {
  const issuer = stripSlash(options.issuer);
  const url = options.discoveryUrl ?? `${issuer}/.well-known/openid-configuration`;
  const key = cacheKeyFor(options.fetchImpl);
  let cache = discoveryCaches.get(key);
  if (!cache) {
    cache = new Map();
    discoveryCaches.set(key, cache);
  }
  const cacheKey = `${issuer} ${url}`;
  const now = clock(options);
  const hit = cache.get(cacheKey);
  if (hit instanceof Promise) return hit;
  if (hit?.ok && now - hit.at < DISCOVERY_TTL_MS) return hit.doc;
  if (hit && !hit.ok && now - hit.at < DISCOVERY_RETRY_MS) throw hit.error;

  const flight = fetchDiscovery(url, issuer, options.fetchImpl).then(
    (doc) => {
      cache!.set(cacheKey, { ok: true, doc, at: now });
      return doc;
    },
    (error: AtlasOidcError) => {
      // Keep serving a document we already had through an outage.
      if (hit?.ok) {
        cache!.set(cacheKey, hit);
        return hit.doc;
      }
      cache!.set(cacheKey, { ok: false, error, at: now });
      throw error;
    },
  );
  cache.set(cacheKey, flight);
  return flight;
}

async function fetchDiscovery(url: string, issuer: string, fetchImpl?: typeof fetch): Promise<DiscoveryDocument> {
  const fail = (why: string, cause?: unknown) =>
    new AtlasOidcError('discovery_failed', `OIDC discovery at ${url} failed: ${why}.`, cause === undefined ? {} : { cause });
  let response: Response;
  try {
    response = await (fetchImpl ?? fetch)(url, { headers: { accept: 'application/json' } });
  } catch (cause) {
    throw fail(errText(cause), cause);
  }
  if (!response.ok) throw fail(`HTTP ${response.status}`);
  const doc = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!doc || typeof doc !== 'object') throw fail('the response is not JSON');
  // OIDC Discovery §4.3: the document must be for the issuer we asked about.
  if (typeof doc.issuer !== 'string' || stripSlash(doc.issuer) !== issuer) {
    throw fail(`its issuer (${String(doc.issuer)}) is not ${issuer}`);
  }
  for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    if (typeof doc[field] !== 'string') throw fail(`it has no ${field}`);
    if (!isSecureUrl(doc[field] as string)) throw fail(`its ${field} is not an https URL`);
  }
  if (doc.end_session_endpoint !== undefined && typeof doc.end_session_endpoint !== 'string') {
    throw fail('its end_session_endpoint is not a string');
  }
  return {
    issuer: doc.issuer,
    authorization_endpoint: doc.authorization_endpoint as string,
    token_endpoint: doc.token_endpoint as string,
    jwks_uri: doc.jwks_uri as string,
    ...(typeof doc.end_session_endpoint === 'string' ? { end_session_endpoint: doc.end_session_endpoint } : {}),
  };
}

function jwksFor(uri: string, opts: { fetchImpl?: typeof fetch; now?: () => number }): JwksCache {
  const key = cacheKeyFor(opts.fetchImpl);
  let cache = jwksCaches.get(key);
  if (!cache) {
    cache = new Map();
    jwksCaches.set(key, cache);
  }
  let jwks = cache.get(uri);
  if (!jwks) {
    jwks = new JwksCache({ url: uri, fetchImpl: opts.fetchImpl, now: opts.now });
    cache.set(uri, jwks);
  }
  return jwks;
}

// ── the flow cookie ─────────────────────────────────────────────────────────

interface FlowPayload {
  /** state */ s: string;
  /** nonce */ n: string;
  /** PKCE verifier */ v: string;
  /** redirect URI */ r: string;
  /** issuer */ i: string;
  /** client id */ c: string;
  /** started at, epoch seconds */ t: number;
}

const SEALED_PREFIX = 's1.';
const PLAIN_PREFIX = 'p1.';
type AesKey = Awaited<ReturnType<typeof crypto.subtle.deriveKey>>;
const keyCache = new Map<string, Promise<AesKey>>();

function flowKey(secret: string): Promise<AesKey> {
  if (secret.length < 32) {
    throw new TypeError('The OIDC flow-cookie `secret` must be at least 32 characters.');
  }
  let key = keyCache.get(secret);
  if (!key) {
    key = (async () => {
      const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, [
        'deriveKey',
      ]);
      return crypto.subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: new TextEncoder().encode('atlas-oidc-flow-cookie'),
          info: new TextEncoder().encode('v1'),
        },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
    })();
    keyCache.set(secret, key);
  }
  return key;
}

async function sealFlow(payload: FlowPayload, secret?: string): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  if (secret === undefined) return PLAIN_PREFIX + base64url(json);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await flowKey(secret), json));
  return `${SEALED_PREFIX}${base64url(iv)}.${base64url(sealed)}`;
}

async function openFlow(value: string, secret?: string): Promise<FlowPayload | null> {
  let json: Uint8Array;
  try {
    if (secret !== undefined) {
      // With a secret configured an unsealed cookie is a downgrade: refuse it.
      if (!value.startsWith(SEALED_PREFIX)) return null;
      const [iv, data] = value.slice(SEALED_PREFIX.length).split('.');
      if (!iv || !data) return null;
      json = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: fromBase64url(iv) },
          await flowKey(secret),
          fromBase64url(data),
        ),
      );
    } else {
      if (!value.startsWith(PLAIN_PREFIX)) return null;
      json = fromBase64url(value.slice(PLAIN_PREFIX.length));
    }
    const parsed = JSON.parse(new TextDecoder().decode(json)) as Partial<FlowPayload>;
    const fields = ['s', 'n', 'v', 'r', 'i', 'c'] as const;
    if (!fields.every((f) => typeof parsed[f] === 'string') || typeof parsed.t !== 'number') return null;
    return parsed as FlowPayload;
  } catch (error) {
    if (error instanceof TypeError && /secret/.test(error.message)) throw error;
    return null;
  }
}

function readFlowCookie(input: string | null | undefined, name: string): string | undefined {
  if (!input) return undefined;
  const trimmed = input.trim();
  if (trimmed.startsWith(SEALED_PREFIX) || trimmed.startsWith(PLAIN_PREFIX)) return trimmed;
  for (const part of trimmed.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      return value || undefined;
    }
  }
  return undefined;
}

function serializeCookie(
  name: string,
  value: string,
  opts: { path: string; maxAge: number; secure: boolean },
): string {
  const parts = [`${name}=${value}`, `Path=${opts.path}`, `Max-Age=${opts.maxAge}`, 'HttpOnly', 'SameSite=Lax'];
  if (opts.maxAge === 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  // Secure except on a plain-http local callback, where the browser would drop it.
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

// ── small helpers ───────────────────────────────────────────────────────────

function clock(options: { now?: () => number }): number {
  return (options.now ?? Date.now)();
}

function requireString(value: unknown, name: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`oidc: \`${name}\` is required.`);
  }
}

function parseRedirectUri(value: unknown): URL {
  requireString(value, 'redirectUri');
  let url: URL;
  try {
    url = new URL(value as string);
  } catch {
    throw new TypeError('oidc: `redirectUri` must be an absolute URL.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new TypeError('oidc: `redirectUri` must be https (http is accepted only for localhost).');
  }
  return url;
}

function normaliseScope(scope: string | undefined): string {
  const parts = (scope ?? 'openid profile email').split(/\s+/).filter(Boolean);
  if (!parts.includes('openid')) parts.unshift('openid');
  return [...new Set(parts)].join(' ');
}

function toParams(query: OidcCallbackOptions['query']): URLSearchParams {
  if (query instanceof URLSearchParams) return query;
  if (typeof query === 'string') {
    const q = query.includes('?') ? query.slice(query.indexOf('?') + 1) : query;
    return new URLSearchParams(q.split('#')[0]);
  }
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (typeof value === 'string') out.set(key, value);
    else if (Array.isArray(value) && typeof value[0] === 'string') out.set(key, value[0]);
  }
  return out;
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function isSecureUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname));
  } catch {
    return false;
  }
}

const stripSlash = (value: string) => value.replace(/\/+$/, '');

function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeHeader(jwt: string): { alg?: unknown; kid?: unknown } | null {
  const parts = jwt.split('.');
  if (parts.length !== 3 || !parts[0]) return null;
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64url(parts[0]))) as { alg?: unknown; kid?: unknown };
  } catch {
    return null;
  }
}

/** Length-independent comparison of two strings, so a mismatch position does not leak. */
function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

