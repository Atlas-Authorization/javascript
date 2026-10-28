import { x25519 } from '@noble/curves/ed25519';
import { xsalsa20poly1305, hsalsa } from '@noble/ciphers/salsa';
import { blake2b } from '@noble/hashes/blake2b';

/**
 * libsodium `crypto_box_seal` / `crypto_box_seal_open`, in pure JS so the
 * client keeps running on every runtime (Node, Deno, Bun, edge, browsers).
 *
 *   nonce = BLAKE2b-192(epk ‖ pk);  k = HSalsa20(X25519(sk, pk), 0¹⁶)
 *   box   = epk ‖ XSalsa20-Poly1305(k, nonce, message)
 */

const SIGMA = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);

function u32(b: Uint8Array): Uint32Array {
  const out = new Uint32Array(b.length / 4);
  for (let i = 0; i < out.length; i += 1) out[i] = (b[i * 4]! | (b[i * 4 + 1]! << 8) | (b[i * 4 + 2]! << 16) | (b[i * 4 + 3]! << 24)) >>> 0;
  return out;
}

export function beforeNm(publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(secretKey, publicKey);
  const out = new Uint32Array(8);
  hsalsa(SIGMA, u32(shared), new Uint32Array(4), out);
  const bytes = new Uint8Array(32);
  out.forEach((w, i) => {
    bytes[i * 4] = w & 0xff;
    bytes[i * 4 + 1] = (w >>> 8) & 0xff;
    bytes[i * 4 + 2] = (w >>> 16) & 0xff;
    bytes[i * 4 + 3] = (w >>> 24) & 0xff;
  });
  return bytes;
}

function nonceFor(epk: Uint8Array, pk: Uint8Array): Uint8Array {
  const input = new Uint8Array(64);
  input.set(epk, 0);
  input.set(pk, 32);
  return blake2b(input, { dkLen: 24 });
}

export function generateSealKeyPair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  const secretKey = x25519.utils.randomPrivateKey();
  return { publicKey: x25519.getPublicKey(secretKey), secretKey };
}

export function sealBox(message: Uint8Array | string, recipientPublicKey: Uint8Array): Uint8Array {
  const plain = typeof message === 'string' ? new TextEncoder().encode(message) : message;
  const eph = generateSealKeyPair();
  const boxed = xsalsa20poly1305(beforeNm(recipientPublicKey, eph.secretKey), nonceFor(eph.publicKey, recipientPublicKey)).encrypt(plain);
  const out = new Uint8Array(32 + boxed.length);
  out.set(eph.publicKey, 0);
  out.set(boxed, 32);
  return out;
}

export function openSealedBox(sealed: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array {
  if (sealed.length < 48) throw new Error('openSealedBox: too short');
  const epk = sealed.subarray(0, 32);
  return xsalsa20poly1305(beforeNm(epk, secretKey), nonceFor(epk, publicKey)).decrypt(sealed.subarray(32));
}
