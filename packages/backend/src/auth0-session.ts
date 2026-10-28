import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { compactDecrypt } from 'jose';
import type { MigrationTokenExtractor } from './migration-bridge';

/**
 * Open an Auth0 SDK session cookie on YOUR server, for the zero-logout bridge.
 *
 * nextjs-auth0 (v4 `__session`, v3 `appSession`) and express-openid-connect
 * (`appSession`) keep the session in a JWE (`alg: dir`, `enc: A256GCM`) whose
 * key is HKDF-SHA256(AUTH0_SECRET, salt "", info "JWE CEK", 32 bytes). Large
 * sessions are split across `__session__0, __session__1…` (v4) or
 * `appSession.0, appSession.1…` (v3, express-openid-connect). Inside is the
 * ID token Auth0 issued at sign-in; the bridge exchanges that (preset `auth0`).
 *
 *   migrationBridge({ source: 'auth0', presetVars: { domain, client_id },
 *     extractToken: auth0SessionTokenExtractor({ secret: process.env.AUTH0_SECRET! }) })
 *
 * The secret never leaves your server. Pass several secrets while one rotates.
 */
export function auth0SessionTokenExtractor(options: {
  secret: string | readonly string[];
  /** Cookie names to try, in order (default `__session`, then `appSession`). */
  cookieNames?: readonly string[];
}): MigrationTokenExtractor {
  const secrets = (typeof options.secret === 'string' ? [options.secret] : [...options.secret]).filter(Boolean);
  if (secrets.length === 0) throw new Error('auth0SessionTokenExtractor: pass your AUTH0_SECRET.');
  const keys = secrets.map(auth0CookieKey);
  const names = options.cookieNames ?? ['__session', 'appSession'];
  return async ({ cookies }) => {
    for (const name of names) {
      const value = readChunked(cookies, name);
      // A JWE has five segments; Atlas's own `__session` is a JWT (three) and is skipped.
      if (!value || value.split('.').length !== 5) continue;
      for (const key of keys) {
        const token = await openSession(value, key);
        if (token) return token;
      }
    }
    return undefined;
  };
}

/** HKDF-SHA256(secret, salt "", info "JWE CEK", 32): the Auth0 SDKs' cookie key. */
export function auth0CookieKey(secret: string): Uint8Array {
  return hkdf(sha256, new TextEncoder().encode(secret), new Uint8Array(0), new TextEncoder().encode('JWE CEK'), 32);
}

/** The cookie value, joined from `name__0…` / `name.0…` chunks when it was split. */
function readChunked(cookies: Record<string, string>, name: string): string | undefined {
  if (cookies[name]) return cookies[name];
  for (const sep of ['__', '.']) {
    const parts: string[] = [];
    for (let i = 0; cookies[`${name}${sep}${i}`] !== undefined; i++) parts.push(cookies[`${name}${sep}${i}`]!);
    if (parts.length) return parts.join('');
  }
  return undefined;
}

async function openSession(jwe: string, key: Uint8Array): Promise<string | undefined> {
  let payload: unknown;
  try {
    const { plaintext, protectedHeader } = await compactDecrypt(jwe, key, { keyManagementAlgorithms: ['dir'], contentEncryptionAlgorithms: ['A256GCM'] });
    // express-openid-connect / nextjs-auth0 put the session expiry in the header.
    if (typeof protectedHeader.exp === 'number' && protectedHeader.exp * 1000 < Date.now()) return undefined;
    payload = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
  } catch {
    return undefined;
  }
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as { tokenSet?: { idToken?: unknown }; idToken?: unknown; id_token?: unknown };
  // v4: tokenSet.idToken; v3: idToken; express-openid-connect: id_token.
  const token = p.tokenSet?.idToken ?? p.idToken ?? p.id_token;
  return typeof token === 'string' && token.split('.').length === 3 ? token : undefined;
}
