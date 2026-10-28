import { decodeProtectedHeader, jwtDecrypt } from 'jose';

/**
 * Reading the session a self-hosted auth framework left in the browser, so a
 * returning user can be exchanged for an Atlas session without signing in
 * again (the zero-logout bridge).
 *
 * Every framework here keeps its session in one of two shapes:
 *
 *   - an opaque id the framework looks up in its own store (Auth.js database
 *     sessions, Lucia, express-session, Django's database sessions): the cookie
 *     carries the id, the migration import carries the rows, and the bridge
 *     only has to pull the id out of the cookie ({@link authJsSessionTokenKind},
 *     {@link unsignExpressSessionCookie}, {@link luciaSessionId});
 *   - a sealed or signed cookie that IS the session (Auth.js JWT sessions,
 *     iron-session, Rails' cookie store under Devise, Django's signed-cookie
 *     sessions): only the app's own secret opens it
 *     ({@link decodeAuthJsSessionToken}, {@link unsealIronSession},
 *     {@link decryptRailsCookie}, {@link decodeDjangoSignedCookie}).
 *
 * Each reader mirrors the framework's own source format exactly and FAILS
 * CLOSED: a malformed, forged, expired or wrongly-keyed value is `null`, never
 * a throw. Web Crypto only (plus jose, which Auth.js itself uses), so the same
 * code runs in Node, edge middleware and the Atlas API.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

function bytes(input: string): Uint8Array<ArrayBuffer> {
  return enc.encode(input);
}

function fromBase64(input: string): Uint8Array<ArrayBuffer> | null {
  const std = input.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(std) || std.length % 4 === 1) return null;
  const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64(input: Uint8Array, url: boolean): string {
  let bin = '';
  for (const b of input) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  return url ? b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : b64;
}

function hex(input: Uint8Array): string {
  let out = '';
  for (const b of input) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Length-safe constant-time comparison of two strings. */
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmac(hash: 'SHA-1' | 'SHA-256' | 'SHA-512', key: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

async function digest(hash: 'SHA-1' | 'SHA-256', data: Uint8Array<ArrayBuffer>) {
  return new Uint8Array(await crypto.subtle.digest(hash, data));
}

async function pbkdf2(
  hash: 'SHA-1' | 'SHA-256',
  password: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
  length: number,
) {
  const k = await crypto.subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash, salt, iterations }, k, length * 8));
}

async function hkdfSha256(ikm: Uint8Array<ArrayBuffer>, salt: string, info: string, length: number) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: bytes(salt), info: bytes(info) }, k, length * 8),
  );
}

function asList(value: string | readonly string[]): string[] {
  return (typeof value === 'string' ? [value] : [...value]).filter((v) => typeof v === 'string' && v.length > 0);
}

function decodeCookieValue(raw: string): string | null {
  const value = raw.trim();
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Every `name=value` pair of a `Cookie` header (first occurrence wins). */
function cookieMap(header: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!out.has(name)) out.set(name, part.slice(eq + 1).trim());
  }
  return out;
}

// ── Auth.js / NextAuth ──────────────────────────────────────────────────────

/** Auth.js v5 (`@auth/core`) and NextAuth v4 session cookie names, `__Secure-` first. */
export const AUTHJS_SESSION_COOKIES = [
  '__Secure-authjs.session-token',
  'authjs.session-token',
  '__Secure-next-auth.session-token',
  'next-auth.session-token',
] as const;

/**
 * The Auth.js session cookie from a `Cookie` header, reassembled when Auth.js
 * split it into `<name>.0`, `<name>.1`, … chunks (it does above ~4 KB). `name`
 * is the base cookie name — the HKDF salt of a v5 JWT. `cookieName` overrides
 * the defaults when the app set `cookies.sessionToken.name`.
 */
export function readAuthJsSessionCookie(
  cookieHeader: string | null | undefined | Record<string, string>,
  options: { cookieName?: string } = {},
): { name: string; value: string } | undefined {
  const cookies =
    typeof cookieHeader === 'object' && cookieHeader !== null ? new Map(Object.entries(cookieHeader)) : cookieMap(cookieHeader);
  const names = options.cookieName ? [options.cookieName] : [...AUTHJS_SESSION_COOKIES];
  for (const name of names) {
    const whole = cookies.get(name);
    if (whole) return { name, value: whole };
    const chunks: string[] = [];
    for (let i = 0; cookies.has(`${name}.${i}`); i++) chunks.push(cookies.get(`${name}.${i}`)!);
    if (chunks.length) return { name, value: chunks.join('') };
  }
  return undefined;
}

