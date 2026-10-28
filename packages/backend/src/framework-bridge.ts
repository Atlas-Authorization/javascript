import { SignJWT } from 'jose';
import {
  authJsSessionTokenKind,
  decodeAuthJsSessionToken,
  decodeDjangoSignedCookie,
  decryptRailsCookie,
  deviseSessionUser,
  djangoSessionUser,
  readAuthJsSessionCookie,
  sessionValueAt,
  unsealIronSession,
  unsignExpressSessionCookie,
  AUTHJS_SESSION_COOKIES,
  DJANGO_SESSION_COOKIE,
  EXPRESS_SESSION_COOKIE,
  LUCIA_SESSION_COOKIE,
} from './framework-sessions';
import type { MigrationTokenExtractor } from './migration-bridge';
import { registerMigrationBridgePreset, type MigrationBridgePreset } from './migration-presets';

/**
 * Zero-logout bridge for the SELF-HOSTED frameworks (Auth.js, Lucia,
 * Passport, iron-session, Devise, Django): their presets, and the token
 * extractors `migrationBridge({ extractToken })` takes.
 *
 * Two families:
 *
 *   - Database sessions (Auth.js database strategy, Lucia, express-session
 *     stores, Django's database backend, Rails' activerecord-session_store):
 *     preset mode `session_table`. The cookie carries an opaque id; Atlas finds
 *     sha256(id) among the sessions you imported. Lucia, Auth.js and Django
 *     cookies are read as they are; express-session's cookie is signed
 *     (`s:<id>.<signature>`), so {@link expressSessionExtractor} pulls the id out.
 *
 *   - Sealed cookies (Auth.js JWT strategy, iron-session, Rails' cookie store
 *     under Devise, Django's signed-cookie backend): there is no session row to
 *     import — the cookie IS the session, and only your app's secret opens it.
 *     The extractor opens it ON YOUR SERVER and hands Atlas a short-lived
 *     BRIDGE ASSERTION instead: an HS256 JWT (`iss` = `urn:atlas:bridge:<source>`,
 *     `sub` = the user id you exported, `jti` = the old session's id) signed
 *     with a bridge secret you generate and store in the bridge settings
 *     (`shared_secret`). Your AUTH_SECRET / secret_key_base / SECRET_KEY /
 *     iron password never leave your server; Atlas verifies the assertion,
 *     spends its `jti` once, and signs the user in.
 */

/** The issuer of a bridge assertion for a source. */
export function bridgeAssertionIssuer(source: string): string {
  return `urn:atlas:bridge:${source}`;
}

/** Lifetime of a bridge assertion: it is exchanged immediately, once. */
export const BRIDGE_ASSERTION_TTL_SECONDS = 120;

export interface BridgeAssertion {
  source: string;
  /** The source user id (the `user.id` your export wrote). */
  sub: string;
  /** The old session's own id, so the session exchanges once (single-use ledger). */
  sessionKey: string;
  email?: string | null;
  name?: string | null;
  /** The old session had already passed a second factor. */
  mfa?: boolean;
}

