import { describe, expect, it } from 'vitest';
import { b64u, canonicalize, hashCanonical, sha256, unb64u, utf8 } from './hash';

describe('hash', () => {
  it('canonicalization is key-order independent and compact', () => {
    const a = { b: 1, a: { y: [1, 'x', null, true], x: 2 } };
    const b = { a: { x: 2, y: [1, 'x', null, true] }, b: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalize(a)).toBe('{"a":{"x":2,"y":[1,"x",null,true]},"b":1}');
    expect(hashCanonical(a)).toBe(hashCanonical(b));
  });
  it('array order matters; tamper changes digest', () => {
    expect(hashCanonical([1, 2])).not.toBe(hashCanonical([2, 1]));
    expect(hashCanonical({ a: 1 })).not.toBe(hashCanonical({ a: 2 }));
  });
  it('rejects unencodable values', () => {
    expect(() => canonicalize({ a: undefined })).toThrow();
    expect(() => canonicalize({ a: () => 1 })).toThrow();
    expect(() => canonicalize(NaN)).toThrow();
    expect(() => canonicalize(1n)).toThrow();
    const c: Record<string, unknown> = {};
    c.self = c;
    expect(() => canonicalize(c)).toThrow();
  });
  it('sha256 known vector and b64u roundtrip', () => {
    expect(Buffer.from(sha256(utf8('abc'))).toString('hex')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    const x = new Uint8Array([0, 255, 128, 7]);
    expect(unb64u(b64u(x))).toEqual(x);
    expect(b64u(x)).not.toMatch(/[+/=]/);
  });
});
