/**
 * Silent "is this user already signed in with Atlas?" check for cross-property
 * SSO — the browser-side companion to the server handshake.
 *
 * It runs an OIDC `prompt=none` request in a hidden iframe against the Atlas
 * instance's `/oauth2/authorize`. If a session exists, Atlas redirects the
 * iframe to the registered `redirectUri` with a `code` (the user is signed in);
 * if not, it returns `error=login_required`. The tiny page you host at
 * `redirectUri` calls {@link handleSilentCallback} to postMessage the result
 * back to this opener — the standard OIDC silent-renew pattern.
 *
 * There is no visible navigation. This is a client-side convenience for UI
 * decisions ("show Sign in" vs "show account"); the server (`authenticateRequest`
 * / the handshake middleware) remains the security boundary.
 *
 * NOTE: not yet exercised in an integration test — verify against a live
 * instance before relying on it. See docs/atlas-cross-property-sso-plan.md (P3).
 */

export interface CheckSessionOptions {
  /** The Atlas instance origin / OIDC issuer, e.g. `https://id.atlasauth.net`. */
  issuer: string;
  /** A public OIDC client registered for silent checks. */
  clientId: string;
  /** A redirect URI registered on that client whose page calls {@link handleSilentCallback}. */
  redirectUri: string;
  /** Extra scopes beyond `openid`. Default: `['openid']`. */
  scopes?: readonly string[];
  /** Give up and report signed-out after this many ms. Default 8000. */
  timeoutMs?: number;
  /** A prior id_token to assert a specific user (`id_token_hint`). */
  idTokenHint?: string;
}

export interface CheckSessionResult {
  signedIn: boolean;
  /** The OIDC error when signed out (`login_required`, `consent_required`, …). */
  error?: string;
}

const DEFAULT_TIMEOUT = 8000;

function randomState(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Run the silent check. Resolves `{ signedIn: true }` when the authorize
 * endpoint returns a code, `{ signedIn: false, error }` on `login_required`
 * (or any error / timeout). Never rejects — a timeout is a signed-out signal.
 */
export function checkSession(options: CheckSessionOptions): Promise<CheckSessionResult> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.resolve({ signedIn: false, error: 'not_in_browser' });
  }

  const state = randomState();
  const authUrl = new URL('/oauth2/authorize', options.issuer);
  authUrl.searchParams.set('client_id', options.clientId);
  authUrl.searchParams.set('redirect_uri', options.redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', (options.scopes ?? ['openid']).join(' '));
  authUrl.searchParams.set('prompt', 'none');
  authUrl.searchParams.set('state', state);
  if (options.idTokenHint) authUrl.searchParams.set('id_token_hint', options.idTokenHint);

  const expectedOrigin = new URL(options.redirectUri).origin;

  return new Promise<CheckSessionResult>((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    let done = false;

    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      iframe.remove();
    };
    const finish = (result: CheckSessionResult) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(result);
    };

    const onMessage = (event: MessageEvent) => {
      // Only trust a message from our own callback origin carrying our state.
      if (event.origin !== expectedOrigin) return;
      const data = event.data as { source?: string; state?: string; signedIn?: boolean; error?: string };
      if (!data || data.source !== 'atlas:silent-auth' || data.state !== state) return;
      // Trust only the boolean the callback computed — the raw OAuth code never
      // travels over this channel, so there is nothing here to trust or leak.
      finish({ signedIn: data.signedIn === true && !data.error, error: data.error });
    };

    const timer = setTimeout(() => finish({ signedIn: false, error: 'timeout' }), options.timeoutMs ?? DEFAULT_TIMEOUT);
    window.addEventListener('message', onMessage);
    iframe.src = authUrl.toString();
    document.body.appendChild(iframe);
  });
}

/**
 * Call this from the page you host at `redirectUri`. It reads the OIDC result
 * from the current URL and postMessages ONLY a signed-in/out verdict to the
 * opener (the {@link checkSession} iframe parent), then the iframe is discarded.
 * Safe to call unconditionally on that page; it no-ops outside an iframe.
 *
 * The single-use authorization `code` is deliberately NOT forwarded: silent auth
 * only needs to know *whether* the user is signed in, and putting a live OAuth
 * code on a postMessage channel is a needless secret exposure (a misconfigured
 * `targetOrigin`, or any other listener, could capture and redeem it). We send a
 * boolean instead; the code stays in this callback frame and is never redeemed.
 */
export function handleSilentCallback(targetOrigin?: string): void {
  if (typeof window === 'undefined' || window.parent === window) return;
  const params = new URLSearchParams(window.location.search);
  const error = params.get('error') ?? undefined;
  window.parent.postMessage(
    {
      source: 'atlas:silent-auth',
      state: params.get('state') ?? undefined,
      signedIn: Boolean(params.get('code')) && !error,
      error,
    },
    targetOrigin ?? window.location.origin,
  );
}