/** Sign a bridge assertion with the bridge secret (HS256). */
export async function signBridgeAssertion(assertion: BridgeAssertion, bridgeSecret: string, now: Date = new Date()): Promise<string> {
  if (!bridgeSecret || bridgeSecret.length < 32) throw new Error('The bridge secret must be at least 32 characters (generate one with `openssl rand -base64 48`).');
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({
    ...(assertion.email ? { email: assertion.email } : {}),
    ...(assertion.name ? { name: assertion.name } : {}),
    ...(assertion.mfa ? { amr: ['pwd', 'mfa'] } : {}),
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(bridgeAssertionIssuer(assertion.source))
    .setSubject(assertion.sub)
    .setJti(assertion.sessionKey)
    .setIssuedAt(iat)
    .setExpirationTime(iat + BRIDGE_ASSERTION_TTL_SECONDS)
    .sign(new TextEncoder().encode(bridgeSecret));
}

async function sha256Hex(value: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ── extractors ──────────────────────────────────────────────────────────────

/**
 * Auth.js / NextAuth, either session strategy. A database-session cookie is
 * returned as it is (preset `authjs`); a JWT-strategy cookie is decrypted with
 * `secret` (AUTH_SECRET / NEXTAUTH_SECRET, or the rotation list) and turned
 * into a bridge assertion (preset `authjs_jwt`, needs `bridgeSecret`).
 */
export function authJsExtractor(options: {
  secret?: string | readonly string[];
  bridgeSecret?: string;
  cookieName?: string;
}): MigrationTokenExtractor {
  return async ({ cookies }) => {
    const found = readAuthJsSessionCookie(cookies, { cookieName: options.cookieName });
    if (!found) return undefined;
    const kind = authJsSessionTokenKind(found.value);
    if (kind === 'database') return decodeURIComponent(found.value);
    if (kind !== 'jwt' || !options.secret || !options.bridgeSecret) return undefined;
    const claims = await decodeAuthJsSessionToken(found.value, { secret: options.secret, salt: found.name });
    if (!claims?.sub) return undefined;
    return signBridgeAssertion(
      {
        source: 'authjs',
        sub: claims.sub,
        sessionKey: typeof claims.jti === 'string' && claims.jti ? claims.jti : await sha256Hex(found.value),
        email: claims.email ?? null,
        name: claims.name ?? null,
      },
      options.bridgeSecret,
    );
  };
}

/**
 * Passport / express-session: the session id out of the signed `connect.sid`
 * cookie (preset `passport`). Pass `secrets` (your `session({ secret })`) to
 * check the signature as express-session does.
 */
export function expressSessionExtractor(options: { cookieName?: string; secrets?: string | readonly string[] } = {}): MigrationTokenExtractor {
  return async ({ cookies }) => {
    const raw = cookies[options.cookieName ?? EXPRESS_SESSION_COOKIE];
    if (!raw) return undefined;
    return (await unsignExpressSessionCookie(raw, options.secrets)) ?? undefined;
  };
}

/**
 * iron-session: unseal the cookie with your session password and assert the
 * user at `userIdPath` (default: `userId`, then `user.id`, then `id`).
 */
export function ironSessionExtractor(options: {
  cookieName: string;
  password: string | Readonly<Record<string, string>>;
  bridgeSecret: string;
  userIdPath?: string;
  emailPath?: string;
}): MigrationTokenExtractor {
  return async ({ cookies }) => {
    const raw = cookies[options.cookieName];
    if (!raw) return undefined;
    const data = await unsealIronSession(raw, options.password);
    if (!data) return undefined;
    const sub = options.userIdPath
      ? sessionValueAt(data, options.userIdPath)
      : (sessionValueAt(data, 'userId') ?? sessionValueAt(data, 'user.id') ?? sessionValueAt(data, 'id'));
    if (!sub) return undefined;
    return signBridgeAssertion(
      {
        source: 'iron_session',
        sub,
        sessionKey: await sha256Hex(raw),
        email: sessionValueAt(data, options.emailPath ?? 'user.email') ?? sessionValueAt(data, 'email'),
      },
      options.bridgeSecret,
    );
  };
}

/**
 * Devise on Rails' cookie store: decrypt `_<app>_session` with
 * `secret_key_base` and assert the Warden user (`scope`, default `user`).
 */
export function deviseExtractor(options: {
  cookieName: string;
  secretKeyBase: string | readonly string[];
  bridgeSecret: string;
  scope?: string;
  keyDigest?: 'SHA-256' | 'SHA-1';
}): MigrationTokenExtractor {
  return async ({ cookies }) => {
    const raw = cookies[options.cookieName];
    if (!raw) return undefined;
    const session = await decryptRailsCookie(raw, {
      secretKeyBase: options.secretKeyBase,
      cookieName: options.cookieName,
      ...(options.keyDigest ? { keyDigest: options.keyDigest } : {}),
    });
    const user = session ? deviseSessionUser(session, options.scope) : null;
    if (!user) return undefined;
    const sid = typeof session!.session_id === 'string' && session!.session_id ? session!.session_id : await sha256Hex(raw);
    return signBridgeAssertion({ source: 'devise', sub: user.id, sessionKey: sid }, options.bridgeSecret);
  };
}

/**
 * Django's signed-cookie session backend: verify the cookie with SECRET_KEY
 * (then SECRET_KEY_FALLBACKS) and assert `_auth_user_id`.
 */
export function djangoSignedCookieExtractor(options: {
  secretKey: string | readonly string[];
  bridgeSecret: string;
  cookieName?: string;
  /** SESSION_COOKIE_AGE (default two weeks). */
  maxAgeSeconds?: number;
}): MigrationTokenExtractor {
  return async ({ cookies }) => {
    const raw = cookies[options.cookieName ?? DJANGO_SESSION_COOKIE];
    if (!raw) return undefined;
    const data = await decodeDjangoSignedCookie(raw, { secretKey: options.secretKey, maxAgeSeconds: options.maxAgeSeconds ?? 1209600 });
    const user = data ? djangoSessionUser(data) : null;
    if (!user) return undefined;
    return signBridgeAssertion({ source: 'django', sub: user.id, sessionKey: await sha256Hex(raw) }, options.bridgeSecret);
  };
}

// ── presets ─────────────────────────────────────────────────────────────────

const AUTHJS_COOKIES = [...AUTHJS_SESSION_COOKIES];
const AUTHJS_CLEAR = [
  ...AUTHJS_SESSION_COOKIES.map((c) => `${c}*`),
  '__Host-authjs.csrf-token',
  'authjs.csrf-token',
  '__Secure-authjs.callback-url',
  'authjs.callback-url',
  '__Host-next-auth.csrf-token',
  'next-auth.csrf-token',
  '__Secure-next-auth.callback-url',
  'next-auth.callback-url',
];

/** A sealed-cookie preset: Atlas verifies the bridge assertion with the stored shared secret. */
function assertionPreset(id: string, source: string, label: string, cookies: string[], extra: Partial<MigrationBridgePreset>): MigrationBridgePreset {
  return {
    id,
    label,
    mode: 'jwt',
    jwt: {
      issuer: bridgeAssertionIssuer(source),
      algorithms: ['HS256'],
      allowSharedSecret: true,
      claims: { subject: 'sub', email: 'email', name: 'name', sessionKey: 'jti', mfa: 'amr:mfa' },
    },
    cookies,
    ...extra,
  };
}

const FRAMEWORK_PRESETS: MigrationBridgePreset[] = [
  {
    id: 'authjs',
    label: 'Auth.js (database sessions)',
    mode: 'session_table',
    cookies: AUTHJS_COOKIES,
    clearCookies: AUTHJS_CLEAR,
    notes: 'Database strategy: the cookie is the sessionToken your adapter stored; import the sessions table. With the JWT strategy use the authjs_jwt preset.',
  },
  assertionPreset('authjs_jwt', 'authjs', 'Auth.js (JWT sessions)', AUTHJS_COOKIES, {
    clearCookies: AUTHJS_CLEAR,
    notes:
      'The cookie is a JWE encrypted with AUTH_SECRET. Pass authJsExtractor({ secret: AUTH_SECRET, bridgeSecret }) to the middleware: it decrypts the cookie on your server and sends a one-time bridge assertion signed with the bridge secret stored in these settings.',
  }),
  {
    id: 'lucia',
    label: 'Lucia',
    mode: 'session_table',
    defaults: { cookie_name: LUCIA_SESSION_COOKIE },
    cookies: ['{cookie_name}'],
    notes: 'The cookie holds the session token; the export hashes v2/v3 session ids, and reads guide-style sessions (id = sha256 of the token) as they are.',
  },
  {
    id: 'passport',
    label: 'Passport.js (express-session)',
    mode: 'session_table',
    defaults: { cookie_name: EXPRESS_SESSION_COOKIE },
    cookies: ['{cookie_name}'],
    notes: 'The connect.sid cookie is signed (s:<id>.<signature>): pass expressSessionExtractor() to the middleware so Atlas gets the session id. Import the sessions from your express-session store.',
  },
  assertionPreset('iron_session', 'iron_session', 'iron-session', ['{cookie_name}'], {
    vars: { cookie_name: 'The iron-session cookieName' },
    notes: 'Pass ironSessionExtractor({ cookieName, password, bridgeSecret }) to the middleware: it unseals the cookie with your session password on your server.',
  }),
  assertionPreset('devise', 'devise', 'Devise (Rails cookie store)', ['{cookie_name}'], {
    vars: { cookie_name: 'The Rails session cookie (_yourapp_session)' },
    clearCookies: ['{cookie_name}', 'remember_user_token'],
    notes: 'Pass deviseExtractor({ cookieName, secretKeyBase, bridgeSecret }) to the middleware (Node in front of, or beside, the Rails app): it decrypts the session cookie with secret_key_base on your server. JSON cookie serializer only.',
  }),
  {
    id: 'devise_active_record',
    label: 'Devise (activerecord-session_store)',
    mode: 'session_table',
    vars: { cookie_name: 'The Rails session cookie (_yourapp_session)' },
    cookies: ['{cookie_name}'],
    clearCookies: ['{cookie_name}', 'remember_user_token'],
    notes: 'The cookie holds the public session id; Atlas matches sha256 of it, which is the private id Rack stored.',
  },
  {
    id: 'django',
    label: 'Django (database sessions)',
    mode: 'session_table',
    defaults: { cookie_name: DJANGO_SESSION_COOKIE },
    cookies: ['{cookie_name}'],
    notes: 'The sessionid cookie is the django_session key; import sessions.session with the export.',
  },
  assertionPreset('django_signed_cookies', 'django', 'Django (signed-cookie sessions)', ['{cookie_name}'], {
    defaults: { cookie_name: DJANGO_SESSION_COOKIE },
    notes: 'Pass djangoSignedCookieExtractor({ secretKey: SECRET_KEY, bridgeSecret }) to the middleware: it verifies the cookie with SECRET_KEY on your server.',
  }),
];

for (const preset of FRAMEWORK_PRESETS) registerMigrationBridgePreset(preset, { replace: true });

/** The preset ids this module registers (for docs and the settings UI). */
export const FRAMEWORK_BRIDGE_PRESETS = FRAMEWORK_PRESETS.map((p) => p.id);
