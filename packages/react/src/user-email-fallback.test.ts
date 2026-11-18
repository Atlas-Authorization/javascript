import { describe, expect, it } from 'vitest';
import type { AtlasUser } from './types';
import { withClaimEmail } from './user-email-fallback';

const base = { id: 'user_1', first_name: null, last_name: null, username: null, image_url: null, public_metadata: {}, unsafe_metadata: {}, mfa_enabled: false, has_password: true } as AtlasUser;

describe('withClaimEmail', () => {
  it('fills the primary address from the email claim', () => {
    const u = withClaimEmail(base, { email: 'a@example.com', email_verified: true });
    expect(u?.email_addresses).toEqual([{ id: '', email_address: 'a@example.com', verified: true, primary: true }]);
  });
  it('never replaces a list the server sent, and passes null and claim-less users through', () => {
    const withList = { ...base, email_addresses: [{ id: 'e1', email_address: 'b@example.com', verified: false, primary: true }] };
    expect(withClaimEmail(withList, { email: 'a@example.com' })).toBe(withList);
    expect(withClaimEmail(null, { email: 'a@example.com' })).toBeNull();
    expect(withClaimEmail(base, null)).toBe(base);
  });
});
