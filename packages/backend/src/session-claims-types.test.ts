import { describe, expect, expectTypeOf, it } from 'vitest';
import { authenticatedWithin, mfaSatisfied, usedMultiFactor } from './recent-auth';
import type { SessionClaims } from './verify';

// Typechecked under the package's strict tsconfig (tsgo -p tsconfig.json includes tests).
const base: SessionClaims = { iss: 'https://i.test', sub: 'user_1', sid: 'sess_1', exp: 2_000_000_000 };

describe('SessionClaims step-up / MFA claims', () => {
  it('types acr, amr, auth_time, mfa_satisfied, email_verified', () => {
    expectTypeOf<SessionClaims['acr']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<SessionClaims['amr']>().toEqualTypeOf<string[] | undefined>();
    expectTypeOf<SessionClaims['auth_time']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<SessionClaims['mfa_satisfied']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<SessionClaims['email_verified']>().toEqualTypeOf<boolean | undefined>();
    // @ts-expect-error amr is a string array
    const bad: SessionClaims = { ...base, amr: 'mfa' };
    void bad;
  });

  it('recent-auth helpers accept SessionClaims', () => {
    const c: SessionClaims = { ...base, acr: 'urn:atlas:acr:mfa', amr: ['pwd', 'mfa'], auth_time: 1_000 };
    expect(usedMultiFactor(c)).toBe(true);
    expect(authenticatedWithin(c, 60, 1_030_000)).toBe(true);
    expect(mfaSatisfied(c)).toBe(true);
  });
});

describe('mfaSatisfied', () => {
  it('follows the rule', () => {
    expect(mfaSatisfied(base)).toBe(false);
    expect(mfaSatisfied({ ...base, mfa_satisfied: true })).toBe(true);
    expect(mfaSatisfied({ ...base, mfa: true })).toBe(true);
    expect(mfaSatisfied({ ...base, amr: ['mfa'] })).toBe(true);
    expect(mfaSatisfied({ ...base, acr: 'urn:atlas:acr:mfa' })).toBe(true);
    expect(mfaSatisfied({ ...base, sso_connection_id: 'sso_1' })).toBe(true);
    expect(mfaSatisfied({ ...base, mfa_satisfied: false, amr: ['pwd'], acr: 'urn:atlas:acr:basic' })).toBe(false);
    // The server's verdict is final when present, even against the fallbacks.
    expect(mfaSatisfied({ ...base, mfa_satisfied: false, mfa: true, sso_connection_id: 'sso_1' })).toBe(false);
  });
});
