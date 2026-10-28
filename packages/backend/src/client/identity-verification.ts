import { enc, type RequestFn } from './request';

export type IdentityVerificationOutcome = 'pending' | 'approved' | 'declined' | 'needs_review';

export interface IdentityVerification {
  object: 'identity_verification';
  id: string;
  user_id: string;
  provider: 'persona' | 'onfido' | 'veriff' | 'stripe_identity';
  status: IdentityVerificationOutcome;
  reason: string | null;
  /** The verification service's hosted page, while pending. */
  url: string | null;
  decided_by: string | null;
  created_at: number;
  completed_at: number | null;
}

export interface IdentityVerificationSettings {
  object: 'identity_verification_settings';
  enabled: boolean;
  /** The service connector (Persona, Onfido, Veriff or Stripe Identity) that does the checking. */
  connector_id: string | null;
  /** Offer a verified identity as the custom second step of sign-in. */
  as_challenge: boolean;
  /** Give this URL to the verification service for verdict webhooks; store its webhook secret on the connector as `webhook_secret`. */
  webhook_url: string | null;
}

/**
 * Identity verification (document and selfie) through your own verification
 * service. An approved check is written to the user as
 * `public_metadata.verification.identity` (`{ status, provider, verified_at }`).
 */
export function identityVerificationResource(request: RequestFn) {
  return {
    settings(): Promise<IdentityVerificationSettings> {
      return request({ method: 'GET', path: '/v1/identity_verification/settings' });
    },
    updateSettings(body: { enabled: boolean; connector_id?: string | null; as_challenge?: boolean }): Promise<IdentityVerificationSettings> {
      return request({ method: 'PUT', path: '/v1/identity_verification/settings', body });
    },
    /** Checks by status, newest first. Defaults to `needs_review`, the review queue. */
    list(params: { status?: IdentityVerificationOutcome } = {}): Promise<{ object: 'list'; data: IdentityVerification[]; has_more: boolean }> {
      return request({ method: 'GET', path: '/v1/identity_verifications', query: params });
    },
    /** One check; a pending one is refreshed from the verification service. */
    get(id: string): Promise<IdentityVerification> {
      return request({ method: 'GET', path: `/v1/identity_verifications/${enc(id)}` });
    },
    /** Approve or decline a check that is waiting for review. */
    decide(id: string, body: { decision: 'approved' | 'declined'; reason?: string }): Promise<IdentityVerification> {
      return request({ method: 'POST', path: `/v1/identity_verifications/${enc(id)}/decide`, body });
    },
    forUser(userId: string): Promise<{ object: 'list'; data: IdentityVerification[]; has_more: boolean }> {
      return request({ method: 'GET', path: `/v1/users/${enc(userId)}/identity_verifications` });
    },
    /** Start a check for a user; send them to the returned `url`. */
    start(userId: string, body: { redirect_url?: string } = {}): Promise<IdentityVerification> {
      return request({ method: 'POST', path: `/v1/users/${enc(userId)}/identity_verifications`, body });
    },
  };
}
