import {
  createMigrationBridge,
  exchangeMigrationSession,
  type MigrationBridgeRequest,
  type MigrationExchangeResult,
} from './migration-bridge';

/**
 * Moving from Better Auth to Atlas without signing anyone out.
 *
 * During the migration window a returning user still carries their Better Auth
 * session cookie (`better-auth.session_token`, `__Secure-` prefixed over
 * https). It is HttpOnly, so only your server can read it. The bridge reads it,
 * exchanges it ONCE with Atlas (`POST /v1/client/migrations/better_auth/exchange`),
 * sets the Atlas session as your own first-party cookies and clears the Better
 * Auth cookies. Atlas finds the session in your import (or asks your old app,
 * with the live fallback on) and runs the normal sign-in path on it — MFA
 * policy included: a user who still owes a second factor is sent to finish it.
 *
 * Framework-neutral: {@link createBetterAuthBridge} returns a decision with the
 * cookies to set and clear; the Next.js middleware and the Express / Fastify /
 * Hono adapters render it.
 */

/** Better Auth's default cookie prefix (`advanced.cookiePrefix`). */
export const BETTER_AUTH_COOKIE_PREFIX = 'better-auth';

/** The FAPI path of the exchange (publishable key; per-IP limited — the browser / fallback path). */
export const BETTER_AUTH_EXCHANGE_PATH = '/v1/client/migrations/better_auth/exchange';
/** The Backend API path (secret key; limited per instance for a bulk cutover — the server path). */
export const BETTER_AUTH_BAPI_EXCHANGE_PATH = '/v1/migrations/better_auth/exchange';

/** A cookie to set (or, with `maxAge: 0`, clear) on the response. */
export interface BridgeCookie {
  name: string;
  value: string;
  options: {
    path?: string;
    domain?: string;
    httpOnly?: boolean;
    sameSite?: 'lax' | 'strict' | 'none';
    secure?: boolean;
    maxAge?: number;
  };
}

/** The Better Auth cookies the bridge reads (session_token) and clears (all of them). */
export function betterAuthCookieNames(prefix: string = BETTER_AUTH_COOKIE_PREFIX): {
  sessionToken: string[];
  all: string[];
} {
  const base = ['session_token', 'session_data', 'account_data', 'dont_remember'].map((n) => `${prefix}.${n}`);
  const secure = base.map((n) => `__Secure-${n}`);
  return {
    sessionToken: [`__Secure-${prefix}.session_token`, `${prefix}.session_token`],
    all: [...secure, ...base],
  };
}

