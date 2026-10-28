import { describe, expect, it } from 'vitest';
import { authenticatedWithin, usedMultiFactor } from './recent-auth';

describe('recent authentication checks', () => {
  it('authenticatedWithin compares auth_time with the window', () => {
    const now = 1_800_000_300_000;
    expect(authenticatedWithin({ auth_time: 1_800_000_000 }, 300, now)).toBe(true);
    expect(authenticatedWithin({ auth_time: 1_799_999_999 }, 300, now)).toBe(false);
    expect(authenticatedWithin({}, 300, now)).toBe(false);
  });

  it('usedMultiFactor reads acr and amr', () => {
    expect(usedMultiFactor({ acr: 'urn:atlas:acr:mfa', amr: ['pwd', 'otp', 'mfa'] })).toBe(true);
    expect(usedMultiFactor({ acr: 'urn:atlas:acr:step_up', amr: ['otp', 'mfa'] })).toBe(true);
    expect(usedMultiFactor({ acr: 'urn:atlas:acr:step_up', amr: ['pwd'] })).toBe(false);
    expect(usedMultiFactor({ acr: 'urn:atlas:acr:basic', amr: ['pwd'] })).toBe(false);
  });
});
