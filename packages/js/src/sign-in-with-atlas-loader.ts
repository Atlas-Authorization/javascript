/**
 * Load the hosted "Sign in with Atlas" button script from your own bundle,
 * so a Content-Security-Policy that blocks it is reported instead of failing
 * silently. The script itself cannot report its own block (it never runs);
 * this loader runs from your origin, so it can.
 *
 *   await loadSignInWithAtlas({ version: '1.0.0', integrity: 'sha384-…' });
 *
 * On a block it logs
 *   [Atlas] blocked by CSP: add https://atlasauth.net to script-src (see https://atlasauth.net/.well-known/atlas-embed.json)
 * and rejects with an Error whose message is `csp_blocked`; any other load
 * failure rejects with `script_load_failed`. A second call returns the same
 * promise.
 */

export interface LoadSignInWithAtlasOptions {
  /** Where the script is served from. Default https://atlasauth.net. */
  issuer?: string;
  /** An exact version (`1.0.0`, immutable, pin it with `integrity`) or a major (`1`). Default: the evergreen URL. */
  version?: string;
  /** The `sha384-…` value published in the embed manifest for that exact version. */
  integrity?: string;
  /** Your CSP nonce, when your policy uses nonces. */
  nonce?: string;
  /** Give up after this long (ms). Default 15000. */
  timeoutMs?: number;
}

export interface AtlasIdGlobal {
  version?: string;
  signIn(opts: Record<string, unknown>): Promise<void>;
  signInWithPopup(opts: Record<string, unknown>): Promise<Record<string, unknown>>;
  handleCallback(opts?: { url?: string }): Promise<Record<string, unknown>>;
  oneTap?(opts: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export const ATLAS_EMBED_MANIFEST_URL = 'https://atlasauth.net/.well-known/atlas-embed.json';

/** The exact console line for a CSP block (shared with the hosted script). */
export function cspBlockedMessage(origin: string, directive: string): string {
  return `[Atlas] blocked by CSP: add ${origin} to ${directive} (see ${ATLAS_EMBED_MANIFEST_URL})`;
}

let pending: Promise<AtlasIdGlobal> | null = null;

export function signInWithAtlasScriptUrl(opts: Pick<LoadSignInWithAtlasOptions, 'issuer' | 'version'> = {}): string {
  const issuer = (opts.issuer ?? 'https://atlasauth.net').replace(/\/+$/, '');
  const v = opts.version && /^(\d+)(\.x|\.\d+\.\d+)?$/.test(opts.version) ? `@${opts.version}` : '';
  return `${issuer}/sign-in-with-atlas${v}.js`;
}

export function loadSignInWithAtlas(opts: LoadSignInWithAtlasOptions = {}): Promise<AtlasIdGlobal> {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return Promise.reject(new Error('loadSignInWithAtlas needs a browser'));
  }
  const existing = (window as unknown as { AtlasID?: AtlasIdGlobal }).AtlasID;
  if (existing) return Promise.resolve(existing);
  if (pending) return pending;
  const src = signInWithAtlasScriptUrl(opts);
  const origin = new URL(src).origin;
  pending = new Promise<AtlasIdGlobal>((resolve, reject) => {
    let settled = false;
    const script = document.createElement('script');
    const cleanup = () => {
      clearTimeout(timer);
      document.removeEventListener('securitypolicyviolation', onViolation);
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      pending = null;
      reject(new Error(message));
    };
    const onViolation = (ev: SecurityPolicyViolationEvent) => {
      const blocked = String(ev.blockedURI || '');
      let blockedOrigin: string | null = null;
      try {
        blockedOrigin = new URL(blocked).origin;
      } catch {
        /* inline / eval */
      }
      if (blockedOrigin !== origin) return;
      const directive = String(ev.effectiveDirective || ev.violatedDirective || 'script-src').split(' ')[0]!;
      if (typeof console !== 'undefined') console.error(cspBlockedMessage(origin, directive));
      fail('csp_blocked');
    };
    document.addEventListener('securitypolicyviolation', onViolation);
    const timer = setTimeout(() => fail('script_load_timeout'), opts.timeoutMs ?? 15_000);
    script.src = src;
    script.async = true;
    if (opts.integrity) {
      script.integrity = opts.integrity;
      script.crossOrigin = 'anonymous';
    }
    if (opts.nonce) script.nonce = opts.nonce;
    script.onload = () => {
      const g = (window as unknown as { AtlasID?: AtlasIdGlobal }).AtlasID;
      if (settled) return;
      if (!g) return fail('script_load_failed');
      settled = true;
      cleanup();
      resolve(g);
    };
    // A CSP block also fires error; give the violation event a moment to name the directive.
    script.onerror = () => setTimeout(() => fail('script_load_failed'), 50);
    document.head.appendChild(script);
  });
  return pending;
}

/** Test hook. */
export function resetSignInWithAtlasLoader(): void {
  pending = null;
}
