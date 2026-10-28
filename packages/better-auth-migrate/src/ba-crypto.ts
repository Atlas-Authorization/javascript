import { createHash, randomBytes } from 'node:crypto';
import { xchacha20poly1305Decrypt, xchacha20poly1305Encrypt } from './xchacha';

/**
 * Better Auth's symmetric encryption, read-compatible with what it stores for
 * two-factor secrets, backup codes, encrypted OAuth tokens and encrypted OAuth
 * client secrets.
 *
 * Format, as Better Auth writes it:
 *   key        = SHA-256(UTF-8(secret))
 *   ciphertext = hex( nonce(24) || XChaCha20-Poly1305(key, nonce, UTF-8(data)) )
 * With secret rotation configured (`secrets: [{ version, value }]`) the hex is
 * wrapped in an envelope `$ba$<version>$<hex>` naming the secret that sealed it;
 * a bare hex payload is then a legacy value sealed with BETTER_AUTH_SECRET.
 */

/** Better Auth's rotation-aware secret configuration (`ctx.secretConfig`). */
export interface BetterAuthSecretConfig {
  keys: Map<number, string> | Record<string | number, string>;
  currentVersion: number;
  legacySecret?: string;
}

export type BetterAuthSecret = string | BetterAuthSecretConfig;

const ENVELOPE_PREFIX = '$ba$';

function keyFor(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

function versionSecret(config: BetterAuthSecretConfig, version: number): string | undefined {
  const keys = config.keys;
  if (keys instanceof Map) return keys.get(version);
  return keys[version] ?? keys[String(version)];
}

/** Parse `$ba$<version>$<hex>`; null when the value is a bare legacy payload. */
export function parseEnvelope(data: string): { version: number; ciphertext: string } | null {
  if (!data.startsWith(ENVELOPE_PREFIX)) return null;
  const second = data.indexOf('$', ENVELOPE_PREFIX.length);
  if (second === -1) return null;
  const version = Number.parseInt(data.slice(ENVELOPE_PREFIX.length, second), 10);
  if (!Number.isInteger(version) || version < 0) return null;
  return { version, ciphertext: data.slice(second + 1) };
}

function rawDecrypt(secret: string, hex: string): string {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(hex)) throw new Error('Not a Better Auth ciphertext (expected hex).');
  const bytes = Buffer.from(hex, 'hex');
  if (bytes.length < 24 + 16) throw new Error('Better Auth ciphertext is too short.');
  const plain = xchacha20poly1305Decrypt(keyFor(secret), bytes.subarray(0, 24), bytes.subarray(24));
  return plain.toString('utf8');
}

function rawEncrypt(secret: string, data: string): string {
  const nonce = randomBytes(24);
  const sealed = xchacha20poly1305Encrypt(keyFor(secret), nonce, Buffer.from(data, 'utf8'));
  return Buffer.concat([nonce, sealed]).toString('hex');
}

/** True when a stored value has the shape of a Better Auth ciphertext. */
export function looksEncrypted(value: string): boolean {
  if (value.startsWith(ENVELOPE_PREFIX)) return true;
  return value.length >= 80 && value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value);
}

/** Decrypt a value Better Auth sealed with `symmetricEncrypt`. Throws on a wrong secret or tampering. */
export function betterAuthDecrypt(secret: BetterAuthSecret, data: string): string {
  if (typeof secret === 'string') {
    // A plain-string secret never writes an envelope, but an instance that later
    // turned rotation on may still be handed one: honour its version-less body.
    const env = parseEnvelope(data);
    return rawDecrypt(secret, env ? env.ciphertext : data);
  }
  const env = parseEnvelope(data);
  if (env) {
    const s = versionSecret(secret, env.version);
    if (!s) throw new Error(`Secret version ${env.version} is not configured (it may have been retired).`);
    return rawDecrypt(s, env.ciphertext);
  }
  if (secret.legacySecret) return rawDecrypt(secret.legacySecret, data);
  throw new Error('A legacy (bare hex) value needs BETTER_AUTH_SECRET to decrypt.');
}

/** Encrypt exactly as Better Auth's `symmetricEncrypt` does (used by the fixture generator). */
export function betterAuthEncrypt(secret: BetterAuthSecret, data: string): string {
  if (typeof secret === 'string') return rawEncrypt(secret, data);
  const s = versionSecret(secret, secret.currentVersion);
  if (!s) throw new Error(`Secret version ${secret.currentVersion} not found.`);
  return `${ENVELOPE_PREFIX}${secret.currentVersion}$${rawEncrypt(s, data)}`;
}

/** RFC 4648 base32 without padding — the alphabet authenticator apps read. */
export function base32Encode(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
