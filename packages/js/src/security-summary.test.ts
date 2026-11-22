import { describe, expect, it, vi } from 'vitest';
import type { FapiClient } from './fapi';
import { SecuritySummaryError, getSecuritySummary } from './security-summary';

const clientReturning = (res: { ok: boolean; status: number; data?: unknown; errors?: Array<{ code: string; message: string }> }) =>
  ({ request: vi.fn(async () => ({ errors: [], ...res })) }) as unknown as FapiClient;

describe('getSecuritySummary', () => {
  it('reads /v1/client/me/security_summary', async () => {
    const client = clientReturning({ ok: true, status: 200, data: { object: 'security_summary', user_id: 'user_1', sign_in_methods: ['password'] } });
    const summary = await getSecuritySummary(client);
    expect(summary.user_id).toBe('user_1');
    expect(client.request).toHaveBeenCalledWith('/v1/client/me/security_summary', { method: 'GET' });
  });

  it('throws the server error code on a refusal', async () => {
    const client = clientReturning({ ok: false, status: 401, errors: [{ code: 'UNAUTHENTICATED', message: 'Sign in.' }] });
    await expect(getSecuritySummary(client)).rejects.toMatchObject({ name: 'SecuritySummaryError', status: 401, code: 'UNAUTHENTICATED' });
    await expect(getSecuritySummary(client)).rejects.toBeInstanceOf(SecuritySummaryError);
  });
});