/**
 * Which session strategy produced a cookie value: a five-part compact JWE is a
 * JWT-strategy session; anything else is a database session token (the
 * `sessionToken` column of the adapter's sessions table).
 */
export function authJsSessionTokenKind(value: string): 'jwt' | 'database' | null {
  const v = decodeCookieValue(value);
  if (!v || v.length > 16_384) return null;
  if (/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]*){4}$/.test(v)) return 'jwt';
  return /^[A-Za-z0-9_\-.]{8,512}$/.test(v) ? 'database' : null;
}

/** The claims of a decrypted Auth.js session JWT (whatever the `jwt` callback put in it). */
export interface AuthJsSessionClaims {
  sub?: string;
  email?: string | null;
  name?: string | null;
  picture?: string | null;
  exp?: number;
  iat?: number;
  [claim: string]: unknown;
}

/**
 * Decrypt an Auth.js JWT-strategy session cookie with the app's secret
 * (`AUTH_SECRET` / `NEXTAUTH_SECRET`; pass every rotated secret, newest first).
 *
 *   - NextAuth v4: `dir` + `A256GCM`, key = HKDF-SHA256(secret, salt "", info
 *     "NextAuth.js Generated Encryption Key", 32 bytes).
 *   - Auth.js v5 (`@auth/core`): `dir` + `A256CBC-HS512` (or `A256GCM`), key =
 *     HKDF-SHA256(secret, salt = the cookie name, info
 *     "Auth.js Generated Encryption Key (<cookie name>)", 64 / 32 bytes).
 *
 * `salt` is the cookie the value came from (from {@link readAuthJsSessionCookie}).
 * The JWT's `exp` is enforced with Auth.js's own 15 s tolerance.
 */
export async function decodeAuthJsSessionToken(
  token: string,
  options: { secret: string | readonly string[]; salt: string; now?: Date },
): Promise<AuthJsSessionClaims | null> {
  const value = decodeCookieValue(token);
  if (!value || authJsSessionTokenKind(value) !== 'jwt') return null;
  let encAlg: string | undefined;
  try {
    const header = decodeProtectedHeader(value);
    if (header.alg !== 'dir') return null;
    encAlg = header.enc;
  } catch {
    return null;
  }
  if (encAlg !== 'A256GCM' && encAlg !== 'A256CBC-HS512') return null;
  const candidates: Uint8Array<ArrayBuffer>[] = [];
  for (const secret of asList(options.secret)) {
    const ikm = bytes(secret);
    if (encAlg === 'A256CBC-HS512') {
      candidates.push(await hkdfSha256(ikm, options.salt, `Auth.js Generated Encryption Key (${options.salt})`, 64));
    } else {
      candidates.push(await hkdfSha256(ikm, options.salt, `Auth.js Generated Encryption Key (${options.salt})`, 32));
      candidates.push(await hkdfSha256(ikm, '', 'NextAuth.js Generated Encryption Key', 32));
    }
  }
  for (const key of candidates) {
    try {
      const { payload } = await jwtDecrypt(value, key, {
        keyManagementAlgorithms: ['dir'],
        contentEncryptionAlgorithms: [encAlg],
        clockTolerance: 15,
        ...(options.now ? { currentDate: options.now } : {}),
      });
      return payload as AuthJsSessionClaims;
    } catch {
      // wrong key, tampered, or expired: try the next secret
    }
  }
  return null;
}

// ── express-session (Passport) ──────────────────────────────────────────────

/** express-session's default cookie name. */
export const EXPRESS_SESSION_COOKIE = 'connect.sid';

/**
 * The session id inside an express-session cookie (`s:<sid>.<signature>`,
 * URL-encoded), where the signature is cookie-signature's
 * base64(HMAC-SHA256(secret, sid)) without padding. With `secrets` (the app's
 * `session({ secret })`, a string or the rotation array) the signature must
 * verify against one of them; without, the id is only parsed — the session id
 * is itself a 24-byte random bearer value, so a store lookup by id is what
 * authenticates it either way.
 */
export async function unsignExpressSessionCookie(
  raw: string,
  secrets?: string | readonly string[],
): Promise<string | null> {
  const value = decodeCookieValue(raw);
  if (!value || !value.startsWith('s:') || value.length > 1024) return null;
  const body = value.slice(2);
  const dot = body.lastIndexOf('.');
  if (dot <= 0) return null;
  const sid = body.slice(0, dot);
  const signature = body.slice(dot + 1);
  if (!/^[A-Za-z0-9_\-+/=]+$/.test(sid)) return null;
  if (secrets === undefined) return sid;
  for (const secret of asList(secrets)) {
    const expected = toBase64(await hmac('SHA-256', bytes(secret), bytes(sid)), false).replace(/=+$/, '');
    if (sameString(expected, signature)) return sid;
  }
  return null;
}

