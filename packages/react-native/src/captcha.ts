/**
 * Atlas's own captcha (provider `atlas`) for React Native. The browser solver
 * needs Web Workers and `crypto.subtle`, which Hermes and JavaScriptCore do not
 * have, so this one is plain JavaScript: SHA-256 from `@noble/hashes`, run in
 * short slices that hand the thread back to the event loop between them, and
 * cancellable through an `AbortSignal`.
 *
 * Importing this package installs it as the headless solver of `@atlasauth/js`,
 * so `createSignInFlow`, `createSignUpFlow` and the password reset answer a
 * captcha with no code from your app.
 */
import { sha256 } from '@noble/hashes/sha256';
import {
  fetchAtlasChallenge,
  setHeadlessCaptchaSolver,
  type AtlasChallenge,
  type FlowCaptcha,
  type HeadlessCaptchaSolver,
} from '@atlasauth/js';

export interface SolveCaptchaOptions {
  /** Cancels the work; the promise rejects with `captcha: cancelled`. */
  signal?: AbortSignal;
  /** How long to hash before yielding to the event loop, in milliseconds (default 8). */
  sliceMs?: number;
  /** Yield between slices. Defaults to `setTimeout(0)`. */
  yieldFn?: () => Promise<void>;
}

const defaultYield = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** UTF-8 bytes without `TextEncoder` (older Hermes builds lack it). */
function utf8(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url without padding, with no `btoa`. */
function base64url(bytes: number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63]!;
    if (i + 2 < bytes.length) out += B64[n & 63]!;
  }
  return out;
}

/**
 * Find n in [0, maxnumber] with SHA-256(salt + n) = challenge (hex). Yields to
 * the event loop every `sliceMs`, and throws `captcha: cancelled` when `signal`
 * aborts.
 */
export async function solveAtlasChallengeNative(
  c: Pick<AtlasChallenge, 'salt' | 'challenge' | 'maxnumber'>,
  opts: SolveCaptchaOptions = {},
): Promise<number> {
  const target = c.challenge.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(target)) throw new Error('captcha: bad challenge');
  const want = new Uint8Array(32);
  for (let i = 0; i < 32; i++) want[i] = parseInt(target.slice(i * 2, i * 2 + 2), 16);
  const prefix = utf8(c.salt);
  const buf = new Uint8Array(prefix.length + 16);
  buf.set(prefix, 0);
  const sliceMs = opts.sliceMs ?? 8;
  const yieldFn = opts.yieldFn ?? defaultYield;
  let sliceStart = Date.now();
  for (let n = 0; n <= c.maxnumber; n++) {
    // Check the clock every 64 hashes: cheap, and a slice stays near sliceMs.
    if ((n & 63) === 0) {
      if (opts.signal?.aborted) throw new Error('captcha: cancelled');
      if (Date.now() - sliceStart >= sliceMs) {
        await yieldFn();
        if (opts.signal?.aborted) throw new Error('captcha: cancelled');
        sliceStart = Date.now();
      }
    }
    let len = prefix.length;
    const digits = String(n);
    for (let i = 0; i < digits.length; i++) buf[len++] = digits.charCodeAt(i);
    const got = sha256(buf.subarray(0, len));
    let same = true;
    for (let i = 0; i < 32; i++) {
      if (got[i] !== want[i]) {
        same = false;
        break;
      }
    }
    if (same) return n;
  }
  throw new Error('captcha: no solution');
}

export interface GetCaptchaTokenOptions extends SolveCaptchaOptions {
  /** Fetch the challenge yourself (e.g. through your own proxy). Defaults to a GET of `challengeUrl`. */
  fetchChallenge?: (accessible: boolean) => Promise<AtlasChallenge>;
}

/**
 * Solve Atlas's captcha and return the `captcha_token` to send with the flow's
 * request. `captcha` is the flow's settings (`step.captcha` on a headless flow,
 * or `getInstanceSettings().captchaFlows.signIn`). When the server asks for the
 * picture check, the no-picture alternative (more work instead) is used, since
 * there is nothing to draw here.
 */
export async function getCaptchaToken(
  captcha: Pick<FlowCaptcha, 'provider' | 'challengeUrl'>,
  opts: GetCaptchaTokenOptions = {},
): Promise<string> {
  if (captcha.provider !== 'atlas') throw new Error(`captcha: ${captcha.provider ?? 'none'} cannot be solved without a browser`);
  const fetchChallenge =
    opts.fetchChallenge ??
    ((accessible: boolean) => {
      if (!captcha.challengeUrl) return Promise.reject(new Error('captcha: no challenge URL'));
      return fetchAtlasChallenge(captcha.challengeUrl, accessible);
    });
  let challenge = await fetchChallenge(false);
  if (challenge.interactive) {
    if (!challenge.accessible_alternative) throw new Error('captcha: needs the picture check');
    challenge = await fetchChallenge(true);
    if (challenge.interactive) throw new Error('captcha: needs the picture check');
  }
  const started = Date.now();
  const n = await solveAtlasChallengeNative(challenge, opts);
  const json = JSON.stringify({ t: challenge.token, n, ms: Date.now() - started });
  return `atlas1.${base64url(utf8(json))}`;
}

/** The headless solver: answers Atlas's own captcha, leaves every other provider to your app. */
export const atlasHeadlessCaptchaSolver: HeadlessCaptchaSolver = async (captcha, ctx) =>
  captcha.provider === 'atlas' ? getCaptchaToken(captcha, { signal: ctx.signal }) : null;

/** Install {@link atlasHeadlessCaptchaSolver} (done on import; call again after `setHeadlessCaptchaSolver(null)`). */
export function installAtlasCaptchaSolver(): void {
  setHeadlessCaptchaSolver(atlasHeadlessCaptchaSolver);
}

installAtlasCaptchaSolver();
