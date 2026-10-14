import { sha256 as nobleSha256 } from '@noble/hashes/sha256';
import { base64urlnopad } from '@scure/base';

const enc = new TextEncoder();

/** Encode a UTF-8 string. */
export function utf8(s: string): Uint8Array {
  return enc.encode(s);
}

export function sha256(bytes: Uint8Array): Uint8Array {
  return nobleSha256(bytes);
}

export function b64u(bytes: Uint8Array): string {
  return base64urlnopad.encode(bytes);
}

export function unb64u(s: string): Uint8Array {
  return base64urlnopad.decode(s);
}

/**
 * Deterministic serialization: object keys sorted (UTF-16 code-unit order, recursively), no
 * whitespace, JSON string/number escaping. Rejects undefined, functions, symbols, bigint,
 * non-finite numbers, non-plain objects and cycles — anything that has no stable encoding.
 */
export function canonicalize(value: unknown): string {
  return ser(value, new Set());
}

function ser(v: unknown, seen: Set<object>): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) throw new TypeError('canonicalize: non-finite number');
      return Object.is(v, -0) ? '0' : JSON.stringify(v);
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalize: unsupported type ${typeof v}`);
  }
  const o = v as object;
  if (seen.has(o)) throw new TypeError('canonicalize: cycle');
  seen.add(o);
  try {
    if (Array.isArray(o)) {
      return '[' + o.map((x) => ser(x, seen)).join(',') + ']';
    }
    const proto = Object.getPrototypeOf(o);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError('canonicalize: non-plain object');
    }
    const rec = o as Record<string, unknown>;
    const keys = Object.keys(rec).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + ser(rec[k], seen)).join(',') + '}';
  } finally {
    seen.delete(o);
  }
}

export function canonicalBytes(value: unknown): Uint8Array {
  return utf8(canonicalize(value));
}

/** base64url(sha256(canonical(value))). */
export function hashCanonical(value: unknown): string {
  return b64u(sha256(canonicalBytes(value)));
}
