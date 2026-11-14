import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

export type MachineTrustPolicyKind = 'github_actions' | 'kubernetes' | 'aws' | 'gcp' | 'oidc';

/** One condition on the external token's claims. A missing claim never passes. */
export interface MachineTrustCondition {
  claim: string;
  op: 'equals' | 'in' | 'glob' | 'exists';
  value?: string | string[];
}

/** A rule that lets a workload platform token be exchanged for a machine token of one machine. */
export interface MachineTrustPolicy {
  object: 'machine_trust_policy';
  id: string;
  machine_id: string;
  name: string;
  kind: MachineTrustPolicyKind;
  /** The expected `iss`. Null for aws. */
  issuer: string | null;
  jwks_uri: string | null;
  jwks: { keys: Record<string, unknown>[] } | null;
  audience: string;
  subject_pattern: string;
  claim_conditions: MachineTrustCondition[];
  max_ttl_seconds: number;
  enabled: boolean;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface CreateMachineTrustPolicyBody {
  machine_id: string;
  name: string;
  kind: MachineTrustPolicyKind;
  /** https. github_actions and gcp default it; kubernetes and oidc need it; aws takes none. */
  issuer?: string | null;
  jwks_uri?: string | null;
  /** Inline public keys, for an issuer Atlas cannot reach (a cluster's service account issuer). */
  jwks?: { keys: Record<string, unknown>[] } | null;
  /** What the external token's `aud` must be (for aws: the value signed into `x-atlas-audience`). */
  audience: string;
  /** A glob (`*`, `?`) for the token's `sub`, naming the owner: `repo:my-org/my-repo:*`, `system:serviceaccount:prod:deployer`, `arn:aws:iam::123456789012:role/deployer`. */
  subject_pattern: string;
  claim_conditions?: MachineTrustCondition[];
  /** 60 to 3600. Default 600. */
  max_ttl_seconds?: number;
  enabled?: boolean;
}

/** Send only what changes. `kind` and `machine_id` cannot change. */
export type UpdateMachineTrustPolicyBody = Partial<Omit<CreateMachineTrustPolicyBody, 'kind' | 'machine_id'>>;

/** The signed AWS request from `awsIdentityProof` (in `@atlasauth/backend/machine`). */
export interface MachineTrustAwsProof {
  method?: 'POST';
  url: string;
  body: string;
  headers: Record<string, string>;
}

export interface MachineTrustPolicyTestResult {
  object: 'machine_trust_policy_test';
  accepted: boolean;
  subject: string | null;
  claims: Record<string, unknown> | null;
  /** Why it was refused: token_invalid, subject_mismatch, claim_condition_failed, issuer_keys_unavailable, aws_audience... */
  reasons: string[];
}

export function machineTrustPoliciesResource(request: RequestFn) {
  return {
    list(params: { machine_id?: string } = {}): Promise<ListPage<MachineTrustPolicy>> {
      return request({ method: 'GET', path: '/v1/machine_trust_policies', query: { ...params } });
    },
    /** Needs a recent MFA sign-in: a policy lets a platform token act as the machine. */
    create(body: CreateMachineTrustPolicyBody, idempotencyKey?: string): Promise<MachineTrustPolicy> {
      return request({ method: 'POST', path: '/v1/machine_trust_policies', body, idempotencyKey });
    },
    get(id: string): Promise<MachineTrustPolicy> {
      return request({ method: 'GET', path: `/v1/machine_trust_policies/${enc(id)}` });
    },
    update(id: string, body: UpdateMachineTrustPolicyBody): Promise<MachineTrustPolicy> {
      return request({ method: 'PATCH', path: `/v1/machine_trust_policies/${enc(id)}`, body });
    },
    delete(id: string): Promise<{ object: 'machine_trust_policy'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/machine_trust_policies/${enc(id)}` });
    },
    /** Dry run: would this token (or signed AWS request) be accepted? Mints nothing, spends nothing. */
    test(id: string, input: { token: string } | { aws: MachineTrustAwsProof }): Promise<MachineTrustPolicyTestResult> {
      return request({ method: 'POST', path: `/v1/machine_trust_policies/${enc(id)}/test`, body: input });
    },
  };
}
