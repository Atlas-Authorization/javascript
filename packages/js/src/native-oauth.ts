/**
 * Native app OAuth (RFC 8252 + RFC 7636): sign in with a provider (or an enterprise SSO connection) in the system browser and redeem a
 * one-time code with a PKCE verifier. No ticket ever appears in the callback URL, so a leaked callback
 * cannot be redeemed by anyone but the device that started the sign-in.
 *
 * `signInWithNativeBrowser` is the whole flow with the browser injected, shared by the React Native and
 * Expo SDKs. The pieces (`createPkcePair`, `startOAuthSignIn`, `redeemOAuthCode`) are exported for apps that
 * run their own browser step.
 */
import type { FieldError } from './attempt';
import type { FapiClient } from './fapi';
import { readRedirectResult } from './redirect';

/**
 * The error codes the native OAuth routes answer with, and the fix for each. A prebuilt screen can show
 * `message` as is; match on `code` in code.
 */
export const NATIVE_OAUTH_ERRORS = Object.freeze({
  PKCE_REQUIRED: 'A native sign-in must send a PKCE code_challenge (use signInWithOAuth, which does).',
  PKCE_MISMATCH: 'The code verifier did not match; start the sign-in again.',
  NATIVE_APP_NOT_REGISTERED: 'The app id is not registered; add it with POST /v1/native_apps.',
  CALLBACK_NOT_REGISTERED: "The redirect URL is not one of the app's callback_urls.",
  PROVIDER_NOT_ENABLED: 'The provider is not enabled on this instance.',
  APP_NOT_ALLOWED: "This publishable key is restricted to other apps; send the app's id (appId).",
  DEV_SCHEME_ON_PRODUCTION: 'exp:// callbacks are for development instances only.',
} as const);

export type NativeOAuthErrorCode = keyof typeof NATIVE_OAUTH_ERRORS;

// ── PKCE ────────────────────────────────────────────────────────────────────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Base64url, no padding. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63]!;
    if (i + 2 < bytes.length) out += B64[n & 63]!;
  }
  return out;
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Pure-JS SHA-256 for runtimes with no `crypto.subtle` (Hermes). */
export function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((data.length * 8) / 0x100000000));
  view.setUint32(padded.length - 4, (data.length * 8) >>> 0);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[];
    for (let i = 0; i < 64; i++) {
      const t1 = (hh! + (rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25)) + ((e! & f!) ^ (~e! & g!)) + K[i]! + w[i]!) | 0;
      const t2 = ((rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22)) + ((a! & b!) ^ (a! & c!) ^ (b! & c!))) | 0;
      hh = g; g = f; f = e; e = (d! + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0]! + a!) | 0; h[1] = (h[1]! + b!) | 0; h[2] = (h[2]! + c!) | 0; h[3] = (h[3]! + d!) | 0;
    h[4] = (h[4]! + e!) | 0; h[5] = (h[5]! + f!) | 0; h[6] = (h[6]! + g!) | 0; h[7] = (h[7]! + hh!) | 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  h.forEach((x, i) => ov.setUint32(i * 4, x));
  return out;
}

const asciiBytes = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** `SHA256(verifier)` base64url, the PKCE S256 challenge. `crypto.subtle` when present, else the pure-JS hash. */
export async function pkceChallengeFor(verifier: string): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  const bytes = asciiBytes(verifier);
  if (subtle) {
    try {
      return base64UrlEncode(new Uint8Array(await subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)));
    } catch {
      // Fall through (a non-secure context can expose a subtle that refuses).
    }
  }
  return base64UrlEncode(sha256(bytes));
}

/** A fresh PKCE pair: a 43-character verifier (32 random bytes) and its S256 challenge. Keep the verifier in memory. */
export async function createPkcePair(): Promise<{ codeVerifier: string; codeChallenge: string; codeChallengeMethod: 'S256' }> {
  const cryptoObj = (globalThis as { crypto?: { getRandomValues?: <T extends ArrayBufferView>(a: T) => T } }).crypto;
  if (!cryptoObj?.getRandomValues) {
    throw new Error('No secure random source: install react-native-get-random-values (or expo-crypto) before signing in with OAuth.');
  }
  const codeVerifier = base64UrlEncode(cryptoObj.getRandomValues(new Uint8Array(32)));
  return { codeVerifier, codeChallenge: await pkceChallengeFor(codeVerifier), codeChallengeMethod: 'S256' };
}

// ── start / redeem ──────────────────────────────────────────────────────────

/** Which start route a native sign-in uses: social OAuth (default), or an enterprise connection (OIDC SSO, SAML, WS-Federation). */
export type NativeSignInStrategy = 'oauth' | 'sso' | 'saml' | 'wsfed';

const START_PATHS: Record<NativeSignInStrategy, string> = {
  oauth: '/v1/client/sign_ins/oauth',
  sso: '/v1/client/sign_ins/sso',
  saml: '/v1/client/sign_ins/saml',
  wsfed: '/v1/client/sign_ins/wsfed',
};

