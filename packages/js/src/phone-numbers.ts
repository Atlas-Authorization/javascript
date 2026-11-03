import type { FapiClient } from './fapi';

/**
 * Self-service phone numbers — a signed-in user adds, verifies (texted code),
 * picks a primary and removes their OWN numbers over `/v1/client/me/phone_numbers`.
 * Cookie-authenticated through the {@link FapiClient}.
 *
 * Adding a number from a session that has not re-authenticated recently, and
 * making one primary or removing one at any time after the step-up window,
 * fails with a {@link PhoneNumberRequestError} whose `code` is
 * `STEP_UP_REQUIRED`. Re-authenticate (`reauthenticate()`), then retry.
 */

export interface UserPhoneNumber {
  object: 'phone_number';
  id: string;
  /** E.164. */
  phone_number: string;
  verified: boolean;
  /** Where account SMS goes. Only a verified number can be primary. */
  primary: boolean;
  created_at?: number;
}

/** A refused request. `code` is the server's stable error code. */
export class PhoneNumberRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly param?: string;
  readonly reason?: string;

  constructor(status: number, code: string, message: string, param?: string, reason?: string) {
    super(message);
    this.name = 'PhoneNumberRequestError';
    this.status = status;
    this.code = code;
    this.param = param;
    if (reason) this.reason = reason;
  }

  /** True when the action needs a fresh re-authentication first. */
  get needsReverification(): boolean {
    return this.code === 'STEP_UP_REQUIRED';
  }
}

const BASE = '/v1/client/me/phone_numbers';

async function call<T>(client: FapiClient, path: string, init: RequestInit = {}): Promise<T> {
  const res = await client.request<T>(path, init);
  if (!res.ok || !res.data) {
    const first = res.errors[0];
    throw new PhoneNumberRequestError(
      res.status,
      first?.code ?? 'UNKNOWN',
      first?.message ?? 'The request failed.',
      first?.param,
      first?.reason,
    );
  }
  return res.data;
}

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

/** The user's numbers, verified or not. */
export async function listPhoneNumbers(client: FapiClient): Promise<UserPhoneNumber[]> {
  return (await call<{ data: UserPhoneNumber[] }>(client, BASE, { method: 'GET' })).data ?? [];
}

/** Add a number (E.164, e.g. `+15551234567`); a verification code is texted to it. */
export function addPhoneNumber(client: FapiClient, phoneNumber: string): Promise<UserPhoneNumber> {
  return call(client, BASE, json({ phone_number: phoneNumber }));
}

/** Text a fresh code to a number the user holds but has not verified. */
export function preparePhoneNumberVerification(client: FapiClient, id: string): Promise<UserPhoneNumber> {
  return call(client, `${BASE}/${encodeURIComponent(id)}/prepare_verification`, { method: 'POST' });
}

/** Verify a number with the texted code. The first verified number becomes primary. */
export function attemptPhoneNumberVerification(
  client: FapiClient,
  id: string,
  code: string,
): Promise<UserPhoneNumber> {
  return call(client, `${BASE}/${encodeURIComponent(id)}/attempt_verification`, json({ code }));
}

/** Make a verified number primary. Needs a recent re-authentication. */
export function setPrimaryPhoneNumber(client: FapiClient, id: string): Promise<UserPhoneNumber> {
  return call(client, `${BASE}/${encodeURIComponent(id)}/primary`, { method: 'POST' });
}

/** Remove a number. Needs a recent re-authentication; the last way to sign in is refused. */
export async function removePhoneNumber(client: FapiClient, id: string): Promise<void> {
  await call(client, `${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
