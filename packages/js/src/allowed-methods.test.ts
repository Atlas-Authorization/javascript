import { describe, expect, it } from 'vitest';
import { filterFactors, methodAllowed, withMethodFilter } from './allowed-methods';

describe('methodAllowed', () => {
  it('no list means no filter', () => {
    expect(methodAllowed('password', undefined)).toBe(true);
    expect(methodAllowed('password', [])).toBe(true);
  });
  it('matches exact methods, families and the username alias', () => {
    expect(methodAllowed('oauth_google', ['oauth'])).toBe(true);
    expect(methodAllowed('oauth_google', ['oauth_github'])).toBe(false);
    expect(methodAllowed('saml_okta', ['enterprise_sso'])).toBe(true);
    expect(methodAllowed('username', ['password'])).toBe(true);
    expect(methodAllowed('passkey', ['password'])).toBe(false);
    expect(methodAllowed(null, ['password'])).toBe(false);
  });
  it('filters factor names', () => {
    expect(filterFactors(['password', 'email_code', 'passkey'], ['passkey', 'email_code'])).toEqual(['email_code', 'passkey']);
  });
});

describe('withMethodFilter', () => {
  const pair = { allowed_methods: 'passkey,password', allowed_methods_sig: 'abc' };
  it('adds the signed pair to a URL, from the object or the query string', () => {
    const a = new URL(withMethodFilter('https://auth.example.com/hosted/sign-in?redirect_url=%2Fx', pair));
    expect(a.searchParams.get('allowed_methods')).toBe('passkey,password');
    expect(a.searchParams.get('allowed_methods_sig')).toBe('abc');
    expect(a.searchParams.get('redirect_url')).toBe('/x');
    expect(withMethodFilter('/hosted/sign-in', 'allowed_methods=passkey&allowed_methods_sig=s')).toBe('/hosted/sign-in?allowed_methods=passkey&allowed_methods_sig=s');
  });
  it('leaves the URL alone without a filter and refuses an incomplete one', () => {
    expect(withMethodFilter('/x', undefined)).toBe('/x');
    expect(() => withMethodFilter('/x', 'allowed_methods=passkey')).toThrow();
  });
});
