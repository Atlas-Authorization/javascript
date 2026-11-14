import { enc, type RequestFn } from './request';

export type IdentityVerificationOutcome = 'pending' | 'approved' | 'declined' | 'needs_review';

export interface IdentityVerification {
  object: 'identity_verification';
  id: string;
  user_id: string;
  provider: 'persona' | 'onfido' | 'veriff' | 'stripe_identity';
  status: IdentityVerificationOutcome;
  reason: string | null;
  /** True when the check was recorded from an existing session with `import`. */
  imported: boolean;
  /** When the verification service verified the person (epoch ms); an imported check keeps the service's own time. */
  verified_at: number | null;
  /** Where the opted-in verified attributes stand; the values themselves are only ever delivered once. */
  verified_attributes_status: 'stored' | 'delivered' | 'expired' | null;
  /** The verification service's hosted page, while pending. */
  url: string | null;
  decided_by: string | null;
  created_at: number;
  completed_at: number | null;
}

/** The facts delivered once after an approved check. Each is present only when configured and reported by the service. */
export interface VerifiedAttributes {
  full_name?: string;
  birth_year?: number;
  birth_month?: number;
  /** One boolean per configured age, keyed by the age: `{ "18": true, "21": false }`. */
  age_over?: Record<string, boolean>;
  /** The document's issuing country (ISO 3166-1 alpha-2). */
  document_country?: string;
}

export interface VerifiedAttributesSetting {
  fields: Array<'full_name' | 'birth_year' | 'birth_month' | 'age_over' | 'document_country'>;
  /** Ages to answer as booleans, for example `[18, 21]`. Required when `fields` includes `age_over`. */
  age_over?: number[];
  /** Days an uncollected set is kept before it is destroyed (1 to 30, default 7). */
  retention_days?: number;
}

/** A check read through `getForUser`: the first read after approval also carries the verified attributes, once. */
export type IdentityVerificationWithAttributes = IdentityVerification & { verified_attributes?: VerifiedAttributes };

export interface IdentityVerificationSettings {
  object: 'identity_verification_settings';
  enabled: boolean;
  /** The service connector (Persona, Onfido, Veriff or Stripe Identity) that does the checking. */
  connector_id: string | null;
  /** Offer a verified identity as the custom second step of sign-in. */
  as_challenge: boolean;
  /** The opt-in verified attributes, or null when off. */
  verified_attributes: Required<VerifiedAttributesSetting> | null;
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
    /** `verified_attributes`: leave out to keep the current setting, `null` to turn it off. */
    updateSettings(body: { enabled: boolean; connector_id?: string | null; as_challenge?: boolean; verified_attributes?: VerifiedAttributesSetting | null }): Promise<IdentityVerificationSettings> {
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
    /**
     * One of a user's checks (needs only `users:read`). The FIRST read after an approval also returns
     * `verified_attributes` when you opted in; Atlas destroys its copy at that moment.
     */
    getForUser(userId: string, attemptId: string): Promise<IdentityVerificationWithAttributes> {
      return request({ method: 'GET', path: `/v1/users/${enc(userId)}/identity_verifications/${enc(attemptId)}` });
    },
    /**
     * Record a check the person already passed at the verification service. Atlas re-reads the session
     * itself and records it only if verified, with the service's own verification time.
     */
    importCheck(userId: string, body: { provider: IdentityVerification['provider']; session_id: string }): Promise<IdentityVerification> {
      return request({ method: 'POST', path: `/v1/users/${enc(userId)}/identity_verifications/import`, body });
    },
  };
}
