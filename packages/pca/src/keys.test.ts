import { describe, expect, it } from 'vitest';
import { utf8 } from './hash';
import { decodeKey, encodeKey, generateKeyPair, sign, verify, verifyB64u } from './keys';

describe('keys', () => {
  it('sign/verify roundtrip', () => {
    const k = generateKeyPair();
    const sig = sign(k.secretKey, utf8('hi'));
    expect(verify(k.publicKey, utf8('hi'), sig)).toBe(true);
    expect(decodeKey(encodeKey(k.publicKey))).toEqual(k.publicKey);
  });
  it('wrong key and tampered message fail', () => {
    const k = generateKeyPair();
    const o = generateKeyPair();
    const sig = sign(k.secretKey, utf8('hi'));
    expect(verify(o.publicKey, utf8('hi'), sig)).toBe(false);
    expect(verify(k.publicKey, utf8('ho'), sig)).toBe(false);
  });
  it('malformed inputs return false, never throw', () => {
    expect(verifyB64u('!!', utf8('x'), '??')).toBe(false);
    expect(verify(new Uint8Array(3), utf8('x'), new Uint8Array(3))).toBe(false);
  });
});