// ── Lucia ───────────────────────────────────────────────────────────────────

/** Lucia's default session cookie name (v2 and v3). */
export const LUCIA_SESSION_COOKIE = 'auth_session';

/**
 * The id a Lucia session row is stored under, from the cookie's token. Lucia
 * v2/v3 store the cookie value itself (`none`); the current Lucia guide's
 * session implementation stores `hex(sha256(token))` (`sha256-hex`).
 */
export async function luciaSessionId(token: string, hashing: 'none' | 'sha256-hex' = 'none'): Promise<string | null> {
  const value = decodeCookieValue(token);
  if (!value || !/^[A-Za-z0-9_-]{8,256}$/.test(value)) return null;
  return hashing === 'none' ? value : hex(await digest('SHA-256', bytes(value)));
}

// ── iron-session ────────────────────────────────────────────────────────────

/**
 * Open an iron-session cookie (an `@hapi/iron` `Fe26.2` seal, with iron-session
 * v8's `~2` version suffix) with the app's `password` — a string, or the
 * `{ id: password }` rotation map. Mirrors iron: HMAC-SHA256 integrity and
 * AES-256-CBC, each keyed by PBKDF2-SHA1(password, the seal's salt, 1 iteration,
 * 32 bytes); the seal's own expiry is enforced (60 s skew, as iron does).
 * Returns the session object the app stored.
 */
export async function unsealIronSession<T = Record<string, unknown>>(
  raw: string,
  password: string | Readonly<Record<string, string>>,
  options: { now?: Date } = {},
): Promise<T | null> {
  const value = decodeCookieValue(raw);
  if (!value || value.length > 16_384) return null;
  const [seal, version] = value.split('~');
  const parts = (seal ?? '').split('*');
  if (parts.length !== 8 || parts[0] !== 'Fe26.2') return null;
  const [, passwordId, encSalt, encIv, encrypted, expiration, hmacSalt, mac] = parts as [
    string, string, string, string, string, string, string, string,
  ];
  const secret =
    typeof password === 'string'
      ? passwordId === '' || passwordId === '1'
        ? password
        : undefined
      : password[passwordId || 'default'];
  if (!secret) return null;
  const now = (options.now ?? new Date()).getTime();
  if (expiration) {
    const exp = Number(expiration);
    if (!Number.isFinite(exp) || exp <= now - 60_000) return null;
  }
  const integrityKey = await pbkdf2('SHA-1', bytes(secret), bytes(hmacSalt), 1, 32);
  const expectedMac = toBase64(await hmac('SHA-256', integrityKey, bytes(parts.slice(0, 6).join('*'))), true);
  if (!sameString(expectedMac, mac)) return null;
  const iv = fromBase64(encIv);
  const ciphertext = fromBase64(encrypted);
  if (!iv || iv.length !== 16 || !ciphertext) return null;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      await pbkdf2('SHA-1', bytes(secret), bytes(encSalt), 1, 32),
      'AES-CBC',
      false,
      ['decrypt'],
    );
    const plain = dec.decode(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, ciphertext));
    const data = JSON.parse(plain) as Record<string, unknown>;
    // iron-session v8 reads a seal without the `~2` suffix as an older one whose
    // data sits under `persistent`.
    if (version !== '2' && data && typeof data.persistent === 'object' && data.persistent !== null) {
      return data.persistent as T;
    }
    return data as T;
  } catch {
    return null;
  }
}