export interface StartOAuthSignInInput {
  /** The start route to use. Default `'oauth'`; `'sso'`, `'saml'` and `'wsfed'` start an enterprise connection. */
  strategy?: NativeSignInStrategy;
  /** Social OAuth only (strategy `'oauth'`): the provider id. */
  provider?: string;
  /** Enterprise: the work email the connection is found by (its domain), sent as the route's `email`. Social OAuth: the route's `identifier`. */
  identifier?: string;
  /** Enterprise: the connection to use, instead of finding it by the identifier's domain. */
  connectionId?: string;
  /** The registered native app (`napp_…`). */
  nativeAppId?: string;
  /** The URL the provider flow ends at. Omit to use the hosted native callback. */
  redirectUrl?: string;
  /**
   * Which of the app's callback URLs the hosted callback forwards to (default: its first). Development instances may pass an
   * `exp://` URL. It is also the URL the system browser watches for, so pass it whenever the app has more than one.
   */
  callback?: string;
  /** From {@link createPkcePair}. */
  codeChallenge: string;
}

export interface StartOAuthSignInResult {
  authorizationUrl: string | null;
  attemptId: string | null;
  /** The redirect URL the server actually used. */
  redirectUrl: string | null;
  /** The app URL the browser lands on at the end (the auth session waits for this one, not the hosted https hop). */
  callbackUrl: string | null;
  errors: FieldError[];
}

/** `POST /v1/client/sign_ins/oauth` (or the enterprise start route for `strategy`) with a PKCE challenge. */
export async function startOAuthSignIn(client: FapiClient, input: StartOAuthSignInInput): Promise<StartOAuthSignInResult> {
  const strategy = input.strategy ?? 'oauth';
  const who =
    strategy === 'oauth'
      ? { provider: input.provider, ...(input.identifier ? { identifier: input.identifier } : {}) }
      : { ...(input.identifier ? { email: input.identifier } : {}), ...(input.connectionId ? { connection_id: input.connectionId } : {}) };
  const res = await client.post<{ authorization_url?: string; attempt_id?: string; redirect_url?: string; callback_url?: string }>(START_PATHS[strategy], {
    ...who,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
    ...(input.nativeAppId ? { native_app_id: input.nativeAppId } : {}),
    ...(input.redirectUrl ? { redirect_url: input.redirectUrl } : {}),
    ...(input.callback ? { callback: input.callback } : {}),
  });
  return {
    authorizationUrl: res.data?.authorization_url ?? null,
    attemptId: res.data?.attempt_id ?? null,
    redirectUrl: res.data?.redirect_url ?? null,
    callbackUrl: res.data?.callback_url ?? null,
    errors: res.errors,
  };
}

/** The native session body `POST /v1/client/sign_ins/oauth/token` returns. */
export interface OAuthSessionBody {
  object?: string;
  jwt: string;
  session_id?: string;
  user_id?: string;
  refresh_token?: string;
  expires_in?: number;
}

/** `POST /v1/client/sign_ins/oauth/token`: trade the callback's `__atlas_code` and your verifier for the session. It serves every native sign-in, social or enterprise. */
export async function redeemOAuthCode(
  client: FapiClient,
  input: { attemptId: string; code: string; codeVerifier: string },
): Promise<{ session: OAuthSessionBody | null; errors: FieldError[] }> {
  const res = await client.post<OAuthSessionBody>('/v1/client/sign_ins/oauth/token', {
    attempt_id: input.attemptId,
    code: input.code,
    code_verifier: input.codeVerifier,
  });
  return { session: res.ok && res.data?.jwt ? res.data : null, errors: res.errors };
}

// ── the whole flow ──────────────────────────────────────────────────────────

/** The system browser, injected: `expo-web-browser`'s `openAuthSessionAsync`, or any ASWebAuthenticationSession / Custom Tab wrapper. */
export interface NativeAuthBrowser {
  openAuthSession(
    url: string,
    redirectUrl: string,
    options: { preferEphemeralSession: boolean },
  ): Promise<{ type: 'success'; url: string } | { type: 'cancel' | 'dismiss' }>;
}

export type NativeOAuthResult =
  | { status: 'complete'; session: OAuthSessionBody; attemptId: string }
  | { status: 'cancelled' }
  /** `codeVerifier` finishes the attempt later: pass it to `flow.resumeAttempt` so the final ticket is redeemed with PKCE. */
  | { status: 'needs_second_factor' | 'needs_required_action'; attemptId: string; attemptStatus: string; policyToken?: string; codeVerifier: string }
  | { status: 'error'; errors: FieldError[] };

export interface NativeOAuthOptions {
  /** Social OAuth (strategy `'oauth'`, the default): the provider id. */
  provider?: string;
  /** `'oauth'` (default), or `'sso'` / `'saml'` / `'wsfed'` to sign in through an enterprise connection. */
  strategy?: NativeSignInStrategy;
  /** Enterprise: the work email whose domain finds the connection. */
  identifier?: string;
  /** Enterprise: the connection id (alternative to `identifier`). */
  connectionId?: string;
  browser: NativeAuthBrowser;
  nativeAppId?: string;
  redirectUrl?: string;
  callback?: string;
  /** Share no cookies with the browser (iOS); default false so an existing provider login is reused. */
  preferEphemeralSession?: boolean;
  /** Set when the app runs in a WebView by other means than `window.ReactNativeWebView`. */
  inWebView?: boolean;
  /** Called with the redirect URL the server used (dev builds log it). */
  onStarted?: (info: { redirectUrl: string; attemptId: string }) => void;
}

