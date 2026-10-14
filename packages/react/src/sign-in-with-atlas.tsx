import { createElement, type CSSProperties } from 'react';

export interface AtlasIdOptions {
  clientId: string;
  redirectUri: string;
  issuer?: string;
  scope?: string;
}

export interface AtlasIdResult {
  /** The ID token (same as idToken) — GSI-style name for what to send to your server. */
  credential: string;
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  claims: Record<string, unknown>;
}

const DEFAULT_ISSUER = 'https://atlasauth.net';

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

interface Begun {
  tx: StoredTransaction & { state: string; popup?: boolean };
  url: Promise<string>;
}

/** Writes the transaction synchronously, so a popup opened right after gets a copy. */
function begin(opts: AtlasIdOptions, mode: 'redirect' | 'popup'): Begun {
  if (!opts.clientId) throw new Error('clientId is required');
  if (!opts.redirectUri) throw new Error('redirectUri is required');
  const issuer = (opts.issuer ?? DEFAULT_ISSUER).replace(/\/+$/, '');
  const tx: Begun['tx'] = {
    state: randomToken(),
    nonce: randomToken(),
    verifier: randomToken(),
    redirectUri: opts.redirectUri,
    clientId: opts.clientId,
    issuer,
  };
  if (mode === 'popup') tx.popup = true;
  sessionStorage.setItem(`atlasid:${tx.state}`, JSON.stringify(tx));
  const url = crypto.subtle
    .digest('SHA-256', new TextEncoder().encode(tx.verifier))
    .then((digest) => {
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: opts.clientId,
        redirect_uri: opts.redirectUri,
        scope: opts.scope ?? 'openid profile email',
        state: tx.state,
        nonce: tx.nonce,
        code_challenge: b64url(new Uint8Array(digest)),
        code_challenge_method: 'S256',
      });
      if (mode === 'popup') params.set('response_mode', 'web_message');
      return `${issuer}/oauth2/authorize?${params.toString()}`;
    });
  return { tx, url };
}

export async function buildAtlasAuthorizeUrl(opts: AtlasIdOptions): Promise<string> {
  return begin(opts, 'redirect').url;
}

function decodeClaims(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1];
  if (!part) throw new Error('invalid_id_token');
  const padded = part.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

interface StoredTransaction {
  nonce: string;
  verifier: string;
  redirectUri: string;
  clientId: string;
  issuer: string;
}

const TX_KEYS = ['verifier', 'clientId', 'redirectUri', 'issuer', 'nonce'] as const;

function isTransaction(v: unknown): v is StoredTransaction {
  if (!v || typeof v !== 'object') return false;
  const rec = v as Record<string, unknown>;
  return TX_KEYS.every((k) => typeof rec[k] === 'string' && rec[k] !== '');
}

function takeTransaction(state: string | null): StoredTransaction | null {
  // One-shot: the entry is removed the moment it is read. Blocked storage
  // (privacy modes, sandboxed frames) reads as missing, never a raw throw.
  let raw: string | null = null;
  try {
    raw = state ? sessionStorage.getItem(`atlasid:${state}`) : null;
    if (raw) sessionStorage.removeItem(`atlasid:${state}`);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const tx: unknown = JSON.parse(raw);
    return isTransaction(tx) ? tx : null;
  } catch {
    return null;
  }
}