/** Read `path` (`"user.id"`) out of a session object, as a non-empty string. */
export function sessionValueAt(data: unknown, path: string): string | null {
  let cur: unknown = data;
  for (const key of path.split('.')) {
    if (!cur || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  if (typeof cur === 'number' && Number.isFinite(cur)) return String(cur);
  return typeof cur === 'string' && cur.length > 0 ? cur : null;
}

// ── Rails cookie store (Devise / Warden) ────────────────────────────────────

/**
 * Decrypt a Rails encrypted cookie — the session cookie of a Rails app using
 * the default cookie store, which is where Devise (through Warden) keeps the
 * signed-in user. Rails 5.2+ authenticated encryption:
 * `base64(ciphertext)--base64(iv)--base64(auth tag)`, AES-256-GCM, empty AAD,
 * key = PBKDF2(secret_key_base, "authenticated encrypted cookie", 1000
 * iterations, 32 bytes) with SHA-256 (Rails 7 default) or SHA-1 (apps that kept
 * `key_generator_hash_digest_class = SHA1`). Both are tried unless `keyDigest`
 * pins one. The `_rails` envelope's purpose (`cookie.<cookieName>`) and expiry
 * are enforced; JSON-serialized cookies only (`cookies_serializer :json` or
 * `:hybrid` — a Marshal-serialized cookie cannot be read outside Ruby).
 */
export async function decryptRailsCookie(
  raw: string,
  options: {
    secretKeyBase: string | readonly string[];
    cookieName?: string;
    keyDigest?: 'SHA-256' | 'SHA-1';
    salt?: string;
    now?: Date;
  },
): Promise<Record<string, unknown> | null> {
  const value = decodeCookieValue(raw);
  if (!value || value.length > 16_384) return null;
  const parts = value.split('--');
  if (parts.length !== 3) return null;
  const [ct, ivPart, tagPart] = parts.map((p) => fromBase64(p));
  if (!ct || !ivPart || !tagPart || ivPart.length !== 12 || tagPart.length !== 16) return null;
  const sealed = new Uint8Array(ct.length + tagPart.length);
  sealed.set(ct);
  sealed.set(tagPart, ct.length);
  const digests: Array<'SHA-256' | 'SHA-1'> = options.keyDigest ? [options.keyDigest] : ['SHA-256', 'SHA-1'];
  const salt = options.salt ?? 'authenticated encrypted cookie';
  let plain: string | null = null;
  outer: for (const secret of asList(options.secretKeyBase)) {
    for (const d of digests) {
      try {
        const raw = await pbkdf2(d, bytes(secret), bytes(salt), 1000, 32);
        const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
        plain = dec.decode(
          await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivPart, additionalData: new Uint8Array(0), tagLength: 128 }, key, sealed),
        );
        break outer;
      } catch {
        // wrong key: try the next one
      }
    }
  }
  if (plain === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain);
  } catch {
    return null; // Marshal (or another non-JSON serializer)
  }
  const envelope = (parsed as { _rails?: { message?: unknown; data?: unknown; exp?: unknown; pur?: unknown } } | null)?._rails;
  if (!envelope) return isRecord(parsed) ? parsed : null;
  if (options.cookieName && envelope.pur != null && envelope.pur !== `cookie.${options.cookieName}`) return null;
  if (typeof envelope.exp === 'string' && envelope.exp) {
    const exp = Date.parse(envelope.exp);
    if (!Number.isFinite(exp) || exp <= (options.now ?? new Date()).getTime()) return null;
  }
  let data: unknown = envelope.data;
  if (data === undefined && typeof envelope.message === 'string') {
    const inner = fromBase64(envelope.message);
    if (!inner) return null;
    try {
      data = JSON.parse(dec.decode(inner));
    } catch {
      return null;
    }
  }
  return isRecord(data) ? data : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The Devise user a Rails session holds: Warden stores
 * `warden.user.<scope>.key` = `[[id], authenticatable_salt]`, where the salt is
 * the first 29 characters of the user's bcrypt `encrypted_password` (so a
 * password change signs every session out — check it against the imported
 * hash with {@link deviseSaltMatches}).
 */
export function deviseSessionUser(
  session: Record<string, unknown>,
  scope = 'user',
): { id: string; salt: string | null } | null {
  const entry = session[`warden.user.${scope}.key`];
  if (!Array.isArray(entry) || entry.length < 1) return null;
  const ids = entry[0];
  const id = Array.isArray(ids) ? ids[0] : ids;
  const idText = typeof id === 'number' && Number.isFinite(id) ? String(id) : typeof id === 'string' && id ? id : null;
  if (!idText) return null;
  return { id: idText, salt: typeof entry[1] === 'string' ? entry[1] : null };
}

/** Devise's `authenticatable_salt`: the bcrypt digest's first 29 characters. */
export function deviseSaltMatches(salt: string | null, encryptedPassword: string | null | undefined): boolean {
  if (!salt || !encryptedPassword || encryptedPassword.length < 29) return false;
  return sameString(salt, encryptedPassword.slice(0, 29));
}

// ── Django ──────────────────────────────────────────────────────────────────

/** Django's default session cookie name (`SESSION_COOKIE_NAME`). */
export const DJANGO_SESSION_COOKIE = 'sessionid';

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function b62decode(s: string): number {
  let n = 0;
  for (const ch of s) {
    const i = B62.indexOf(ch);
    if (i < 0) return NaN;
    n = n * 62 + i;
  }
  return n;
}

