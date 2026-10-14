import { enc, type RequestFn } from './request';

/**
 * An email address addressed by its own id. The owning user is derived from
 * the address, so these calls need no user id (the `users.verifyEmail` /
 * `users.setPrimaryEmail` forms do the same with one).
 */
export interface EmailAddressRecord {
  object: 'email_address';
  id: string;
  email_address: string;
  verification: { status: 'verified' | 'unverified' };
  verified: boolean;
  primary: boolean;
}

export function emailAddressesResource(request: RequestFn) {
  return {
    /** `POST /v1/email_addresses/:id/verify` — mark the address verified. */
    verify(id: string): Promise<EmailAddressRecord> {
      return request({ method: 'POST', path: `/v1/email_addresses/${enc(id)}/verify` });
    },
    /** `POST /v1/email_addresses/:id/primary` — make a verified address the user's primary. */
    setPrimary(id: string): Promise<EmailAddressRecord> {
      return request({ method: 'POST', path: `/v1/email_addresses/${enc(id)}/primary` });
    },
  };
}