const fail = (code: string, message: string): NativeOAuthResult => ({ status: 'error', errors: [{ code, message }] });

/** Providers refuse OAuth inside an embedded WebView (RFC 8252 §8.12); so does this. */
export function insideWebView(): boolean {
  return Boolean((globalThis as { ReactNativeWebView?: unknown }).ReactNativeWebView) ||
    Boolean((globalThis as { window?: { ReactNativeWebView?: unknown } }).window?.ReactNativeWebView);
}

/**
 * Sign in with a provider: PKCE pair, start, system browser, parse the callback, redeem the code. Never throws
 * for a cancelled browser (`cancelled`) or a server refusal (`error` with the server's messages). The caller
 * stores `session.jwt` (and `refresh_token`).
 */
export async function signInWithNativeBrowser(client: FapiClient, opts: NativeOAuthOptions): Promise<NativeOAuthResult> {
  if (opts.inWebView ?? insideWebView()) {
    return fail('WEBVIEW_NOT_ALLOWED', 'OAuth sign-in cannot run inside a WebView: providers refuse it. Open the system browser instead.');
  }
  const strategy = opts.strategy ?? 'oauth';
  if (strategy === 'oauth' && !opts.provider) return fail('PROVIDER_REQUIRED', 'A provider is required for an OAuth sign-in.');
  if (strategy !== 'oauth' && !opts.identifier && !opts.connectionId) return fail('IDENTIFIER_REQUIRED', 'An identifier (work email) or connectionId is required for an enterprise sign-in.');
  let pkce;
  try {
    pkce = await createPkcePair();
  } catch (e) {
    return fail('NO_SECURE_RANDOM', e instanceof Error ? e.message : 'No secure random source.');
  }
  const started = await startOAuthSignIn(client, {
    strategy,
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.identifier ? { identifier: opts.identifier } : {}),
    ...(opts.connectionId ? { connectionId: opts.connectionId } : {}),
    codeChallenge: pkce.codeChallenge,
    ...(opts.nativeAppId ? { nativeAppId: opts.nativeAppId } : {}),
    ...(opts.redirectUrl ? { redirectUrl: opts.redirectUrl } : {}),
    ...(opts.callback ? { callback: opts.callback } : {}),
  });
  if (!started.authorizationUrl || !started.attemptId || !started.redirectUrl) {
    return started.errors.length ? { status: 'error', errors: started.errors } : fail('OAUTH_START_FAILED', 'Could not start the sign-in.');
  }
  opts.onStarted?.({ redirectUrl: started.redirectUrl, attemptId: started.attemptId });

  let outcome;
  try {
    outcome = await opts.browser.openAuthSession(started.authorizationUrl, started.callbackUrl ?? opts.callback ?? opts.redirectUrl ?? started.redirectUrl, { preferEphemeralSession: opts.preferEphemeralSession ?? false });
  } catch {
    return { status: 'cancelled' };
  }
  if (outcome.type !== 'success') return { status: 'cancelled' };

  const q = outcome.url.indexOf('?');
  const query = q < 0 ? '' : outcome.url.slice(q + 1).split('#')[0]!;
  // The provider refused or the person backed out at the provider: Atlas returns `__atlas_error` instead of a code.
  const returnedError = new URLSearchParams(query).get('__atlas_error');
  if (returnedError) return returnedError === 'access_denied' ? { status: 'cancelled' } : fail(returnedError.toUpperCase(), 'The sign-in could not be completed with that provider.');
  const result = readRedirectResult(query);
  if (!result) return fail('NO_REDIRECT', 'No Atlas redirect params found.');
  // A callback for some other attempt is never redeemed with this attempt's verifier.
  if (result.attemptId !== started.attemptId) return fail('ATTEMPT_MISMATCH', 'The sign-in callback belongs to a different attempt.');
  if (result.code) {
    const redeemed = await redeemOAuthCode(client, { attemptId: result.attemptId, code: result.code, codeVerifier: pkce.codeVerifier });
    return redeemed.session
      ? { status: 'complete', session: redeemed.session, attemptId: result.attemptId }
      : { status: 'error', errors: redeemed.errors.length ? redeemed.errors : [{ code: 'EXCHANGE_FAILED', message: 'Could not complete sign-in.' }] };
  }
  if (result.ticket) return fail('PKCE_REQUIRED', 'The callback carried a ticket instead of a PKCE code; refusing it.');
  const status = result.status ?? '';
  return {
    status: status === 'needs_second_factor' ? 'needs_second_factor' : 'needs_required_action',
    attemptId: result.attemptId,
    attemptStatus: status,
    ...(result.policyToken ? { policyToken: result.policyToken } : {}),
    codeVerifier: pkce.codeVerifier,
  };
}
