/** A short code a signed-in user mints for a device of their own; the device redeems it to enrol. */
import type { FieldError } from './attempt';
import type { FapiClient } from './fapi';
import { stepUpRequirement, type StepUpRequirement } from './step-up';

export type MachineEnrolmentCodeResult =
  | {
      ok: true;
      /** The code to type on the device (`XXXX-XXXX`). Shown once. */
      code: string;
      id: string;
      /** Epoch milliseconds. */
      expiresAt: number;
      expiresIn: number;
    }
  | { ok: false; errors: FieldError[]; status: number; stepUpRequired: boolean; stepUp?: StepUpRequirement };

/**
 * Mint a single-use enrolment code for a device the signed-in user owns. Needs a session (not a token);
 * `expiresInSeconds` is 300 to 900 (default 600). A refused call that needs a fresh sign-in sets `stepUpRequired`.
 */
export async function createMachineEnrolmentCode(client: FapiClient, opts: { expiresInSeconds?: number } = {}): Promise<MachineEnrolmentCodeResult> {
  const res = await client.post<{ id: string; user_code: string; expires_at: number; expires_in: number }>(
    '/v1/client/me/machine_enrolment_codes',
    opts.expiresInSeconds === undefined ? {} : { expires_in_seconds: opts.expiresInSeconds },
  );
  if (!res.ok || !res.data) {
    const stepUp = stepUpRequirement(res.errors);
    return { ok: false, errors: res.errors, status: res.status, stepUpRequired: stepUp !== null, ...(stepUp ? { stepUp } : {}) };
  }
  return { ok: true, code: res.data.user_code, id: res.data.id, expiresAt: res.data.expires_at, expiresIn: res.data.expires_in };
}
