/**
 * Upstream (RP-initiated) logout after an Atlas sign-out.
 *
 * When the session came from a custom OAuth / OpenID Connect provider or an
 * enterprise OIDC connection that has RP-initiated logout turned on, the
 * Frontend API's sign-out response (`POST /v1/client/sessions/:id/revoke`)
 * carries `upstream_logout_url`: the provider's end-session URL (with
 * `id_token_hint`, Atlas's logout callback and a signed `state`). Sending the
 * browser there ends the upstream session too; the provider then returns the
 * user to Atlas, which lands them on the sign-out `returnUrl` (an allowed
 * origin) or the provider's configured post-logout page.
 *
 * The SDKs follow it automatically after the local sign-out. Pass
 * `signOut({ upstreamLogout: false })` to handle `result.upstreamLogoutUrl`
 * yourself (or not at all).
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The URL when it is safe to navigate to (`https:`, or `http:` on loopback), else undefined. */
export function upstreamLogoutUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const secure = url.protocol === 'https:';
  const localDev = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  return secure || localDev ? url.href : undefined;
}

/** Read `upstream_logout_url` from a sign-out response body (already parsed). */
export function upstreamLogoutUrlFromBody(body: unknown): string | undefined {
  return upstreamLogoutUrl((body as { upstream_logout_url?: unknown } | null)?.upstream_logout_url);
}

/**
 * Navigate the browser to the upstream end-session URL. A no-op (false) outside
 * a browser or for an unsafe URL. `navigate` is injectable for tests and for
 * hosts that route navigation themselves.
 */
export function followUpstreamLogout(
  url: string | undefined,
  navigate?: (href: string) => void,
): boolean {
  const safe = upstreamLogoutUrl(url);
  if (!safe) return false;
  if (navigate) {
    navigate(safe);
    return true;
  }
  if (typeof window === 'undefined' || !window.location) return false;
  window.location.assign(safe);
  return true;
}
