import { cbc } from '@noble/ciphers/aes';
import { hmac } from '@noble/hashes/hmac';
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { sha1 } from '@noble/hashes/sha1';
import { sha256 } from '@noble/hashes/sha256';
import type { MigrationTokenExtractor } from './migration-bridge';

/**
 * Open a WorkOS AuthKit session cookie on YOUR server, for the zero-logout bridge.
 *
 * The AuthKit SDKs (authkit-nextjs, authkit-remix / react-router, the TanStack
 * Start package) keep the session in the `wos-session` cookie, sealed with
 * `iron` (the `Fe26.2*…` format, optionally followed by iron-session's `~2`)
 * under WORKOS_COOKIE_PASSWORD. The sealed object carries the WorkOS access
 * token; the bridge exchanges that (preset `workos`). The Remix / React Router
 * SDKs wrap the seal in a signed cookie session (`<base64 json>.<signature>`
 * holding `{ jwt: <seal> }`): that wrapper is opened too, and the seal inside
 * is authenticated by its own HMAC.
 *
 *   migrationBridge({ source: 'workos', presetVars: { client_id },
 *     extractToken: workosSessionTokenExtractor({ password: process.env.WORKOS_COOKIE_PASSWORD! }) })
 *
 * The password never leaves your server. Pass several while one rotates.
 */
export function workosSessionTokenExtractor(options: {
  password: string | readonly string[];
  /** Cookie name (default `wos-session`, or WORKOS_COOKIE_NAME if you changed it). */
  cookieName?: string;
}): MigrationTokenExtractor {
  const passwords = (typeof options.password === 'string' ? [options.password] : [...options.password]).filter(Boolean);
  if (passwords.length === 0) throw new Error('workosSessionTokenExtractor: pass your WORKOS_COOKIE_PASSWORD.');
  const name = options.cookieName ?? 'wos-session';
  return ({ cookies }) => {
    const value = cookies[name];
    if (!value) return undefined;
    const seal = sealOf(value);
    if (!seal) return undefined;
    for (const password of passwords) {
      const payload = ironUnseal(seal, password);
      const token = payload ? accessToken(payload) : undefined;
      if (token) return token;
    }
    return undefined;
  };
}

const textEncoder = new TextEncoder();
/** iron refuses a timestamp more than a minute in the past (its default `timestampSkewSec`). */
const SKEW_MS = 60_000;

/** The `Fe26.2*…` seal out of a cookie value: raw, or inside a Remix-style signed cookie. */
function sealOf(value: string): string | undefined {
  let v = value;
  try {
    v = decodeURIComponent(value);
  } catch {
    // keep the raw value
  }
  if (v.startsWith('Fe26.')) return v;
  // Remix signed cookie: base64(JSON) "." signature. The JSON is `{ jwt: <seal> }`.
  const body = v.split('.')[0];
  if (!body) return undefined;
  try {
    const json = JSON.parse(decodeURIComponent(escape(atob(body.replace(/-/g, '+').replace(/_/g, '/'))))) as { jwt?: unknown };
    return typeof json?.jwt === 'string' && json.jwt.startsWith('Fe26.') ? json.jwt : undefined;
  } catch {
    return undefined;
  }
}

function accessToken(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  // iron-session v6 wrapped data as `{ persistent: … }`.
  const p = payload as { accessToken?: unknown; persistent?: { accessToken?: unknown } };
  const token = p.accessToken ?? p.persistent?.accessToken;
  return typeof token === 'string' && token.split('.').length === 3 ? token : undefined;
}

const b64u = (s: string): Uint8Array => {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b.padEnd(Math.ceil(b.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
};

/**
 * Unseal an iron `Fe26.2` string (iron-webcrypto defaults: PBKDF2-SHA1 with
 * one iteration over the UTF-8 salt string, AES-256-CBC, HMAC-SHA256 over the
 * first six parts). Returns the parsed object, or undefined for anything wrong
 * (bad MAC, expired, wrong password, malformed). Exported for tests.
 */
export function ironUnseal(sealed: string, password: string): unknown {
  try {
    const seal = sealed.split('~')[0]!;
    const parts = seal.split('*');
    if (parts.length !== 8 || parts[0] !== 'Fe26.2') return undefined;
    const [prefix, id, encSalt, iv, encrypted, expiration, hmacSalt, mac] = parts as [string, string, string, string, string, string, string, string];
    if (expiration) {
      if (!/^\d+$/.test(expiration)) return undefined;
      if (Number(expiration) <= Date.now() - SKEW_MS) return undefined;
    }
    const derive = (salt: string) => pbkdf2(sha1, textEncoder.encode(password), textEncoder.encode(salt), { c: 1, dkLen: 32 });
    const base = [prefix, id, encSalt, iv, encrypted, expiration].join('*');
    const expected = hmac(sha256, derive(hmacSalt), textEncoder.encode(base));
    const given = b64u(mac);
    if (given.length !== expected.length) return undefined;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected[i]! ^ given[i]!;
    if (diff !== 0) return undefined;
    const plain = cbc(derive(encSalt), b64u(iv)).decrypt(b64u(encrypted));
    return JSON.parse(new TextDecoder().decode(plain)) as unknown;
  } catch {
    return undefined;
  }
}
