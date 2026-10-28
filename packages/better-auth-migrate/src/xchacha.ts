import { createCipheriv, createDecipheriv } from 'node:crypto';

/**
 * XChaCha20-Poly1305 (draft-irtf-cfrg-xchacha) on top of Node's built-in
 * IETF ChaCha20-Poly1305, so the exporter needs no third-party cipher.
 *
 * XChaCha20 = ChaCha20 keyed with HChaCha20(key, nonce[0..16]) and the 12-byte
 * IETF nonce `0x00000000 || nonce[16..24]`. Poly1305 is unchanged. This is the
 * construction Better Auth's symmetric encryption uses (through
 * `@noble/ciphers`' `xchacha20poly1305` with a managed nonce), so a secret it
 * wrote decrypts here byte for byte.
 */

const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574];

function rotl(v: number, c: number): number {
  return ((v << c) | (v >>> (32 - c))) >>> 0;
}

function quarterRound(s: Uint32Array, a: number, b: number, c: number, d: number): void {
  s[a] = (s[a]! + s[b]!) >>> 0;
  s[d] = rotl(s[d]! ^ s[a]!, 16);
  s[c] = (s[c]! + s[d]!) >>> 0;
  s[b] = rotl(s[b]! ^ s[c]!, 12);
  s[a] = (s[a]! + s[b]!) >>> 0;
  s[d] = rotl(s[d]! ^ s[a]!, 8);
  s[c] = (s[c]! + s[d]!) >>> 0;
  s[b] = rotl(s[b]! ^ s[c]!, 7);
}

/** HChaCha20: a 32-byte subkey from a 32-byte key and the first 16 nonce bytes. */
export function hchacha20(key: Uint8Array, nonce16: Uint8Array): Buffer {
  if (key.length !== 32) throw new Error('HChaCha20 key must be 32 bytes.');
  if (nonce16.length !== 16) throw new Error('HChaCha20 nonce must be 16 bytes.');
  const k = Buffer.from(key);
  const n = Buffer.from(nonce16);
  const s = new Uint32Array(16);
  s[0] = SIGMA[0]!;
  s[1] = SIGMA[1]!;
  s[2] = SIGMA[2]!;
  s[3] = SIGMA[3]!;
  for (let i = 0; i < 8; i++) s[4 + i] = k.readUInt32LE(i * 4);
  for (let i = 0; i < 4; i++) s[12 + i] = n.readUInt32LE(i * 4);
  for (let i = 0; i < 10; i++) {
    quarterRound(s, 0, 4, 8, 12);
    quarterRound(s, 1, 5, 9, 13);
    quarterRound(s, 2, 6, 10, 14);
    quarterRound(s, 3, 7, 11, 15);
    quarterRound(s, 0, 5, 10, 15);
    quarterRound(s, 1, 6, 11, 12);
    quarterRound(s, 2, 7, 8, 13);
    quarterRound(s, 3, 4, 9, 14);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeUInt32LE(s[i]!, i * 4);
  for (let i = 0; i < 4; i++) out.writeUInt32LE(s[12 + i]!, 16 + i * 4);
  return out;
}

function ietfParams(key: Uint8Array, nonce24: Uint8Array): { subkey: Buffer; iv: Buffer } {
  if (nonce24.length !== 24) throw new Error('XChaCha20 nonce must be 24 bytes.');
  const subkey = hchacha20(key, nonce24.subarray(0, 16));
  const iv = Buffer.alloc(12);
  Buffer.from(nonce24.subarray(16, 24)).copy(iv, 4);
  return { subkey, iv };
}

/** Encrypt: returns ciphertext || 16-byte tag (no nonce). */
export function xchacha20poly1305Encrypt(
  key: Uint8Array,
  nonce24: Uint8Array,
  plaintext: Uint8Array,
): Buffer {
  const { subkey, iv } = ietfParams(key, nonce24);
  const cipher = createCipheriv('chacha20-poly1305', subkey, iv, { authTagLength: 16 });
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([body, cipher.getAuthTag()]);
}

/** Decrypt ciphertext || tag. Throws when the tag does not verify. */
export function xchacha20poly1305Decrypt(
  key: Uint8Array,
  nonce24: Uint8Array,
  sealed: Uint8Array,
): Buffer {
  if (sealed.length < 16) throw new Error('Ciphertext is too short.');
  const { subkey, iv } = ietfParams(key, nonce24);
  const decipher = createDecipheriv('chacha20-poly1305', subkey, iv, { authTagLength: 16 });
  decipher.setAuthTag(Buffer.from(sealed.subarray(sealed.length - 16)));
  return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
}
