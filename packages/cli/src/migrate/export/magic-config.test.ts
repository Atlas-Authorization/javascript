import { describe, expect, it } from 'vitest';
import { translateMagicConfig } from './magic-config';

describe('translateMagicConfig', () => {
  it('maps email OTP and link, reports the dashboard-only settings, and carries the client id to the bridge', () => {
    const r = translateMagicConfig({ clientId: 'did:magic:abc' });
    expect(r.documents.instance).toEqual({ auth_config: { strategies: { emailCode: true, emailLink: true } } });
    expect(r.bridge).toEqual({ preset: 'magic', vars: { client_id: 'did:magic:abc' } });
    expect(r.origin).toBe('Magic client did:magic:abc');
    expect(r.report.filter((e) => e.status === 'mapped')).toHaveLength(2);
    expect(r.report.some((e) => e.status === 'manual' && e.setting.startsWith('wallets'))).toBe(true);
  });

  it('adds SMS only when users have phones, and has no bridge without a client id', () => {
    const r = translateMagicConfig({ hasPhones: true });
    expect((r.documents.instance as { auth_config: { strategies: Record<string, boolean> } }).auth_config.strategies.phoneCode).toBe(true);
    expect(r.bridge).toBeUndefined();
    expect(r.origin).toBe('Magic app');
  });
});
