import { describe, expect, it } from 'vitest';
import { encodeAttestationHeader, isAttestationGuarded } from './attestation';

describe('attestation header', () => {
  it('encodes the iOS and Android proofs as base64url JSON', () => {
    const decode = (h: string) => JSON.parse(atob(h.replace(/-/g, '+').replace(/_/g, '/')));
    expect(decode(encodeAttestationHeader('n', { platform: 'ios', assertion: 'a', receipt: 'r' }))).toEqual({ p: 'ios', n: 'n', a: 'a', r: 'r' });
    expect(decode(encodeAttestationHeader('n', { platform: 'android', integrityToken: 't' }))).toEqual({ p: 'android', n: 'n', t: 't' });
  });
  it('guards only the sign-up, sign-in and SMS-send posts', () => {
    expect(isAttestationGuarded('/v1/client/sign_ups', 'POST')).toBe(true);
    expect(isAttestationGuarded('/v1/client/sign_ins', 'POST')).toBe(true);
    expect(isAttestationGuarded('/v1/client/me/phone_numbers/pn_1/prepare_verification', 'POST')).toBe(true);
    expect(isAttestationGuarded('/v1/client/sign_ins', 'GET')).toBe(false);
    expect(isAttestationGuarded('/v1/client/me', 'POST')).toBe(false);
  });
});
