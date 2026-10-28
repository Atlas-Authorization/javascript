import type { FapiClient, FlowState } from './fapi';

/** The outcome of an identity check (document and selfie at the verification service your app uses). */
export interface IdentityVerificationStatus {
  object: 'identity_verification';
  /** `none` until the user starts a check. `needs_review` waits for an operator. */
  status: 'none' | 'pending' | 'approved' | 'declined' | 'needs_review';
  id?: string;
  provider?: string;
  reason?: string | null;
  /** The service's hosted verification page, while `pending`. */
  url?: string | null;
  created_at?: number;
  completed_at?: number | null;
}

export type IdentityVerificationResult = { ok: true; data: IdentityVerificationStatus } | { ok: false; errors: Array<{ code?: string; message: string }> };

/**
 * Start (or resume) the signed-in user's identity check. Send the person to
 * `data.url`; they come back to `redirectUrl` (https) when done. Then call
 * {@link getIdentityVerification} until `status` is no longer `pending`.
 */
export async function startIdentityVerification(client: FapiClient, redirectUrl?: string): Promise<IdentityVerificationResult> {
  const res = await client.post<IdentityVerificationStatus>('/v1/client/me/identity_verification', redirectUrl ? { redirect_url: redirectUrl } : {});
  return res.ok && res.data ? { ok: true, data: res.data } : { ok: false, errors: res.errors };
}

/** The signed-in user's latest identity check and its outcome (`status: "none"` when they never started one). */
export async function getIdentityVerification(client: FapiClient): Promise<IdentityVerificationResult> {
  const res = await client.request<IdentityVerificationStatus>('/v1/client/me/identity_verification', { method: 'GET' });
  return res.ok && res.data ? { ok: true, data: res.data } : { ok: false, errors: res.errors };
}

/**
 * A sign-in held on the `identity_verification` required action (the application
 * or an access policy demands a verified identity): start the check and get the
 * verification page to send the person to. Afterwards call
 * `completeRequiredAction(client, state, { action: 'identity_verification' })`
 * to re-read the verdict; the flow moves on once the check is approved.
 */
export async function startAttemptIdentityVerification(client: FapiClient, state: FlowState, redirectUrl?: string): Promise<IdentityVerificationResult> {
  const id = state.attempt?.id;
  const proof = state.policyToken ? { required_action_token: state.policyToken } : state.pollSecret ? { poll_secret: state.pollSecret } : null;
  if (!id || !proof) return { ok: false, errors: [{ message: 'There is no sign-in waiting on an identity check.' }] };
  const res = await client.post<{ identity_verification?: IdentityVerificationStatus }>(`/v1/client/sign_ins/${encodeURIComponent(id)}/required_actions`, {
    action: 'identity_verification',
    step: 'start',
    ...(redirectUrl ? { redirect_url: redirectUrl } : {}),
    ...proof,
  });
  return res.ok && res.data?.identity_verification ? { ok: true, data: res.data.identity_verification } : { ok: false, errors: res.ok ? [{ message: 'No verification was started.' }] : res.errors };
}
