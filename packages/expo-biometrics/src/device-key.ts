/**
 * The signer half of device-bound biometric sign-in for React Native and Expo.
 *
 * `registerDeviceKey` / `signInWithDeviceKey` (from `@atlasauth/js`) take a
 * `DeviceKeySigner`. On a phone that signer must keep an ES256 (P-256) key in the
 * Secure Enclave / Android Keystore and sign behind a biometric prompt. React
 * Native has no built-in module for that, so this file takes the native
 * keystore module you already use (declared structurally, never imported) and
 * adapts its output to what Atlas verifies: a JWK for the public key and a
 * base64url `r || s` signature.
 */

export interface DeviceKeyJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

/** The `DeviceKeySigner` contract from `@atlasauth/js`, declared structurally. */
export interface DeviceKeySigner {
  createKey(opts: { biometric: boolean }): Promise<DeviceKeyJwk>;
  sign(message: string): Promise<string>;
}

/**
 * What a native keystore module must offer. Either encoding of each value is
 * accepted: public keys as a base64 SPKI (`SubjectPublicKeyInfo`), a base64
 * X9.63 point (`04 || X || Y`) or `{ x, y }`; signatures as base64/base64url DER
 * or raw `r || s`.
 */
export interface NativeKeystore {
  /** Creates (replacing any previous) hardware-backed P-256 key; `biometric` requires a biometric per signature. */
  createKey(opts: { biometric: boolean }): Promise<string | { x: string; y: string }>;
  /** Signs the UTF-8 message with the key (after the biometric prompt) and returns the signature. */
  sign(message: string): Promise<string>;
}

const B64 = /^[A-Za-z0-9+/_-]*={0,2}$/;

function toBytes(b64: string): Uint8Array {
  if (!B64.test(b64)) throw new Error('Expected base64 input.');
  const std = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Normalises a keystore public key (SPKI / X9.63 / `{x,y}`) to a P-256 JWK. */
export function toDeviceKeyJwk(key: string | { x: string; y: string }): DeviceKeyJwk {
  if (typeof key !== 'string') return { kty: 'EC', crv: 'P-256', x: key.x, y: key.y };
  const bytes = toBytes(key);
  // An SPKI for P-256 ends with the 65-byte uncompressed point; a bare point is the 65 bytes.
  const point = bytes.length === 65 ? bytes : bytes.slice(-65);
  if (point.length !== 65 || point[0] !== 0x04) throw new Error('Expected an uncompressed P-256 public key.');
  return { kty: 'EC', crv: 'P-256', x: toBase64Url(point.slice(1, 33)), y: toBase64Url(point.slice(33)) };
}

function fixed32(int: Uint8Array): Uint8Array {
  let v = int;
  while (v.length > 1 && v[0] === 0) v = v.slice(1);
  if (v.length > 32) throw new Error('ECDSA integer is wider than 256 bits.');
  const out = new Uint8Array(32);
  out.set(v, 32 - v.length);
  return out;
}

/** Normalises a keystore signature (DER or raw r||s, base64 or base64url) to base64url `r || s`. */
export function toP1363Signature(signature: string): string {
  const b = toBytes(signature);
  if (b.length === 64) return toBase64Url(b);
  let i = 0;
  const len = (): number => {
    const first = b[i++]!;
    if (first < 0x80) return first;
    const n = first & 0x7f;
    if (n < 1 || n > 2 || i + n > b.length) throw new Error('Malformed ECDSA signature.');
    let l = 0;
    for (let k = 0; k < n; k++) l = (l << 8) | b[i++]!;
    return l;
  };
  const int = (): Uint8Array => {
    if (b[i++] !== 0x02) throw new Error('Malformed ECDSA signature.');
    const l = len();
    if (l < 1 || i + l > b.length) throw new Error('Malformed ECDSA signature.');
    const v = b.slice(i, i + l);
    i += l;
    return fixed32(v);
  };
  if (b[i++] !== 0x30) throw new Error('Malformed ECDSA signature.');
  len();
  const r = int();
  const s = int();
  const out = new Uint8Array(64);
  out.set(r, 0);
  out.set(s, 32);
  return toBase64Url(out);
}

/** Adapts a native keystore module to the `DeviceKeySigner` that `@atlasauth/js` expects. */
export function createDeviceKeySigner(keystore: NativeKeystore): DeviceKeySigner {
  return {
    async createKey(opts) {
      return toDeviceKeyJwk(await keystore.createKey(opts));
    },
    async sign(message) {
      return toP1363Signature(await keystore.sign(message));
    },
  };
}
