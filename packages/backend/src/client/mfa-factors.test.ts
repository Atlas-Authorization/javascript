import { describe, expect, it, vi } from 'vitest';
import { createAtlasClient } from './index';

function mock() {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ object: 'x' }), { status: 200 });
  });
  const atlas = createAtlasClient({ secretKey: 'sk_test_abc', apiUrl: 'https://api.example.test', fetch: impl as unknown as typeof fetch });
  return { atlas, calls };
}

describe('atlas.mfaFactors', () => {
  it('calls the secret, key registry, mapping and reset endpoints', async () => {
    const { atlas, calls } = mock();
    const f = atlas.mfaFactors;
    await f.setYubicoSecret('c2VjcmV0');
    await f.removeYubicoSecret();
    await f.setDuoSecret('duo-secret');
    await f.removeDuoSecret();
    await f.duoHealthCheck();
    await f.setSmartCardSecret('proxy-secret');
    await f.removeSmartCardSecret();
    await f.yubikeys.list();
    await f.yubikeys.register({ publicId: 'ccccccccccc', aesKey: 'aa'.repeat(16), label: 'desk' });
    await f.yubikeys.remove('ybk_1');
    await f.smartCardMappings.list('user_1');
    await f.smartCardMappings.add('user_1', { kind: 'serial', value: '0A1B', issuer: 'CN=CA' });
    await f.smartCardMappings.remove('user_1', 'scm_1');
    await f.resetSecurityQuestions('user_1');
    expect(calls.map((c) => `${c.method} ${c.url.replace('https://api.example.test', '')}`)).toEqual([
      'PUT /v1/instance/yubico_secret',
      'DELETE /v1/instance/yubico_secret',
      'PUT /v1/instance/duo_secret',
      'DELETE /v1/instance/duo_secret',
      'POST /v1/instance/duo_health_check',
      'PUT /v1/instance/smart_card_secret',
      'DELETE /v1/instance/smart_card_secret',
      'GET /v1/yubikeys',
      'POST /v1/yubikeys',
      'DELETE /v1/yubikeys/ybk_1',
      'GET /v1/users/user_1/smartcard_mappings',
      'POST /v1/users/user_1/smartcard_mappings',
      'DELETE /v1/users/user_1/smartcard_mappings/scm_1',
      'DELETE /v1/users/user_1/security_questions',
    ]);
    expect(calls[0]!.body).toEqual({ secret: 'c2VjcmV0' });
    expect(calls[8]!.body).toMatchObject({ public_id: 'ccccccccccc', aes_key: 'aa'.repeat(16), label: 'desk' });
    expect(calls[11]!.body).toEqual({ kind: 'serial', value: '0A1B', issuer: 'CN=CA' });
  });

  it('accepts a TOTP or HOTP import on user create', async () => {
    const { atlas, calls } = mock();
    await atlas.users.create({ email_address: 'a@b.co', mfa: { hotp: { secret_base32: 'JBSWY3DPEHPK3PXP', counter: 4, digits: 8, algorithm: 'SHA256' } } });
    expect(calls[0]!.body).toMatchObject({ mfa: { hotp: { counter: 4, digits: 8, algorithm: 'SHA256' } } });
  });
});
