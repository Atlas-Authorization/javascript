import { ed25519 } from '@noble/curves/ed25519';
import { b64u, unb64u } from './hash';

export interface KeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

export function generateKeyPair(): KeyPair {
  const secretKey = ed25519.utils.randomPrivateKey();
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}

export function publicKeyOf(secretKey: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(secretKey);
}

export function sign(secretKey: Uint8Array, msg: Uint8Array): Uint8Array {
  return ed25519.sign(msg, secretKey);
}

/** Never throws: malformed keys/signatures simply fail verification. */
export function verify(publicKey: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean {
  try {
    return ed25519.verify(sig, msg, publicKey);
  } catch {
    return false;
  }
}

export const encodeKey = b64u;
export const decodeKey = unb64u;
export const encodeSig = b64u;
export const decodeSig = unb64u;

/** verify() over base64url-encoded key and signature; false on any decoding error. */
export function verifyB64u(publicKeyB64u: string, msg: Uint8Array, sigB64u: string): boolean {
  try {
    return verify(unb64u(publicKeyB64u), msg, unb64u(sigB64u));
  } catch {
    return false;
  }
}
