import type { FapiClient } from './fapi';

/**
 * Secure primary-email change. Making a different verified address primary
 * answers `status: 'pending_old_address_confirmation'` when the instance sets
 * `accountUx.emailChange.requireOldAddressConfirm`: a code was mailed to the
 * current primary address, and {@link confirmPrimaryEmailAddress} finishes the switch.
 */
export interface PrimaryEmailResult {
  object: 'email_address';
  id: string;
  primary: boolean;
  status?: 'pending_old_address_confirmation';
  /** Masked current primary address that received the code. */
  old_address?: string;
}

export class EmailAddressRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'EmailAddressRequestError';
  }
}

async function call(client: FapiClient, id: string, action: string, body?: unknown): Promise<PrimaryEmailResult> {
  const res = await client.request<PrimaryEmailResult>(`/v1/client/me/email_addresses/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok || !res.data) {
    const first = res.errors[0];
    throw new EmailAddressRequestError(res.status, first?.code ?? 'UNKNOWN', first?.message ?? 'The request failed.');
  }
  return res.data;
}

/** Make a verified address primary. Check `result.status` for a pending old-address confirmation. */
export function setPrimaryEmailAddress(client: FapiClient, id: string): Promise<PrimaryEmailResult> {
  return call(client, id, 'primary');
}

/** Finish a pending switch with the code mailed to the old primary address. */
export function confirmPrimaryEmailAddress(client: FapiClient, id: string, code: string): Promise<PrimaryEmailResult> {
  return call(client, id, 'confirm_primary', { code });
}