/** Django's `salted_hmac(key_salt, value, secret, algorithm)`. */
async function djangoSaltedHmac(keySalt: string, value: string, secret: string, algorithm: 'sha256' | 'sha1') {
  const hash = algorithm === 'sha256' ? 'SHA-256' : 'SHA-1';
  const key = await digest(hash, bytes(keySalt + secret));
  return hmac(hash, key, bytes(value));
}

async function inflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array | null> {
  const DS = (globalThis as unknown as { DecompressionStream?: new (format: string) => unknown }).DecompressionStream;
  if (!DS) return null;
  try {
    const stream = new Blob([data]).stream().pipeThrough(new DS('deflate') as never);
    return new Uint8Array(await new Response(stream as ReadableStream).arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Verify and decode a value made by Django's `signing.dumps` — the session
 * cookie of `SESSION_ENGINE = "django.contrib.sessions.backends.signed_cookies"`.
 * Format `<payload>:<base62 timestamp>:<signature>`, payload = urlsafe base64 of
 * the JSON (zlib-compressed when it starts with `.`), signature = urlsafe
 * base64 of salted_hmac(salt + "signer", "<payload>:<timestamp>", SECRET_KEY)
 * with SHA-256 (Django ≥ 3.1) or SHA-1 (older). Pass SECRET_KEY first, then
 * SECRET_KEY_FALLBACKS. `maxAgeSeconds` is SESSION_COOKIE_AGE.
 */
export async function decodeDjangoSignedCookie(
  raw: string,
  options: {
    secretKey: string | readonly string[];
    salt?: string;
    maxAgeSeconds?: number;
    algorithm?: 'sha256' | 'sha1';
    now?: Date;
  },
): Promise<Record<string, unknown> | null> {
  const value = decodeCookieValue(raw)?.replace(/^"|"$/g, '');
  if (!value || value.length > 16_384) return null;
  const parts = value.split(':');
  if (parts.length !== 3) return null;
  const [payload, ts, signature] = parts as [string, string, string];
  const signed = `${payload}:${ts}`;
  const salt = options.salt ?? 'django.contrib.sessions.backends.signed_cookies';
  const algorithms: Array<'sha256' | 'sha1'> = options.algorithm ? [options.algorithm] : ['sha256', 'sha1'];
  let ok = false;
  for (const secret of asList(options.secretKey)) {
    for (const alg of algorithms) {
      const expected = toBase64(await djangoSaltedHmac(`${salt}signer`, signed, secret, alg), true);
      if (sameString(expected, signature)) ok = true;
    }
  }
  if (!ok) return null;
  const issued = b62decode(ts);
  if (!Number.isFinite(issued)) return null;
  if (options.maxAgeSeconds !== undefined) {
    const age = (options.now ?? new Date()).getTime() / 1000 - issued;
    if (age > options.maxAgeSeconds) return null;
  }
  return decodeDjangoPayload(payload);
}

/**
 * Decode a `signing.dumps` payload (the part before the timestamp) WITHOUT
 * verifying it — for rows read out of the app's own `django_session` table.
 */
export async function decodeDjangoPayload(payload: string): Promise<Record<string, unknown> | null> {
  const compressed = payload.startsWith('.');
  const raw = fromBase64(compressed ? payload.slice(1) : payload);
  if (!raw) return null;
  const json = compressed ? await inflate(raw) : raw;
  if (!json) return null;
  try {
    const data = JSON.parse(dec.decode(json)) as unknown;
    return isRecord(data) ? data : null;
  } catch {
    return null;
  }
}

/** The signed-in user of a Django session: `_auth_user_id` and `_auth_user_hash`. */
export function djangoSessionUser(data: Record<string, unknown>): { id: string; hash: string | null } | null {
  const id = data._auth_user_id;
  const idText = typeof id === 'number' ? String(id) : typeof id === 'string' && id ? id : null;
  if (!idText) return null;
  return { id: idText, hash: typeof data._auth_user_hash === 'string' ? data._auth_user_hash : null };
}

/**
 * Django's session auth hash for a user's stored password hash
 * (`AbstractBaseUser.get_session_auth_hash`): hex salted_hmac with SHA-256. A
 * session whose `_auth_user_hash` differs was signed out by a password change.
 */
export async function djangoSessionAuthHash(passwordHash: string, secretKey: string): Promise<string> {
  return hex(
    await djangoSaltedHmac('django.contrib.auth.models.AbstractBaseUser.get_session_auth_hash', passwordHash, secretKey, 'sha256'),
  );
}
