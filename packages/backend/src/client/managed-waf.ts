import { type RequestFn } from './request';

/** Credential config, with secrets reduced to `has_*` markers. */
export interface ManagedWafCredential {
  /** 'keys' (BYO IAM key/secret) | 'role' (cross-account STS AssumeRole). */
  mode: string;
  /** `keys` mode: the IAM access key id (an identifier, not a secret). */
  access_key_id: string | null;
  /** Whether a secret access key EXISTS — never the secret itself. */
  has_secret_access_key: boolean;
  /** `role` mode: the ARN of the cross-account role Atlas assumes. */
  role_arn: string | null;
  /** Whether an AssumeRole ExternalId EXISTS — never the value itself. */
  has_external_id: boolean;
}

/**
 * §5 Managed AWS WAF config + provisioning state. Secrets are write-only and
 * NEVER returned; GET exposes only `has_*` markers. When the instance has no
 * config the response collapses to `{ configured: false, enabled: false,
 * status: 'disabled' }` and the config fields are absent.
 */
export interface ManagedWaf {
  object: 'managed_waf';
  configured: boolean;
  enabled: boolean;
  /** 'disabled' | 'active' | 'error' */
  status: string;
  scope?: string;
  region?: string;
  web_acl_name?: string;
  edge_resource_arn?: string | null;
  cloudfront_distribution_id?: string | null;
  token_domains?: string[];
  gated_paths?: string[];
  immunity_seconds?: number;
  credential?: ManagedWafCredential;
  web_acl_id?: string | null;
  web_acl_arn?: string | null;
  last_error?: string | null;
  last_provisioned_at?: number | null;
  updated_at?: number;
}

/** Just the provisioning state — what `GET /v1/managed_waf/status` returns. */
export interface ManagedWafStatus {
  object: 'managed_waf_status';
  enabled: boolean;
  status: string;
  web_acl_id: string | null;
  web_acl_arn: string | null;
  last_error: string | null;
  last_provisioned_at: number | null;
}

/**
 * The outcome of a provision/deprovision: the full config plus the FAIL-SAFE
 * result. An AWS failure rides `ok: false` + `error` in the body rather than
 * throwing, so it never looks like an Atlas outage.
 */
export type ManagedWafOutcome = ManagedWaf & {
  ok: boolean;
  error: string | null;
};

export interface UpdateManagedWafBody {
  enabled?: boolean;
  /** 'REGIONAL' | 'CLOUDFRONT' */
  scope?: string;
  region?: string;
  web_acl_name?: string;
  edge_resource_arn?: string | null;
  cloudfront_distribution_id?: string | null;
  token_domains?: string[];
  gated_paths?: string[];
  /** 60..86400 seconds. */
  immunity_seconds?: number;
  credential?: {
    /** 'keys' | 'role' */
    mode?: string;
    access_key_id?: string | null;
    /** Write-only: accepted, encrypted at rest, never returned. */
    secret_access_key?: string | null;
    role_arn?: string | null;
    /** Write-only: accepted, encrypted at rest, never returned. */
    external_id?: string | null;
  };
}

/**
 * The self-service control plane for Atlas's managed AWS WAF captcha gate —
 * config + write-only credentials, and the provision/deprovision actions that
 * reconcile the WebACL.
 */
export function managedWafResource(request: RequestFn) {
  return {
    /** Read config + provisioning state, with secrets reduced to `has_*` markers. */
    get(): Promise<ManagedWaf> {
      return request({ method: 'GET', path: '/v1/managed_waf' });
    },
    /** Read just the provisioning state. */
    status(): Promise<ManagedWafStatus> {
      return request({ method: 'GET', path: '/v1/managed_waf/status' });
    },
    /** Set config and write-only credentials; omitted fields are left unchanged. */
    update(body: UpdateManagedWafBody): Promise<ManagedWaf> {
      return request({ method: 'PUT', path: '/v1/managed_waf', body });
    },
    /** Apply now — idempotent create/update + associate the WebACL. */
    provision(): Promise<ManagedWafOutcome> {
      return request({ method: 'POST', path: '/v1/managed_waf/provision' });
    },
    /** Disassociate and delete the WebACL. */
    deprovision(): Promise<ManagedWafOutcome> {
      return request({ method: 'POST', path: '/v1/managed_waf/deprovision' });
    },
  };
}
