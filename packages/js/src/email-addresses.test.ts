import { describe, expect, it, vi } from 'vitest';
import type { FapiClient } from './fapi';
import { confirmPrimaryEmailAddress, EmailAddressRequestError, setPrimaryEmailAddress } from './email-addresses';

const client = (res: unknown) => ({ request: vi.fn(async () => res) }) as unknown as FapiClient & { request: ReturnType<typeof vi.fn> };

describe('secure primary email change', () => {
  it('returns the pending status', async () => {
    const c = client({ ok: true, status: 202, errors: [], data: { object: 'email_address', id: 'e1', primary: false, status: 'pending_old_address_confirmation' } });
    expect((await setPrimaryEmailAddress(c, 'e1')).status).toBe('pending_old_address_confirmation');
    expect(c.request).toHaveBeenCalledWith('/v1/client/me/email_addresses/e1/primary', { method: 'POST' });
  });
  it('posts the code and throws a typed error on refusal', async () => {
    const c = client({ ok: true, status: 200, errors: [], data: { object: 'email_address', id: 'e1', primary: true } });
    await confirmPrimaryEmailAddress(c, 'e1', '123456');
    expect(c.request).toHaveBeenCalledWith('/v1/client/me/email_addresses/e1/confirm_primary', { method: 'POST', body: '{"code":"123456"}' });
    await expect(confirmPrimaryEmailAddress(client({ ok: false, status: 400, errors: [{ code: 'VERIFICATION_FAILED', message: 'no' }] }), 'e1', 'x')).rejects.toBeInstanceOf(EmailAddressRequestError);
  });
});
