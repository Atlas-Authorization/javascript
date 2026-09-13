import { describe, expect, it } from 'vitest';
import { telegramSignInBody } from './telegram';
import { siweVerifyBody, parseSiweNonceResponse } from './siwe';

describe('telegramSignInBody', () => {
  it('wraps the widget payload under `telegram`', () => {
    const payload = { id: 42, username: 'ada', auth_date: 1, hash: 'h' };
    expect(telegramSignInBody(payload)).toEqual({ telegram: payload });
  });
});

describe('siweVerifyBody', () => {
  it('builds the verify body', () => {
    expect(siweVerifyBody({ message: 'm', signature: '0xabc' })).toEqual({
      message: 'm',
      signature: '0xabc',
    });
  });
});

describe('parseSiweNonceResponse', () => {
  it('reads the nonce', () => {
    expect(parseSiweNonceResponse({ object: 'siwe_nonce', nonce: 'abc123' })).toEqual({
      nonce: 'abc123',
    });
  });

  it('returns null for malformed bodies', () => {
    expect(parseSiweNonceResponse(null)).toBeNull();
    expect(parseSiweNonceResponse({})).toBeNull();
    expect(parseSiweNonceResponse({ nonce: '' })).toBeNull();
  });
});