function readCookie(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

/**
 * The raw Better Auth session cookie value from a `Cookie` header (the
 * `__Secure-` name first), or undefined. `cookieName` overrides the name when
 * the old app set `advanced.cookies.session_token.name`.
 */
export function readBetterAuthSessionCookie(
  cookieHeader: string | null | undefined,
  options: { cookiePrefix?: string; cookieName?: string } = {},
): string | undefined {
  const names = options.cookieName
    ? [`__Secure-${options.cookieName}`, options.cookieName]
    : betterAuthCookieNames(options.cookiePrefix).sessionToken;
  for (const name of names) {
    const value = readCookie(cookieHeader, name);
    if (value) return value;
  }
  return undefined;
}

/** Why Atlas refused an exchange (`meta.bridge_outcome`). */
export type BetterAuthRefusal =
  | 'closed'
  | 'invalid'
  | 'signature_invalid'
  | 'expired'
  | 'reused'
  | 'user_unavailable'
  | 'rate_limited'
  | 'unavailable';

export type BetterAuthExchangeResult =
  | {
      kind: 'session';
      jwt: string;
      refreshToken: string;
      sessionId: string;
      userId: string;
      expiresIn: number;
    }
  | {
      /** The user still owes a second factor (or MFA enrolment) — the Better Auth session is spent. */
      kind: 'needs_mfa';
      attemptId: string;
      status: 'needs_second_factor' | 'needs_mfa_enrollment';
    }
  | { kind: 'refused'; outcome: BetterAuthRefusal; status: number };

export interface ExchangeBetterAuthSessionOptions {
  /** The instance's Frontend API origin, e.g. `https://clerk.example.com` or your FAPI host. */
  fapiOrigin: string;
  publishableKey: string;
  /**
   * The instance secret key. When set (recommended on a server), the exchange
   * goes to the Backend API, which is limited per instance with a ceiling sized
   * for a bulk cutover instead of per IP — your server speaks for every user —
   * and takes the user's IP and user agent from `clientIp` / `userAgent`.
   */
  secretKey?: string;
  /** Backend API origin for the secret-key path. Default `https://api.atlasauth.net`. */
  bapiBaseUrl?: string;
  /** The end user's IP (secret-key path), so Atlas's risk and geo checks see the user, not your server. */
  clientIp?: string;
  /** The raw Better Auth session cookie value (or the bare token). */
  token: string;
  /** false → the Atlas refresh cookie should be a browser-session cookie. */
  remember?: boolean;
  fetchImpl?: typeof fetch;
  /** Forwarded so the session's device record shows the user's browser, not your server. */
  userAgent?: string;
}

/**
 * Exchange a Better Auth session for an Atlas session, server to server
 * (`delivery: "body"`). Never throws: a transport failure is
 * `{ kind: 'refused', outcome: 'unavailable' }`, so the caller keeps the Better
 * Auth cookie and tries again on a later request.
 */
export async function exchangeBetterAuthSession(
  options: ExchangeBetterAuthSessionOptions,
): Promise<BetterAuthExchangeResult> {
  return toBetterAuthResult(await exchangeMigrationSession({ ...options, source: 'better_auth' }));
}

/**
 * The generic exchange's answer in Better Auth's terms. `user_unknown` is not a
 * Better Auth outcome (the Better Auth exchange never sends it), so it reads as
 * any other unknown verdict did before: not a judgement on the session.
 */
function toBetterAuthResult(result: MigrationExchangeResult): BetterAuthExchangeResult {
  if (result.kind === 'refused' && result.outcome === 'user_unknown') return { kind: 'refused', outcome: 'unavailable', status: result.status };
  return result as BetterAuthExchangeResult;
}

export interface BetterAuthBridgeOptions {
  fapiOrigin: string;
  publishableKey: string;
  /** The instance secret key: exchanges go through the Backend API (recommended; see {@link ExchangeBetterAuthSessionOptions.secretKey}). */
  secretKey?: string;
  bapiBaseUrl?: string;
  /** Better Auth's `advanced.cookiePrefix` (default `better-auth`). */
  cookiePrefix?: string;
  /** The session cookie's full name, when the old app overrode it. */
  cookieName?: string;
  /** The `domain` the Better Auth cookies were set on (its `crossSubDomainCookies.domain`), so they clear. */
  betterAuthCookieDomain?: string;
  /** Mark the Atlas cookies `Secure`. Default true; set false only for plain-http local development. */
  secure?: boolean;
  fetchImpl?: typeof fetch;
}

/** What the bridge decided for one request. */
export type BetterAuthBridgeDecision =
  /** No Better Auth cookie, or an Atlas session already present: carry on. */
  | { action: 'none' }
  /** Exchanged: set these cookies and re-enter (redirect to the same URL) so the new session is read. */
  | { action: 'signed_in'; cookies: BridgeCookie[]; session: Extract<BetterAuthExchangeResult, { kind: 'session' }> }
  /** A second factor is owed: send the browser to your sign-in page carrying the attempt (see `continuationUrl`). */
  | { action: 'needs_mfa'; cookies: BridgeCookie[]; attemptId: string; status: string; continuationUrl: (url: string) => string }
  /** Refused. `cookies` clears the Better Auth cookies when the refusal is final (invalid, expired, reused). */
  | { action: 'refused'; cookies: BridgeCookie[]; outcome: BetterAuthRefusal };

/**
 * The bridge as a function of a request's headers. Call it from middleware
 * before your normal auth check; it does nothing (no network) for a request
 * without a Better Auth cookie or with an Atlas session (`__session` /
 * `__atlas_rt`) already present. The generic {@link createMigrationBridge} with
 * the Better Auth cookie names.
 */
export function createBetterAuthBridge(options: BetterAuthBridgeOptions) {
  const names = betterAuthCookieNames(options.cookiePrefix);
  const bridge = createMigrationBridge({
    source: 'better_auth',
    preset: 'better_auth',
    fapiOrigin: options.fapiOrigin,
    publishableKey: options.publishableKey,
    secretKey: options.secretKey,
    bapiBaseUrl: options.bapiBaseUrl,
    cookieNames: options.cookieName ? [`__Secure-${options.cookieName}`, options.cookieName] : names.sessionToken,
    clearCookieNames: names.all.concat(options.cookieName ? [options.cookieName, `__Secure-${options.cookieName}`] : []),
    tokenFormat: 'raw',
    bearer: false,
    oldCookieDomain: options.betterAuthCookieDomain,
    secure: options.secure,
    fetchImpl: options.fetchImpl,
  });
  return async function betterAuthBridge(request: MigrationBridgeRequest): Promise<BetterAuthBridgeDecision> {
    const decision = await bridge(request);
    if (decision.action === 'refused' && decision.outcome === 'user_unknown') return { action: 'refused', outcome: 'unavailable', cookies: [] };
    return decision as BetterAuthBridgeDecision;
  };
}

/** Serialize a {@link BridgeCookie} as a `Set-Cookie` header value. */
export function serializeBridgeCookie(cookie: BridgeCookie): string {
  const o = cookie.options;
  const parts = [`${cookie.name}=${cookie.value}`];
  parts.push(`Path=${o.path ?? '/'}`);
  if (o.domain) parts.push(`Domain=${o.domain}`);
  if (o.maxAge !== undefined) {
    parts.push(`Max-Age=${o.maxAge}`);
    if (o.maxAge === 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  }
  if (o.httpOnly) parts.push('HttpOnly');
  if (o.secure) parts.push('Secure');
  if (o.sameSite) parts.push(`SameSite=${o.sameSite[0]!.toUpperCase()}${o.sameSite.slice(1)}`);
  return parts.join('; ');
}
