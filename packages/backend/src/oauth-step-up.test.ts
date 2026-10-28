import { describe, expect, it } from 'vitest';
import { buildWwwAuthenticate, requireAcr } from './oauth-resource';

describe('RFC 9470 step-up helper', () => {
  const now = 1_000_000_000_000;
  it('passes when acr and age are satisfied', () => {
    expect(requireAcr({ acr: 'urn:atlas:acr:mfa', auth_time: now / 1000 - 10 }, { acrValues: ['urn:atlas:acr:mfa'], maxAge: 300, nowMs: now })).toBeNull();
  });
  it('challenges on a weaker acr', () => {
    const r = requireAcr({ acr: 'urn:atlas:acr:basic', auth_time: now / 1000 }, { acrValues: ['urn:atlas:acr:mfa'], nowMs: now });
    expect(r?.status).toBe(401);
    expect(r?.wwwAuthenticate).toContain('error="insufficient_user_authentication"');
    expect(r?.wwwAuthenticate).toContain('acr_values="urn:atlas:acr:mfa"');
  });
  it('challenges on a stale or missing auth_time', () => {
    expect(requireAcr({ auth_time: now / 1000 - 600 }, { maxAge: 300, nowMs: now })?.wwwAuthenticate).toContain('max_age=300');
    expect(requireAcr({}, { maxAge: 300, nowMs: now })).not.toBeNull();
  });
  it('builds the bare challenge fields', () => {
    expect(buildWwwAuthenticate({ error: 'insufficient_user_authentication', acrValues: ['a', 'b'], maxAge: 5 })).toBe(
      'Bearer error="insufficient_user_authentication", acr_values="a b", max_age=5',
    );
  });
});