async function exchangeCode(
  tx: StoredTransaction,
  code: string,
  doFetch: typeof fetch,
): Promise<AtlasIdResult> {
  const res = await doFetch(`${tx.issuer}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: tx.redirectUri,
      client_id: tx.clientId,
      code_verifier: tx.verifier,
    }).toString(),
  });
  let tok: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  } | null;
  try {
    tok = await res.json();
  } catch {
    tok = null;
  }
  if (!res.ok || !tok || !tok.id_token || !tok.access_token) {
    throw new Error(tok?.error_description || tok?.error || 'token_exchange_failed');
  }
  let claims: Record<string, unknown>;
  try {
    claims = decodeClaims(tok.id_token);
  } catch {
    throw new Error('invalid_id_token');
  }
  if (!claims || typeof claims !== 'object') throw new Error('invalid_id_token');
  if (claims.nonce !== tx.nonce) throw new Error('nonce_mismatch');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== tx.issuer || !aud.includes(tx.clientId)) throw new Error('invalid_id_token');
  return {
    credential: tok.id_token,
    idToken: tok.id_token,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    expiresIn: tok.expires_in ?? 0,
    claims,
  };
}

/**
 * Finishes sign-in on the redirect page. Mirrors the hosted script's
 * `AtlasID.handleCallback()` check for check and error code for error code:
 * invalid_url, the callback's own error, state_mismatch, missing_code,
 * token_exchange_failed (or the token endpoint's error), invalid_id_token,
 * nonce_mismatch.
 */
export async function completeSignInWithAtlas(
  opts: { url?: string; fetch?: typeof fetch } = {},
): Promise<AtlasIdResult> {
  let q: URLSearchParams;
  try {
    q = new URL(opts.url ?? window.location.href).searchParams;
  } catch {
    throw new Error('invalid_url');
  }
  const err = q.get('error');
  if (err) throw new Error(q.get('error_description') || err);
  const tx = takeTransaction(q.get('state'));
  if (!tx) throw new Error('state_mismatch');
  const code = q.get('code');
  if (!code) throw new Error('missing_code');
  return exchangeCode(tx, code, opts.fetch ?? fetch);
}

function centeredPopupFeatures(w: number, h: number): string {
  const x = (window.screenX || 0) + Math.max(0, ((window.outerWidth || w) - w) / 2);
  const y = (window.screenY || 0) + Math.max(0, ((window.outerHeight || h) - h) / 2);
  return `popup=yes,width=${w},height=${h},left=${Math.round(x)},top=${Math.round(y)}`;
}

/**
 * Popup sign-in, like Google's popup mode: no full-page redirect and no callback
 * page. Call it from a click handler (or the browser blocks the popup). Atlas
 * posts the result back to this window (response_mode=web_message), and the
 * code is exchanged here with PKCE — no client secret. Needs a Browser-only
 * (PKCE) app whose redirect URI is on this site's origin.
 *
 * Rejects with `popup_closed` if the user closes the popup, or with the OP's
 * error (e.g. `access_denied`). A blocked popup falls back to the full-page
 * redirect (finish it with completeSignInWithAtlas on the redirect page).
 */
export function signInWithAtlasPopup(
  opts: AtlasIdOptions & { fetch?: typeof fetch },
): Promise<AtlasIdResult> {
  let begun: Begun;
  try {
    begun = begin(opts, 'popup');
  } catch (e) {
    return Promise.reject(e);
  }
  const { tx } = begun;
  let popup: Window | null = null;
  try {
    popup = window.open('', 'atlasid_signin', centeredPopupFeatures(480, 640));
  } catch {
    popup = null;
  }
  if (!popup) {
    takeTransaction(tx.state);
    return buildAtlasAuthorizeUrl(opts).then((u) => {
      window.location.assign(u);
      return new Promise<AtlasIdResult>(() => {});
    });
  }
  const win = popup;
  return new Promise<AtlasIdResult>((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const finish = (err: Error | null, result?: AtlasIdResult) => {
      if (done) return;
      done = true;
      window.removeEventListener('message', onMessage);
      if (timer) clearInterval(timer);
      if (err) reject(err);
      else resolve(result!);
    };
    function onMessage(ev: MessageEvent) {
      if (ev.source !== win || ev.origin !== tx.issuer) return;
      const d = ev.data as { type?: string; response?: Record<string, string> } | null;
      if (!d || d.type !== 'atlasid:authorization_response' || !d.response) return;
      if (d.response.state !== tx.state) return;
      try {
        win.close();
      } catch {
        /* ignore */
      }
      const stored = takeTransaction(tx.state);
      if (!stored) return finish(new Error('state_mismatch'));
      if (d.response.error) return finish(new Error(d.response.error_description || d.response.error));
      if (!d.response.code) return finish(new Error('missing_code'));
      exchangeCode(stored, d.response.code, opts.fetch ?? fetch).then(
        (r) => finish(null, r),
        (e: Error) => finish(e),
      );
    }
    window.addEventListener('message', onMessage);
    timer = setInterval(() => {
      let closed = true;
      try {
        closed = win.closed;
      } catch {
        /* treat as closed */
      }
      if (closed) {
        if (timer) clearInterval(timer);
        timer = null;
        // Grace period: a message posted just before close is still delivered.
        setTimeout(() => finish(new Error('popup_closed')), 600);
      }
    }, 400);
    begun.url.then(
      (u) => {
        try {
          win.location.href = u;
        } catch {
          finish(new Error('popup_failed'));
        }
      },
      (e: Error) => {
        try {
          win.close();
        } catch {
          /* ignore */
        }
        finish(e);
      },
    );
  });
}

/**
 * The hosted script's `data-login-uri` check: an https URL or a same-origin
 * path (not "//" or "/\"), with no control or whitespace characters. Returns
 * the normalized href, or null.
 */
function safeLoginUri(v: string, base: string = window.location.href): string | null {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f]/.test(v)) return null;
  const pathOnly = /^\/(?![/\\])/.test(v);
  if (!pathOnly && !/^https:\/\//i.test(v)) return null;
  try {
    const u = new URL(v, base);
    if (u.origin === new URL(base).origin || u.protocol === 'https:') return u.href;
  } catch {
    /* fall through */
  }
  return null;
}

const LABELS = {
  signin: 'Sign in with Atlas',
  signup: 'Sign up with Atlas',
  continue: 'Continue with Atlas',
} as const;

// Same look as the hosted script's button (.atlasid-btn and friends).
const FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
const SIZES = {
  large: { height: 44, fontSize: 15, padding: '0 18px', gap: 10, mark: 18 },
  medium: { height: 38, fontSize: 14, padding: '0 14px', gap: 10, mark: 18 },
  small: { height: 32, fontSize: 13, padding: '0 10px', gap: 8, mark: 16 },
} as const;

const THEMES: Record<'dark' | 'light' | 'outline', CSSProperties> = {
  dark: { background: '#0f1117', color: '#fff', borderColor: '#0f1117' },
  light: { background: '#fff', color: '#0f1117', borderColor: '#dadce0' },
  outline: { background: 'transparent', color: 'inherit', borderColor: 'currentColor' },
};

function AtlasMark({ size }: { size: number }) {
  return createElement(
    'svg',
    { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, fill: 'none', style: { flex: 'none', display: 'block' } },
    createElement('path', { d: 'M12 2 3 21h4l5-11 5 11h4L12 2z', fill: 'currentColor' }),
  );
}

interface ButtonLook {
  /**
   * `redirect` (default) sends the whole page to Atlas. `popup` signs in inside
   * a popup and calls onSuccess with the result — no redirect, no callback page.
   */
  uxMode?: 'redirect' | 'popup';
  /** Popup mode: called with { credential, claims, ... } when sign-in completes. */
  onSuccess?: (result: AtlasIdResult) => void;
  theme?: 'dark' | 'light' | 'outline';
  size?: 'large' | 'medium' | 'small';
  shape?: 'rect' | 'pill';
  text?: 'signin' | 'signup' | 'continue';
  className?: string;
  onError?: (e: Error) => void;
}

/**
 * Browser mode (PKCE in the browser): pass clientId + redirectUri.
 * Server mode: pass loginUri — the click goes to your backend route, which
 * starts sign-in with any OIDC library and exchanges the code with your secret.
 */
export type SignInWithAtlasButtonProps = ButtonLook &
  (
    | (AtlasIdOptions & { loginUri?: undefined })
    | ({ loginUri: string } & Partial<AtlasIdOptions>)
  );

export function SignInWithAtlasButton(props: SignInWithAtlasButtonProps) {
  const { theme = 'dark', size = 'large', shape = 'rect', text = 'signin' } = props;
  const dims = SIZES[size];
  const style: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: dims.gap,
    boxSizing: 'border-box',
    font: `600 ${dims.fontSize}px/1 ${FONT}`,
    border: '1px solid transparent',
    ...THEMES[theme],
    borderRadius: shape === 'pill' ? 999 : 6,
    cursor: 'pointer',
    padding: dims.padding,
    height: dims.height,
  };
  const fail = (e: unknown) => {
    const error = e instanceof Error ? e : new Error(String(e));
    if (props.onError) props.onError(error);
    else if (typeof console !== 'undefined') console.error(`AtlasID: ${error.message}`);
  };
  const onClick = () => {
    if (props.loginUri !== undefined) {
      const target = safeLoginUri(props.loginUri);
      if (target) window.location.assign(target);
      else fail(new Error('loginUri must be an https URL or a same-origin path'));
      return;
    }
    if (props.uxMode === 'popup') {
      signInWithAtlasPopup(props)
        .then((r) => props.onSuccess?.(r))
        .catch((e: Error) => {
          // Closing the popup is a normal cancel, not an error to log.
          if (e?.message === 'popup_closed' && !props.onError) return;
          fail(e);
        });
      return;
    }
    buildAtlasAuthorizeUrl(props)
      .then((u) => window.location.assign(u))
      .catch(fail);
  };
  return createElement(
    'button',
    { type: 'button', className: props.className, style, onClick, 'data-atlas': 'sign-in-with-atlas' },
    createElement(AtlasMark, { size: dims.mark }),
    createElement('span', null, LABELS[text]),
  );
}
