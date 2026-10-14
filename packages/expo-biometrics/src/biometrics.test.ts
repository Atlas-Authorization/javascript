import { describe, expect, it } from 'vitest';
import { isBiometricsAvailable, protectWithBiometrics } from './index';
import type { LocalAuthentication, StoredSession } from './local-authentication';

function fakeAuth(over: Partial<LocalAuthentication> & { success?: boolean; error?: string } = {}): LocalAuthentication {
  return {
    hasHardwareAsync: over.hasHardwareAsync ?? (async () => true),
    isEnrolledAsync: over.isEnrolledAsync ?? (async () => true),
    authenticateAsync:
      over.authenticateAsync ??
      (async () => ({ success: over.success ?? true, ...(over.error ? { error: over.error } : {}) })),
  };
}

const session = (token: string | null): StoredSession => ({ getToken: () => token });

describe('isBiometricsAvailable', () => {
  it('is true only with hardware AND an enrolled biometric', async () => {
    expect(await isBiometricsAvailable(fakeAuth())).toBe(true);
    expect(await isBiometricsAvailable(fakeAuth({ isEnrolledAsync: async () => false }))).toBe(false);
    expect(await isBiometricsAvailable(fakeAuth({ hasHardwareAsync: async () => false }))).toBe(false);
  });
});

describe('protectWithBiometrics', () => {
  it('reveals the stored token when the prompt succeeds', async () => {
    const result = await protectWithBiometrics({ auth: fakeAuth({ success: true }), storage: session('sess.jwt') });
    expect(result).toEqual({ ok: true, token: 'sess.jwt' });
  });

  it('does NOT reveal the token when the prompt fails', async () => {
    const result = await protectWithBiometrics({
      auth: fakeAuth({ success: false, error: 'user_cancel' }),
      storage: session('sess.jwt'),
    });
    expect(result).toEqual({ ok: false, token: null, reason: 'authentication_failed', error: 'user_cancel' });
  });

  it('reports no_session when there is nothing stored', async () => {
    const result = await protectWithBiometrics({ auth: fakeAuth({ success: true }), storage: session(null) });
    expect(result).toEqual({ ok: false, token: null, reason: 'no_session' });
  });

  it('locks out by default when no biometric is enrolled', async () => {
    const result = await protectWithBiometrics({
      auth: fakeAuth({ isEnrolledAsync: async () => false }),
      storage: session('sess.jwt'),
    });
    expect(result).toEqual({ ok: false, token: null, reason: 'not_enrolled' });
  });

  it('allowWhenUnavailable reveals the session without a prompt', async () => {
    const result = await protectWithBiometrics({
      auth: fakeAuth({ hasHardwareAsync: async () => false, isEnrolledAsync: async () => false }),
      storage: session('sess.jwt'),
      allowWhenUnavailable: true,
    });
    expect(result).toEqual({ ok: true, token: 'sess.jwt' });
  });
});
