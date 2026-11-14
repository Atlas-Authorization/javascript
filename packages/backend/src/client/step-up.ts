import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

/** The step-up strategies a policy can accept (what `POST /v1/client/me/step_up` takes, plus push, Duo and Yubico OTP). */
export type StepUpMethodName = 'password' | 'passkey' | 'totp' | 'backup_code' | 'email_code' | 'phone_code' | 'push' | 'duo' | 'yubikey';

export interface StepUpPolicy {
  object: 'step_up_policy';
  id: string;
  name: string;
  description: string | null;
  /** A disabled policy answers 409 to an assertion; it never allows. */
  enabled: boolean;
  /** The last authentication (sign-in or step-up) must be at most this old. */
  max_age_seconds: number;
  /** The session acr must be one of these. Empty: any. */
  required_acr: string[];
  /** Every one of these amr values must be present. */
  required_amr: string[];
  /** At least one of these amr values must be present. Empty: no constraint. */
  required_amr_any: string[];
  /** Only a passkey counts. */
  phishing_resistant: boolean;
  /** The methods that may satisfy it. Empty: any. */
  allowed_methods: StepUpMethodName[];
  /** The strategies that can satisfy it once phishing resistance has narrowed `allowed_methods`. */
  accepted_factors: StepUpMethodName[];
  /** How long a signed receipt for an allowed assertion lives, 10 to 300 seconds. */
  receipt_ttl_seconds: number;
  created_at: number;
  updated_at: number;
}

export interface StepUpPolicyInput {
  /** Lowercase letters, digits and `_ . : -`, up to 64 characters, unique. */
  name: string;
  description?: string | null;
  enabled?: boolean;
  /** Default 300. */
  max_age_seconds?: number;
  required_acr?: string[];
  required_amr?: string[];
  required_amr_any?: string[];
  /** Needs `passkey` among `allowed_methods`, or no `allowed_methods`. */
  phishing_resistant?: boolean;
  allowed_methods?: StepUpMethodName[];
  /** Default 60. */
  receipt_ttl_seconds?: number;
}

export type StepUpDenyReason =
  | 'stale'
  | 'acr_not_met'
  | 'amr_missing'
  | 'amr_any_missing'
  | 'not_phishing_resistant'
  | 'method_not_allowed'
  | 'invalid_token'
  | 'session_inactive';

/** The answer to `assert`. A denial is an answer, not an error. */
export interface StepUpAssertion {
  object: 'step_up_assertion';
  allowed: boolean;
  reason: StepUpDenyReason | null;
  policy: string;
  user_id: string | null;
  session_id: string | null;
  seconds_since_authentication: number | null;
  /** Allowed only. */
  auth_time?: number;
  amr?: string[];
  acr?: string;
  /** Allowed only: a signed JWT (`typ: step-up-receipt+jwt`) to verify offline with `verifyStepUpReceipt`. */
  receipt?: string;
  receipt_id?: string;
  receipt_expires_at?: number;
  /** Denied only: the `meta` to put in the 403 STEP_UP_REQUIRED you return, so a client can run `withStepUp(policy, ...)`. */
  step_up?: { action: string; policy: string; accepted_factors: string[]; max_age_seconds: number; reason?: string; seconds_since_authentication?: number };
}

export interface StepUpAssertBody {
  /** The session token (JWT) the caller presented. */
  token: string;
  policy: string;
  authorized_parties?: string[];
  /** 10 to 300; shorter than the policy's own. */
  receipt_ttl_seconds?: number;
  /** Stamped as the receipt `aud`. */
  audience?: string;
}

/** Named step-up policies (`/v1/step_up/...`) and the assertion a resource server asks before a sensitive action. */
export function stepUpResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<StepUpPolicy>> {
      return request({ method: 'GET', path: '/v1/step_up/policies' });
    },
    create(body: StepUpPolicyInput, options: { idempotencyKey?: string } = {}): Promise<StepUpPolicy> {
      return request({ method: 'POST', path: '/v1/step_up/policies', body, idempotencyKey: options.idempotencyKey });
    },
    get(id: string): Promise<StepUpPolicy> {
      return request({ method: 'GET', path: `/v1/step_up/policies/${enc(id)}` });
    },
    update(id: string, body: Partial<StepUpPolicyInput>): Promise<StepUpPolicy> {
      return request({ method: 'PATCH', path: `/v1/step_up/policies/${enc(id)}`, body });
    },
    delete(id: string): Promise<{ object: 'step_up_policy'; id: string; name: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/step_up/policies/${enc(id)}` });
    },
    /** Does the session behind `token` meet the named policy right now? 404 for an unknown policy, 409 for a disabled one. */
    assert(body: StepUpAssertBody): Promise<StepUpAssertion> {
      return request({ method: 'POST', path: '/v1/step_up/assert', body });
    },
  };
}
