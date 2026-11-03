/**
 * Moving from Better Auth, browser side: exchange the visitor's Better Auth
 * session for an Atlas session, once, so the switch signs nobody out.
 *
 * Only for apps whose Better Auth session cookie is readable by script (the old
 * app turned `httpOnly` off). Better Auth's default cookie is HttpOnly — then the
 * exchange belongs on your server: the Next.js middleware's `betterAuthBridge`,
 * or the Express / Fastify / Hono adapters' option of the same name.
 *
 * The call goes to `POST /v1/client/migrations/better_auth/exchange` with cookie
 * delivery: on success Atlas sets its session cookies exactly as a sign-in does,
 * and the Better Auth cookies are cleared from this page. A user who still owes
 * a second factor gets the sign-in attempt to continue
 * (`attemptId` + `status`, the same continuation a redirect sign-in carries).
 */
import type { FapiClient } from './fapi';

export const BETTER_AUTH_EXCHANGE_PATH = '/v1/client/migrations/better_auth/exchange';
const DEFAULT_PREFIX = 'better-auth';

export interface BetterAuthExchangeInput {
  /** The Better Auth session cookie value. Default: read from `document.cookie`. */
  token?: string;
  /** Better Auth's `advanced.cookiePrefix` (default `better-auth`). */
  cookiePrefix?: string;
  /** The session cookie's full name, when the old app overrode it. */
  cookieName?: string;
  /** false → the Atlas refresh cookie lasts only for this browser session. */
  remember?: boolean;
  /** Where to read/clear cookies. Default: `document`. */
  document?: { cookie: string };
}

export type BetterAuthExchangeOutcome =
  /** No Better Auth session cookie here: nothing to do. */
  | { status: 'none' }
  /** Signed in: Atlas set its session cookies. Reload your Atlas client (or the page). */
  | { status: 'complete'; sessionId: string; userId: string; jwt: string }
  /** A second factor (or MFA enrolment) is owed: continue the attempt with your sign-in UI. */
  | { status: 'needs_second_factor' | 'needs_mfa_enrollment'; attemptId: string }
  /** Refused. `outcome` is Atlas's `bridge_outcome` (`invalid`, `expired`, `reused`, `closed`, …) or `error`. */
  | { status: 'refused'; outcome: string };

function cookieNames(input: BetterAuthExchangeInput): { session: string[]; all: string[] } {
  const prefix = input.cookiePrefix ?? DEFAULT_PREFIX;
  const session = input.cookieName ?? `${prefix}.session_token`;
  const base = [session, `${prefix}.session_data`, `${prefix}.account_data`, `${prefix}.dont_remember`];
  return { session: [`__Secure-${session}`, session], all: [...base.map((n) => `__Secure-${n}`), ...base] };
}

function readCookie(header: string, name: string): string | undefined {
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

/** The readable Better Auth session cookie value, or undefined. */
export function readBetterAuthCookie(input: BetterAuthExchangeInput = {}): string | undefined {
  const doc = input.document ?? (typeof document !== 'undefined' ? document : undefined);
  if (!doc) return undefined;
  for (const name of cookieNames(input).session) {
    const value = readCookie(doc.cookie, name);
    if (value) return value;
  }
  return undefined;
}

/** Expire the Better Auth cookies this page can reach. */
export function clearBetterAuthCookies(input: BetterAuthExchangeInput = {}): void {
  const doc = input.document ?? (typeof document !== 'undefined' ? document : undefined);
  if (!doc) return;
  for (const name of cookieNames(input).all) {
    doc.cookie = `${name}=; Path=/; Max-Age=0${name.startsWith('__Secure-') ? '; Secure' : ''}`;
  }
}

/** Refusals after which the Better Auth session will never exchange: its cookies are cleared. */
const FINAL = new Set(['invalid', 'signature_invalid', 'expired', 'reused', 'user_unavailable']);

/**
 * Exchange the Better Auth session (read from the page, or `input.token`) for
 * an Atlas session. Never throws.
 */
export async function exchangeBetterAuthSession(
  client: FapiClient,
  input: BetterAuthExchangeInput = {},
): Promise<BetterAuthExchangeOutcome> {
  const token = input.token ?? readBetterAuthCookie(input);
  if (!token) return { status: 'none' };

  let response;
  try {
    response = await client.post<{
      object?: string;
      id?: string;
      user_id?: string;
      jwt?: string;
      status?: string;
    }>(BETTER_AUTH_EXCHANGE_PATH, {
      token,
      delivery: 'cookie',
      ...(input.remember === false ? { remember: false } : {}),
    });
  } catch {
    return { status: 'refused', outcome: 'error' };
  }

  const data = response.data;
  if (response.ok && data?.object === 'session' && data.id && data.jwt) {
    clearBetterAuthCookies(input);
    return { status: 'complete', sessionId: data.id, userId: data.user_id ?? '', jwt: data.jwt };
  }
  if (
    response.ok &&
    data?.object === 'sign_in_attempt' &&
    data.id &&
    (data.status === 'needs_second_factor' || data.status === 'needs_mfa_enrollment')
  ) {
    clearBetterAuthCookies(input);
    return { status: data.status, attemptId: data.id };
  }
  const outcome = response.errors[0]?.meta?.bridge_outcome;
  const reason = typeof outcome === 'string' ? outcome : 'error';
  if (FINAL.has(reason)) clearBetterAuthCookies(input);
  return { status: 'refused', outcome: reason };
}
