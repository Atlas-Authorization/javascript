/**
 * Edge-safe stand-in for the handful of `node:crypto` calls the backend makes.
 * `node:crypto` in the barrel broke Next 15 edge middleware (the bundle could
 * not resolve the builtin), so the same call shapes are built on @noble/hashes
 * and Web Crypto, which every runtime (Node, edge, workers, browsers) has.
 */
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';

type Enc = 'hex' | 'base64' | 'base64url';

interface Digester {
  update(data: string | Uint8Array): Digester;
  digest(): Buffer;
  digest(enc: Enc): string;
}

function digester(compute: (data: Uint8Array) => Uint8Array): Digester {
  const chunks: Uint8Array[] = [];
  const api: Digester = {
    update(data: string | Uint8Array) {
      chunks.push(typeof data === 'string' ? new TextEncoder().encode(data) : data);
      return api;
    },
    digest(enc?: Enc) {
      const out = Buffer.from(compute(Buffer.concat(chunks)));
      return (enc ? out.toString(enc) : out) as Buffer & string;
    },
  };
  return api;
}

export const createHmac = (_alg: 'sha256', key: string | Uint8Array) =>
  digester((d) => hmac(sha256, key, d));

export const createHash = (_alg: 'sha256') => digester((d) => sha256(d));

export function randomBytes(n: number): Buffer {
  return Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(n)));
}

export const randomUUID = (): string => globalThis.crypto.randomUUID();

/** Constant-time equality; callers check lengths first, as with node's. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) throw new RangeError('Input buffers must have the same byte length');
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
