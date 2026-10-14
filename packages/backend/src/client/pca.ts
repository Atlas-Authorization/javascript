import { enc, type RequestFn } from './request';

/**
 * Server-side controls for Proof-Carrying Authority (agentic actions): trusted
 * attestor keys, the instance-wide kill switch, capability revocation and
 * denying a held step-up. Verifying a PCActn offline is `verifyPCActn`.
 */
export interface PcaAdminAttestors {
  object: 'pca_attestors';
  /** b64u Ed25519 public keys. */
  trusted_attestor_keys: string[];
}

export interface PcaAdminFreeze {
  object: 'pca_freeze';
  frozen: boolean;
}

export interface PcaAdminRevocation {
  object: 'pca_revocation';
  grant_ref: string;
  cap_id: string;
  revoked: boolean;
}

export interface PcaAdminStepUp {
  object: 'pca_stepup';
  stepup_id: string;
  grant_ref: string;
  action_digest: string;
  required_t: number;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  /** Roles that have contributed a share. */
  shares: string[];
  created_at: string;
  expires_at: string;
  receipt?: Record<string, unknown>;
  step_up_required?: boolean;
}

export function pcaResource(request: RequestFn) {
  return {
    attestors: {
      get(): Promise<PcaAdminAttestors> {
        return request({ method: 'GET', path: '/v1/pca/attestors' });
      },
      /**
       * Replace the trusted attestor key list (max 50). Non-empty: a presented
       * attestation is verified against these keys. Empty: attestation is not enforced.
       */
      set(trustedAttestorKeys: string[]): Promise<PcaAdminAttestors> {
        return request({
          method: 'PUT',
          path: '/v1/pca/attestors',
          body: { trusted_attestor_keys: trustedAttestorKeys },
        });
      },
    },
    /** Engage the instance-wide kill switch: every PCActn is denied until `unfreeze`. */
    freeze(body: { reason?: string } = {}): Promise<PcaAdminFreeze> {
      return request({ method: 'POST', path: '/v1/pca/freeze', body });
    },
    unfreeze(): Promise<PcaAdminFreeze> {
      return request({ method: 'DELETE', path: '/v1/pca/freeze' });
    },
    /** Revoke a capability under a grant; revoking `grant_ref` itself revokes the whole grant. */
    revoke(body: { grant_ref: string; cap_id: string }): Promise<PcaAdminRevocation> {
      return request({ method: 'POST', path: '/v1/pca/revocations', body });
    },
    /** Deny a pending step-up: the held action is never anchored. */
    denyStepUp(id: string, body: { reason?: string } = {}): Promise<PcaAdminStepUp> {
      return request({ method: 'POST', path: `/v1/pca/stepups/${enc(id)}/deny`, body });
    },
  };
}
