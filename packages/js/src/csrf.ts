import { readAtlasCookie } from './cookie-names';

/** The cookie Atlas sets with each session token when the instance turned on `session.csrfCookie`. */
export const CSRF_COOKIE_NAME = '__atlas_csrf';
/** The header a request echoes it in. */
export const CSRF_HEADER_NAME = 'x-atlas-csrf';

/**
 * The CSRF token for the signed-in session, or null when there is none (signed out, the instance has not turned
 * `session.csrfCookie` on, or the cookie is not readable from this page). Pass the publishable key when the instance
 * isolates its cookies and the page holds cookies of several instances. Send it as `x-atlas-csrf` on your own
 * state-changing requests; the SDK already does so for its own calls. The token is replaced whenever the session token
 * is, so read it per request instead of storing it.
 */
export function getCsrfToken(cookies?: string, publishableKey?: string): string | null {
  const source = cookies ?? (typeof document === 'undefined' ? '' : safeCookies());
  const raw = readAtlasCookie(source, CSRF_COOKIE_NAME, publishableKey);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw) || null;
  } catch {
    return raw;
  }
}

function safeCookies(): string {
  try {
    return document.cookie;
  } catch {
    return '';
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The headers to add to a request: the CSRF header for an unsafe method when a token is available. */
export function csrfHeadersFor(method: string | undefined, publishableKey?: string): Record<string, string> {
  if (SAFE_METHODS.has((method ?? 'GET').toUpperCase())) return {};
  const token = getCsrfToken(undefined, publishableKey);
  return token ? { [CSRF_HEADER_NAME]: token } : {};
}
