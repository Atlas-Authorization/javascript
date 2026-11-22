import { describe, expect, it } from 'vitest';
import { ipInAllowlist } from './index';

describe('ipInAllowlist (root export)', () => {
  it('matches addresses and CIDR ranges, v4 and v6', () => {
    expect(ipInAllowlist('203.0.113.9', ['203.0.113.0/24'])).toBe(true);
    expect(ipInAllowlist('203.0.114.9', ['203.0.113.0/24'])).toBe(false);
    expect(ipInAllowlist('10.0.0.1', ['10.0.0.1'])).toBe(true);
    expect(ipInAllowlist('2001:db8::1', ['2001:db8::/32'])).toBe(true);
    expect(ipInAllowlist('2001:db9::1', ['2001:db8::/32'])).toBe(false);
  });

  it('never matches unparseable input or an empty list', () => {
    expect(ipInAllowlist('not-an-ip', ['0.0.0.0/0'])).toBe(false);
    expect(ipInAllowlist('1.2.3.4', [])).toBe(false);
  });
});
