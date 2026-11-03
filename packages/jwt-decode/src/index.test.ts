import { describe, it, expect } from 'vitest';
import { decodeJwt, jwtClaims, jwtExpired, InvalidTokenError, type AtlasJwtPayload } from './index';

/** Encode an object as a base64url JWT segment (Node-side test helper). */
function seg(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

/** Build a well-formed (unsigned-looking) JWT from header + payload. */
function makeToken(header: object, payload: object, signature = 'c2ln'): string {
  return `${seg(header)}.${seg(payload)}.${signature}`;
}

const HEADER = { alg: 'RS256', typ: 'JWT', kid: 'ins_test_key_1' };
const PAYLOAD: AtlasJwtPayload = {
  iss: 'https://clerk.example.atlas',
  sub: 'user_2abcDEF',
  sid: 'sess_2xyzGHI',
  org_id: 'org_2orgJKL',
  org_role: 'admin',
  exp: 2000000000,
  iat: 1999999940,
};

describe('decodeJwt', () => {
  it('decodes a known sample token into header, payload, and raw signature', () => {
    const token = makeToken(HEADER, PAYLOAD, 'SIGNATURE_SEGMENT');
    const decoded = decodeJwt(token);

    expect(decoded.header).toEqual(HEADER);
    expect(decoded.payload).toEqual(PAYLOAD);
    // signature stays as the raw (undecoded) third segment.
    expect(decoded.signature).toBe('SIGNATURE_SEGMENT');
  });

  it('surfaces Atlas standard claims including exp', () => {
    const { payload } = decodeJwt(makeToken(HEADER, PAYLOAD));
    expect(payload.sub).toBe('user_2abcDEF');
    expect(payload.sid).toBe('sess_2xyzGHI');
    expect(payload.org_id).toBe('org_2orgJKL');
    expect(payload.exp).toBe(2000000000);
  });

  it('decodes multibyte (UTF-8) claim values', () => {
    const token = makeToken(HEADER, { name: 'Ådàm 日本語 🔐', exp: 2000000000 });
    expect(decodeJwt(token).payload.name).toBe('Ådàm 日本語 🔐');
  });

  it('decodes base64url without padding and with - / _ alphabet', () => {
    // Payload chosen so its base64 contains + and / (mapped to - and _).
    const token = makeToken(HEADER, { data: '>>>???<<<', exp: 2000000000 });
    expect(decodeJwt(token).payload.data).toBe('>>>???<<<');
  });

  it('decodes an unsecured (alg:none) token with an empty signature segment', () => {
    const token = `${seg({ alg: 'none' })}.${seg({ sub: 'u1' })}.`;
    const decoded = decodeJwt(token);
    expect(decoded.header.alg).toBe('none');
    expect(decoded.signature).toBe('');
  });

  it('rejects malformed input', () => {
    expect(() => decodeJwt('not-a-jwt')).toThrow(InvalidTokenError);
    expect(() => decodeJwt('only.two')).toThrow(/3 segments/);
    expect(() => decodeJwt('a.b.c.d')).toThrow(/3 segments/);
    // header/payload not base64url JSON
    expect(() => decodeJwt('@@@.@@@.sig')).toThrow(InvalidTokenError);
    // valid base64url but not JSON
    expect(() => decodeJwt(`${Buffer.from('hello').toString('base64url')}.${seg({ a: 1 })}.s`)).toThrow(
      /not valid JSON/,
    );
    // empty header segment
    expect(() => decodeJwt('.abc.sig')).toThrow(/must not be empty/);
    // JSON array, not an object
    expect(() => decodeJwt(makeToken(HEADER, [1, 2, 3] as unknown as object))).toThrow(
      /not a JSON object/,
    );
    // @ts-expect-error — non-string input is rejected at runtime
    expect(() => decodeJwt(12345)).toThrow(/must be a string/);
  });
});

describe('jwtClaims', () => {
  it('returns just the payload', () => {
    expect(jwtClaims(makeToken(HEADER, PAYLOAD))).toEqual(PAYLOAD);
  });
});

describe('jwtExpired', () => {
  const now = 1_000_000 * 1000; // 1_000_000s in ms

  it('is false for a token that expires in the future', () => {
    const token = makeToken(HEADER, { exp: 1_000_100 });
    expect(jwtExpired(token, 0, now)).toBe(false);
  });

  it('is true for a token that expired in the past', () => {
    const token = makeToken(HEADER, { exp: 999_900 });
    expect(jwtExpired(token, 0, now)).toBe(true);
  });

  it('honours leeway around the expiry boundary', () => {
    // exp is 30s in the past; nowSec = 1_000_000, exp = 999_970.
    const token = makeToken(HEADER, { exp: 999_970 });
    // No leeway -> expired.
    expect(jwtExpired(token, 0, now)).toBe(true);
    // 60s leeway -> still valid (now <= exp + leeway).
    expect(jwtExpired(token, 60, now)).toBe(false);
    // Exactly at the boundary: now == exp + leeway -> not yet expired.
    expect(jwtExpired(token, 30, now)).toBe(false);
    // One second short of the boundary -> expired.
    expect(jwtExpired(token, 29, now)).toBe(true);
  });

  it('throws when there is no numeric exp claim', () => {
    expect(() => jwtExpired(makeToken(HEADER, { sub: 'u1' }))).toThrow(/no numeric .*exp/);
    expect(() => jwtExpired(makeToken(HEADER, { exp: 'soon' }))).toThrow(InvalidTokenError);
  });

  it('propagates InvalidTokenError for malformed tokens', () => {
    expect(() => jwtExpired('garbage')).toThrow(InvalidTokenError);
  });
});
