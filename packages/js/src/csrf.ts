/** The cookie Atlas sets with each session token when the instance turned on `session.csrfCookie`. */
export const CSRF_COOKIE_NAME = '__atlas_csrf';
/** The header a request echoes it in. */
export const CSRF_HEADER_NAME = 'x-atlas-csrf';

/**
 * The CSRF token for the signed-in session, or null when there is none (signed out, the instance has not turned
 * `session.csrfCookie` on, or the cookie is not readable from this page). Send it as `x-atlas-csrf` on your own
 * state-changing requests; the SDK already does so for its own calls. The token is replaced whenever the session token
 * is, so read it per request instead of storing it.
 */
export function getCsrfToken(cookies?: string): string | null {
  const source = cookies ?? (typeof document === 'undefined' ? '' : safeCookies());
  for (const part of source.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === CSRF_COOKIE_NAME) {
      const raw = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(raw) || null;
      } catch {
        return raw || null;
      }
    }
  }
  return null;
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
export function csrfHeadersFor(method: string | undefined): Record<string, string> {
  if (SAFE_METHODS.has((method ?? 'GET').toUpperCase())) return {};
  const token = getCsrfToken();
  return token ? { [CSRF_HEADER_NAME]: token } : {};
}
