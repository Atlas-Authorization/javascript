/**
 * OIDC Front-Channel Logout after a sign-out made in this browser.
 *
 * When a session signed in on this browser is revoked
 * (`POST /v1/client/sessions/:id/revoke`), the Frontend API response lists
 * `frontchannel_logout_urls`: the front-channel logout URLs (already carrying
 * `iss` and `sid`) of the apps that used "Sign in with Atlas" through that
 * session. Loading each one in a hidden iframe lets those apps clear their own
 * sessions in this browser.
 *
 * Best-effort by design: it never throws, never blocks longer than `timeoutMs`,
 * and is a no-op outside a browser (SSR, workers, native).
 */

export interface FrontChannelLogoutOptions {
  /** Upper bound on how long sign-out waits for the frames. Default 5000 ms. */
  timeoutMs?: number;
}

/** Options accepted by every browser SDK's `signOut()`. */
export interface SignOutOptions {
  /**
   * Run OIDC Front-Channel Logout for the apps signed in with this session
   * (hidden iframes, capped at 5 s). Default `true`; pass `false` to skip it.
   */
  frontchannel?: boolean;
  /**
   * Reject with a `SignOutError` when the Frontend API could not revoke the
   * session (after one retry). The local sign-out still happens either way.
   * Default `false`: `signOut()` resolves and reports `revoked: false` instead.
   * Honoured by every framework provider.
   */
  strict?: boolean;
  /**
   * Follow the upstream provider's end-session URL after signing out locally,
   * when the session came from a custom OAuth/OIDC provider or enterprise OIDC
   * connection with RP-initiated logout on. Default `true`; `false` leaves it
   * to you (`result.upstreamLogoutUrl`).
   */
  upstreamLogout?: boolean;
  /**
   * Where the user lands after that upstream logout. Must be on an allowed
   * origin of the instance; otherwise the provider's configured post-logout
   * page is used. Also used for SAML Single Logout when
   * `samlLogoutRedirectUrl` is not set.
   */
  returnUrl?: string;
  /**
   * SAML Single Logout. When the session came from a SAML connection with
   * Single Logout on, the sign-out response carries a `saml_logout_url`; by
   * default the browser is then sent there (after the local sign-out) so the
   * identity provider's session ends too. Pass `false` to stay on the page and
   * handle `SignOutResult.samlLogoutUrl` yourself.
   *
   * A browser can follow only one logout redirect. In the (unusual) case that
   * the response carries both `upstream_logout_url` and `saml_logout_url`, the
   * upstream OpenID provider's URL is followed (it has no server-to-server
   * fallback) and the SAML identity provider is told server-to-server through
   * SOAP back-channel logout when its connection has a SOAP endpoint;
   * `samlLogoutUrl` is still reported. With `upstreamLogout: false`, the SAML
   * URL is followed instead.
   */
  samlLogout?: boolean;
  /**
   * SAML Single Logout: where the identity provider returns the browser once it
   * has signed the user out. Must be on one of the instance's allowed origins.
   * Defaults to `returnUrl`, else the page that signed out.
   */
  samlLogoutRedirectUrl?: string;
}

/** The default wait for front-channel logout frames. */
export const FRONTCHANNEL_LOGOUT_TIMEOUT_MS = 5000;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Keep only the URLs safe to load: `https:` anywhere, `http:` only on a
 * loopback host (local development). Anything else — other schemes, relative
 * or malformed URLs, non-strings — is dropped.
 */
export function frontChannelLogoutUrls(urls: unknown): string[] {
  if (!Array.isArray(urls)) return [];
  const out: string[] = [];
  for (const raw of urls) {
    if (typeof raw !== 'string') continue;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    const secure = url.protocol === 'https:';
    const localDev = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
    if (secure || localDev) out.push(url.href);
  }
  return out;
}

/**
 * Load each front-channel logout URL in a hidden iframe, then remove the frames
 * once every one has loaded (or failed) or after `timeoutMs`, whichever comes
 * first. Resolves in every case.
 */
export function runFrontChannelLogout(
  urls: unknown,
  options: FrontChannelLogoutOptions = {},
): Promise<void> {
  if (typeof document === 'undefined' || typeof window === 'undefined' || !document.body) {
    return Promise.resolve();
  }
  const list = frontChannelLogoutUrls(urls);
  if (list.length === 0) return Promise.resolve();
  const timeoutMs = options.timeoutMs ?? FRONTCHANNEL_LOGOUT_TIMEOUT_MS;

  return new Promise<void>((resolve) => {
    const frames: HTMLIFrameElement[] = [];
    let pending = list.length;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      for (const frame of frames) {
        try {
          frame.remove();
        } catch {
          /* already gone */
        }
      }
      resolve();
    };
    const settle = () => {
      pending -= 1;
      if (pending <= 0) finish();
    };
    timer = setTimeout(finish, timeoutMs);
    for (const url of list) {
      try {
        const frame = document.createElement('iframe');
        frame.style.display = 'none';
        frame.setAttribute('aria-hidden', 'true');
        frame.setAttribute('tabindex', '-1');
        // Same sandbox as Atlas's own logout page and account pages (the
        // documented contract): the frame keeps its origin, so the app's
        // logout response can clear its cookies, but no scripts, navigation,
        // popups or forms. Apps clear their session in the HTTP response.
        frame.setAttribute('sandbox', 'allow-same-origin');
        frame.addEventListener('load', settle, { once: true });
        frame.addEventListener('error', settle, { once: true });
        frame.src = url;
        frames.push(frame);
        document.body.appendChild(frame);
      } catch {
        settle();
      }
    }
  });
}

/**
 * Run front-channel logout from a Frontend API sign-out (`/revoke`) response.
 * Accepts `undefined` (a failed request) and non-OK or non-JSON responses as
 * no-ops; the body is read from a clone, so the caller can still consume it.
 */
export async function runFrontChannelLogoutFromResponse(
  response: Response | null | undefined,
  options: FrontChannelLogoutOptions = {},
): Promise<void> {
  if (!response || !response.ok) return;
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return;
  }
  const urls = (body as { frontchannel_logout_urls?: unknown } | null)?.frontchannel_logout_urls;
  await runFrontChannelLogout(urls, options);
}
