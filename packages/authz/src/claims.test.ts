import { describe, expect, it } from 'vitest';
import { orgClaimsWithheld } from './claims';

describe('orgClaimsWithheld', () => {
  it('returns the two known reasons', () => {
    expect(orgClaimsWithheld({ org_claims_withheld: 'mfa_required' })).toBe('mfa_required');
    expect(orgClaimsWithheld({ org_claims_withheld: 'sign_in_method' })).toBe('sign_in_method');
  });
  it('is null when absent, unknown or no claims', () => {
    expect(orgClaimsWithheld({})).toBeNull();
    expect(orgClaimsWithheld({ org_claims_withheld: 'other' })).toBeNull();
    expect(orgClaimsWithheld(null)).toBeNull();
  });
});
