import { describe, expect, it } from 'vitest';
import { getCsrfToken } from './csrf';

describe('getCsrfToken', () => {
  it('reads the Atlas CSRF cookie', () => {
    expect(getCsrfToken('a=1; __atlas_csrf=abc.def.ghi; b=2')).toBe('abc.def.ghi');
  });

  it('decodes an encoded value and treats a missing or empty cookie as no token', () => {
    expect(getCsrfToken('__atlas_csrf=a%3Db')).toBe('a=b');
    expect(getCsrfToken('a=1')).toBeNull();
    expect(getCsrfToken('__atlas_csrf=')).toBeNull();
    expect(getCsrfToken('')).toBeNull();
  });

  it('does not match a cookie that only ends with the name', () => {
    expect(getCsrfToken('x__atlas_csrf=zzz')).toBeNull();
  });
});
