/**
 * Where the widget may send the browser once a sign-in completes.
 *
 * This is the embedded counterpart of the hosted page's `redirect_url` gate
 * (§13.1): a sign-in surface that will bounce anywhere is a phishing primitive,
 * and here the surface is dropped onto a site whose own markup the tenant does
 * not fully control. So a redirect is accepted only when it is:
 *   - a relative path (`/dashboard`), which stays on the page's own origin, or
 *   - an absolute URL on the SAME origin as the page, or
 *   - an absolute `https:` URL the caller supplied explicitly.
 *
 * Everything else — `http:` cross-origin (downgrade), protocol-relative
 * `//evil.com`, `javascript:`/`data:` (script execution), a malformed string —
 * is rejected by returning null, and the caller falls back to emitting an
 * `atlas:complete` event instead of navigating anywhere it was told to.
 */
export function validateRedirect(
  raw: string | null | undefined,
  currentOrigin: string = typeof window !== 'undefined' ? window.location.origin : '',
): string | null {
  if (!raw || typeof raw !== 'string') return null;

  // A relative path stays on the page's own origin. `//host` is NOT relative —
  // it is protocol-relative and resolves cross-origin, so it is excluded here
  // and falls through to the absolute-URL checks (where it fails to parse).
  if (raw.startsWith('/') && !raw.startsWith('//')) {
    try {
      return currentOrigin ? new URL(raw, currentOrigin).toString() : raw;
    } catch {
      return null;
    }
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Not an absolute URL and not a rooted relative path — refuse it.
    return null;
  }

  // Same-origin absolute is always fine (it is where the page already is).
  if (currentOrigin && url.origin === currentOrigin) return url.toString();

  // A cross-origin destination is only ever allowed over https — never an http
  // downgrade, and never a `javascript:`/`data:`/`mailto:` scheme.
  if (url.protocol === 'https:') return url.toString();

  return null;
}
