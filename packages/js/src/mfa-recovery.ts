import type { FapiClient } from './fapi';

/** The identity check a person opens to recover an account that lost every second factor. */
export interface RecoveryChallenge {
  verificationId: string;
  /** Where the person verifies their identity (null once the check left the pending state). */
  url: string | null;
  status: 'pending' | 'approved' | 'declined' | 'needs_review';
  /** Unix ms; the check cannot be used after this. */
  expiresAt: number;
}

const fail = (response: { errors: Array<{ message?: string; code?: string; reason?: string }> }, fallback: string): never => {
  const first = response.errors[0];
  const error = new Error(first?.message ?? fallback) as Error & { code?: string; reason?: string };
  if (first?.code) error.code = first.code;
  if (first?.reason) error.reason = first.reason;
  throw error;
};

/**
 * Whether this sign-in attempt can recover through an identity check: the application turned it on,
 * identity verification can report who was verified, and the account holds an earlier approved check
 * to match against. Call it once the first factor passed (`needs_second_factor`).
 */
export async function canRecoverWithIdentityCheck(client: FapiClient, attemptId: string): Promise<boolean> {
  const response = await client.get<{ factors?: unknown }>(`/v1/client/sign_ins/${encodeURIComponent(attemptId)}/second_factors`);
  return response.ok && Array.isArray(response.data?.factors) && response.data.factors.includes('identity_verification');
}

/** Start the identity check for this sign-in attempt. Send the person to `url`; then poll with `attempt_second_factor` `{ strategy: 'identity_verification' }`. */
export async function startIdentityCheckRecovery(client: FapiClient, attemptId: string, redirectUrl?: string): Promise<RecoveryChallenge> {
  const response = await client.post<{ verification_id?: unknown; url?: unknown; status?: unknown; expires_at?: unknown }>(
    `/v1/client/sign_ins/${encodeURIComponent(attemptId)}/prepare_second_factor`,
    { strategy: 'identity_verification', ...(redirectUrl ? { redirect_url: redirectUrl } : {}) },
  );
  if (!response.ok) return fail(response, 'Could not start the identity check.');
  const d = response.data;
  const status = d?.status === 'approved' || d?.status === 'declined' || d?.status === 'needs_review' ? d.status : 'pending';
  return {
    verificationId: typeof d?.verification_id === 'string' ? d.verification_id : '',
    url: typeof d?.url === 'string' ? d.url : null,
    status,
    expiresAt: typeof d?.expires_at === 'number' ? d.expires_at : 0,
  };
}
