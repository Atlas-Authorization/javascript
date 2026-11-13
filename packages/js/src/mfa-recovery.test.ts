import { describe, expect, it, vi } from 'vitest';
import type { FapiClient } from './fapi';
import { canRecoverWithIdentityCheck, startIdentityCheckRecovery } from './mfa-recovery';

function stub(ok: boolean, data: unknown, errors: unknown[] = []) {
  const calls: Array<{ path: string; body?: unknown }> = [];
  const reply = (path: string, body?: unknown) => {
    calls.push({ path, body });
    return Promise.resolve({ ok, status: ok ? 200 : 409, data: ok ? data : null, errors });
  };
  const client = { get: vi.fn((path: string) => reply(path)), post: vi.fn((path: string, body?: unknown) => reply(path, body)) } as unknown as FapiClient;
  return { client, calls };
}

describe('recovery through an identity check', () => {
  it('starts the check for the attempt and returns the vendor link', async () => {
    const { client, calls } = stub(true, { verification_id: 'idv_1', url: 'https://v.example/x', status: 'pending', expires_at: 1234 });
    const res = await startIdentityCheckRecovery(client, 'att_1', 'https://app.example/back');
    expect(res).toEqual({ verificationId: 'idv_1', url: 'https://v.example/x', status: 'pending', expiresAt: 1234 });
    expect(calls[0]).toEqual({ path: '/v1/client/sign_ins/att_1/prepare_second_factor', body: { strategy: 'identity_verification', redirect_url: 'https://app.example/back' } });
  });

  it('throws the server reason when recovery is unavailable', async () => {
    const { client } = stub(false, null, [{ code: 'MFA_SETUP_UNAVAILABLE', reason: 'mfa_recovery_no_baseline', message: 'No earlier check.' }]);
    await expect(startIdentityCheckRecovery(client, 'att_1')).rejects.toMatchObject({ code: 'MFA_SETUP_UNAVAILABLE', reason: 'mfa_recovery_no_baseline' });
  });

  it('reports whether the attempt can recover', async () => {
    expect(await canRecoverWithIdentityCheck(stub(true, { factors: ['totp', 'identity_verification'] }).client, 'a')).toBe(true);
    expect(await canRecoverWithIdentityCheck(stub(true, { factors: ['totp'] }).client, 'a')).toBe(false);
    expect(await canRecoverWithIdentityCheck(stub(false, null).client, 'a')).toBe(false);
  });
});
