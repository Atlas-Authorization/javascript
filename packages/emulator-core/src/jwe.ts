/* eslint-disable @typescript-eslint/no-explicit-any */
import { b64urlDecode } from './jws';

/**
 * Compact JWE decryption on Web Crypto only (like `jws.ts`), for request objects a client encrypts to the emulator's
 * published encryption key: key management `RSA-OAEP-256` or `ECDH-ES` (P-256, direct), content encryption
 * `A128GCM`, `A256GCM`, `A128CBC-HS256` or `A256CBC-HS512`. The same lists the real provider accepts.
 */
export const OP_DECRYPT_ALGS = ['RSA-OAEP-256', 'ECDH-ES'] as const;
export type OpDecryptAlg = (typeof OP_DECRYPT_ALGS)[number];
export const JWE_ENCS = ['A128GCM', 'A256GCM', 'A128CBC-HS256', 'A256CBC-HS512'] as const;
export const isOpDecryptAlg = (v: unknown): v is OpDecryptAlg => (OP_DECRYPT_ALGS as readonly string[]).includes(v as string);

export interface OpEncKey {
  alg: OpDecryptAlg;
  kid: string;
  publicJwk: Record<string, any>;
  privateKey: CryptoKey;
}

export async function generateEncKey(alg: OpDecryptAlg, kid: string): Promise<OpEncKey> {
  const pair = (await (alg === 'RSA-OAEP-256'
    ? crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, false, ['decrypt', 'encrypt'])
    : crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']))) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as Record<string, any>;
  delete jwk.key_ops;
  delete jwk.ext;
  return { alg, kid, publicJwk: { ...jwk, kid, use: 'enc', alg }, privateKey: pair.privateKey };
}

const ENC_KEY_BYTES: Record<string, number> = { A128GCM: 16, A256GCM: 32, 'A128CBC-HS256': 32, 'A256CBC-HS512': 64 };
const u32 = (n: number): Uint8Array => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
};
const lenPrefixed = (b: Uint8Array): Uint8Array => cat(u32(b.length), b);

/** RFC 7518 section 4.6.2: the Concat KDF with SHA-256, `bits` of output. */
async function concatKdf(z: Uint8Array, algId: string, apu: Uint8Array, apv: Uint8Array, bits: number): Promise<Uint8Array> {
  const info = cat(lenPrefixed(new TextEncoder().encode(algId)), lenPrefixed(apu), lenPrefixed(apv), u32(bits));
  const rounds = Math.ceil(bits / 256);
  const parts: Uint8Array[] = [];
  for (let i = 1; i <= rounds; i++) parts.push(new Uint8Array(await crypto.subtle.digest('SHA-256', cat(u32(i), z, info) as BufferSource)));
  return cat(...parts).slice(0, bits / 8);
}

const tagEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
};

/** The plaintext of a compact JWE, or null when it is malformed, names another key, or fails authentication. Never throws. */
export async function decryptJwe(jwe: string, key: OpEncKey): Promise<string | null> {
  try {
    const parts = jwe.split('.');
    if (parts.length !== 5) return null;
    const [h, ek, iv, ct, tag] = parts as [string, string, string, string, string];
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(h)));
    const keyBytes = ENC_KEY_BYTES[header.enc];
    if (header.alg !== key.alg || !keyBytes || header.zip !== undefined) return null;
    let cek: Uint8Array;
    if (key.alg === 'RSA-OAEP-256') {
      cek = new Uint8Array(await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, key.privateKey, b64urlDecode(ek) as BufferSource));
    } else {
      const epk = header.epk;
      if (ek || !epk || epk.kty !== 'EC' || epk.crv !== 'P-256') return null;
      const pub = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: epk.x, y: epk.y }, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const z = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, key.privateKey, 256));
      cek = await concatKdf(z, header.enc, header.apu ? b64urlDecode(header.apu) : new Uint8Array(), header.apv ? b64urlDecode(header.apv) : new Uint8Array(), keyBytes * 8);
    }
    if (cek.length !== keyBytes) return null;
    const aad = new TextEncoder().encode(h);
    const ivB = b64urlDecode(iv);
    const ctB = b64urlDecode(ct);
    const tagB = b64urlDecode(tag);
    if (header.enc.endsWith('GCM')) {
      const k = await crypto.subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, ['decrypt']);
      return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivB as BufferSource, additionalData: aad as BufferSource, tagLength: 128 }, k, cat(ctB, tagB) as BufferSource));
    }
    const half = keyBytes / 2;
    const hash = header.enc === 'A128CBC-HS256' ? 'SHA-256' : 'SHA-512';
    const mac = await crypto.subtle.importKey('raw', cek.slice(0, half) as BufferSource, { name: 'HMAC', hash }, false, ['sign']);
    const al = new Uint8Array(8);
    new DataView(al.buffer).setUint32(4, aad.length * 8);
    const expected = new Uint8Array(await crypto.subtle.sign('HMAC', mac, cat(aad, ivB, ctB, al) as BufferSource)).slice(0, half);
    if (!tagEqual(expected, tagB)) return null;
    const k = await crypto.subtle.importKey('raw', cek.slice(half) as BufferSource, 'AES-CBC', false, ['decrypt']);
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivB as BufferSource }, k, ctB as BufferSource));
  } catch {
    return null;
  }
}
