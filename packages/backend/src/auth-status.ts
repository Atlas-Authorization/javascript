import { readAtlasCookie } from './cookie-names';

/**
 * Why a request is, or is not, signed in. `session_expired` means "renew, do
 * not sign out": the short-lived `__session` lapsed but the browser still holds
 * the refresh cookie (`__atlas_rt`) or the signed-in hint (`__atlas_uat`).
 */
export type AuthStatus = 'signed_in' | 'signed_out' | 'session_expired' | 'token_invalid';

export const AUTH_STATUS_HEADER = 'x-atlas-auth-status';

/** True when the request carries the refresh cookie or a live (non-zero, numeric) `__atlas_uat` hint. */
export function hasSessionCookies(cookieHeader: string | null | undefined, suffix = ''): boolean {
  if (readAtlasCookie(cookieHeader, '__atlas_rt', suffix)) return true;
  const uat = readAtlasCookie(cookieHeader, '__atlas_uat', suffix);
  return Boolean(uat) && /^\d+$/.test(uat!) && Number(uat) > 0;
}

/**
 * Map a verify outcome (`null` = no token on the request) to a status and the
 * underlying reason. Expiry only counts after the signature and claims verified.
 */
export function deriveAuthStatus(
  result: { ok: boolean; reason?: string; expired?: boolean } | null,
  cookieHeader: string | null | undefined,
  suffix = '',
): { status: AuthStatus; reason?: string } {
  if (result?.ok) return { status: 'signed_in' };
  const renewable = hasSessionCookies(cookieHeader, suffix);
  if (!result) return { status: renewable ? 'session_expired' : 'signed_out', reason: 'no_token' };
  if (result.expired) return { status: renewable ? 'session_expired' : 'signed_out', reason: 'expired' };
  return { status: 'token_invalid', reason: result.reason };
}

/** `{ 'x-atlas-auth-status': 'session-expired' }`, or `{}` when signed in. */
export function authStatusHeaders(auth: { status: AuthStatus }): Record<string, string> {
  return !auth.status || auth.status === 'signed_in' ? {} : { [AUTH_STATUS_HEADER]: auth.status.replace('_', '-') };
}

/** The response with the status header set; a fresh `Response` when the original's headers are immutable. */
export function withAuthStatus<R extends Response>(response: R, auth: { status: AuthStatus }): R | Response {
  const extra = authStatusHeaders(auth);
  const [name, value] = Object.entries(extra)[0] ?? [];
  if (!name) return response;
  try {
    response.headers.set(name, value!);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    headers.set(name, value!);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
}

/** Express (`setHeader`) and Fastify (`header`) friendly; returns the same response object. */
export function setAuthStatusHeader<
  R extends { setHeader?(name: string, value: string): unknown; header?(name: string, value: string): unknown },
>(res: R, auth: { status: AuthStatus }): R {
  for (const [name, value] of Object.entries(authStatusHeaders(auth))) {
    if (typeof res.setHeader === 'function') res.setHeader(name, value);
    else if (typeof res.header === 'function') res.header(name, value);
  }
  return res;
}
