import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

export type RiskyUserState = 'none' | 'at_risk' | 'confirmed_compromised' | 'dismissed' | 'remediated';

export interface RiskyUser {
  object: 'risky_user';
  user_id: string;
  state: RiskyUserState;
  level: 'low' | 'medium' | 'high';
  /** Cumulative score; halves every 72 hours. */
  score: number;
  reasons: string[];
  last_event_at: number | null;
  resolved_by: string | null;
  resolved_at: number | null;
  updated_at: number;
}

export interface UserContainment {
  object: 'user_containment';
  id: string;
  user_id: string;
  state: 'contained' | 'released';
  reason: string | null;
  source: string;
  /** What containment revoked: sessions, api_tokens, api_keys, agent_grants, device_keys, desktop_devices, remembered_devices, temporary_passes. */
  revoked: Record<string, number>;
  contained_by: string | null;
  released_by: string | null;
  created_at: number;
  released_at: number | null;
  already_contained?: boolean;
}

export interface MfaFactorQuarantine {
  object: 'mfa_factor_quarantine';
  id: string;
  user_id: string;
  factor_type: string;
  factor_id: string;
  reason: string | null;
  until: number;
  released_at: number | null;
  created_at: number;
}

export interface TemporaryAccessPass {
  object: 'temporary_access_pass';
  id: string;
  user_id: string;
  expires_at: number;
  uses_left: number;
  require_enrolment: boolean;
  bound_ip: string | null;
  issued_by: string | null;
  reason: string | null;
  last_used_at: number | null;
  created_at: number;
}

export interface CreateTemporaryAccessBody {
  /** 60 to 604800; default 3600. */
  lifetime_seconds?: number;
  /** Default true (one use). */
  one_time?: boolean;
  /** 1 to 100 uses when `one_time` is false; default 5. */
  uses?: number;
  /** Make the user register a passkey or second factor after signing in; default true. */
  require_enrolment?: boolean;
  bound_ip?: string;
  reason?: string;
}

/** Risky-user lifecycle, one-action account containment and risky-factor quarantine. */
export function riskResource(request: RequestFn) {
  return {
    riskyUsers: {
      list(query: { state?: Exclude<RiskyUserState, 'none'>; limit?: number } = {}): Promise<ListPage<RiskyUser>> {
        return request({ method: 'GET', path: '/v1/risky_users', query });
      },
      get(userId: string): Promise<RiskyUser> {
        return request({ method: 'GET', path: `/v1/risky_users/${enc(userId)}` });
      },
      dismiss(userId: string): Promise<RiskyUser> {
        return request({ method: 'POST', path: `/v1/risky_users/${enc(userId)}/dismiss`, body: {} });
      },
      confirm(userId: string): Promise<RiskyUser> {
        return request({ method: 'POST', path: `/v1/risky_users/${enc(userId)}/confirm`, body: {} });
      },
      remediate(userId: string): Promise<RiskyUser> {
        return request({ method: 'POST', path: `/v1/risky_users/${enc(userId)}/remediate`, body: {} });
      },
      forcePasswordChange(userId: string): Promise<{ object: 'risk_remediation'; user_id: string; action: string; sessions_revoked: number }> {
        return request({ method: 'POST', path: `/v1/risky_users/${enc(userId)}/force_password_change`, body: {} });
      },
      forceReauth(userId: string): Promise<{ object: 'risk_remediation'; user_id: string; action: string; sessions_revoked: number }> {
        return request({ method: 'POST', path: `/v1/risky_users/${enc(userId)}/force_reauth`, body: {} });
      },
    },
    containment: {
      /** Contain an account: sign-in disabled, password invalidated, sessions, tokens, keys and devices revoked. */
      contain(userId: string, body: { reason?: string } = {}): Promise<UserContainment> {
        return request({ method: 'POST', path: `/v1/users/${enc(userId)}/contain`, body });
      },
      release(userId: string): Promise<UserContainment> {
        return request({ method: 'POST', path: `/v1/users/${enc(userId)}/release`, body: {} });
      },
      list(query: { user_id?: string } = {}): Promise<ListPage<UserContainment>> {
        return request({ method: 'GET', path: `/v1/containments${query.user_id ? `?user_id=${enc(query.user_id)}` : ''}` });
      },
    },
    factorQuarantines: {
      list(query: { user_id?: string; active?: boolean } = {}): Promise<ListPage<MfaFactorQuarantine>> {
        return request({ method: 'GET', path: '/v1/mfa_factor_quarantines', query });
      },
      release(id: string): Promise<MfaFactorQuarantine> {
        return request({ method: 'POST', path: `/v1/mfa_factor_quarantines/${enc(id)}/release`, body: {} });
      },
    },
  };
}

/** Temporary access passes (`users.createTemporaryAccess`). */
export function temporaryAccessResource(request: RequestFn) {
  return {
    /** Issue a pass. The `code` is in this response only. */
    create(userId: string, body: CreateTemporaryAccessBody = {}): Promise<TemporaryAccessPass & { code: string }> {
      return request({ method: 'POST', path: `/v1/users/${enc(userId)}/temporary_access`, body });
    },
    list(userId: string): Promise<ListPage<TemporaryAccessPass>> {
      return request({ method: 'GET', path: `/v1/users/${enc(userId)}/temporary_access` });
    },
    revoke(userId: string, passId: string): Promise<{ object: 'temporary_access_pass'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/users/${enc(userId)}/temporary_access/${enc(passId)}` });
    },
  };
}

export interface EmailRiskResult {
  object: 'email_risk';
  verdict: 'allow' | 'review' | 'block';
  score: number;
  reasons: string[];
  email_domain: string;
  mode: string;
  checks: { syntax: boolean; disposable: boolean; role_account: boolean; mx: boolean | null; suppressed: boolean; mailbox: Record<string, unknown> | null };
}

export interface EmailRiskSettings {
  object: 'email_risk_settings';
  mode: 'off' | 'mx' | 'provider';
  provider: 'zerobounce' | 'kickbox' | null;
  has_credentials: boolean;
  block_disposable: boolean;
  block_suppressed: boolean;
  block_undeliverable: boolean;
  block_role: boolean;
  gate_sign_up: boolean;
  updated_at: number | null;
}

export interface EmailSuppression {
  object: 'email_suppression';
  id: string;
  email: string;
  reason: string;
  source: string;
  detail: string | null;
  created_at: number;
}

/** Email risk (`POST /v1/fraud/email_risk`) and the suppression list. */
export function emailRiskResource(request: RequestFn) {
  return {
    check(body: { email: string; ip?: string; verify_mailbox?: boolean }): Promise<EmailRiskResult> {
      return request({ method: 'POST', path: '/v1/fraud/email_risk', body });
    },
    settings(): Promise<EmailRiskSettings> {
      return request({ method: 'GET', path: '/v1/fraud/email_risk/settings' });
    },
    updateSettings(body: {
      mode?: 'off' | 'mx' | 'provider';
      provider?: 'zerobounce' | 'kickbox' | null;
      /** Write-only: `{ apiKey, region? }` for your own account, or null to clear. */
      credentials?: { apiKey: string; region?: 'us' | 'eu' } | null;
      block_disposable?: boolean;
      block_suppressed?: boolean;
      block_undeliverable?: boolean;
      block_role?: boolean;
      gate_sign_up?: boolean;
    }): Promise<EmailRiskSettings> {
      return request({ method: 'PUT', path: '/v1/fraud/email_risk/settings', body });
    },
    suppressions: {
      list(query: { email?: string; limit?: number; after?: string } = {}): Promise<ListPage<EmailSuppression>> {
        return request({ method: 'GET', path: '/v1/messaging/suppressions', query });
      },
      add(body: { email?: string; emails?: string[]; reason?: 'hard_bounce' | 'complaint' | 'unsubscribe' | 'manual' | 'invalid'; source?: string; detail?: string }): Promise<ListPage<EmailSuppression>> {
        return request({ method: 'POST', path: '/v1/messaging/suppressions', body });
      },
      remove(email: string): Promise<{ object: 'email_suppression'; email: string; deleted: true }> {
        return request({ method: 'DELETE', path: `/v1/messaging/suppressions/${enc(email)}` });
      },
    },
  };
}

export interface AuthenticatorPolicy {
  object: 'authenticator_policy';
  id: string;
  name: string;
  group: string;
  enabled: boolean;
  required_factors: Array<'totp' | 'sms' | 'passkey' | 'push'>;
  grace_until: number | null;
  passkey: { requireUserVerification?: boolean; attestation?: 'none' | 'indirect' | 'direct' | null; attachment?: 'any' | 'platform' | 'cross-platform' | null; allowlist?: string[]; blocklist?: string[] };
  created_at: number;
  updated_at: number;
}

export type AuthenticatorPolicyBody = Partial<Pick<AuthenticatorPolicy, 'name' | 'group' | 'enabled' | 'required_factors' | 'grace_until' | 'passkey'>>;

/** Group-targeted authenticator policies: required factors with an enrolment grace window and passkey profiles. */
export function authenticatorPoliciesResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<AuthenticatorPolicy>> {
      return request({ method: 'GET', path: '/v1/authenticator_policies' });
    },
    get(id: string): Promise<AuthenticatorPolicy> {
      return request({ method: 'GET', path: `/v1/authenticator_policies/${enc(id)}` });
    },
    create(body: AuthenticatorPolicyBody & { name: string; group: string }): Promise<AuthenticatorPolicy> {
      return request({ method: 'POST', path: '/v1/authenticator_policies', body });
    },
    update(id: string, body: AuthenticatorPolicyBody): Promise<AuthenticatorPolicy> {
      return request({ method: 'PATCH', path: `/v1/authenticator_policies/${enc(id)}`, body });
    },
    delete(id: string): Promise<{ object: 'authenticator_policy'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/authenticator_policies/${enc(id)}` });
    },
    /** The combined rules that apply to one user through their groups. */
    effective(userId: string): Promise<{ object: 'effective_authenticator_rules'; user_id: string; required_factors: string[]; in_grace: boolean; passkey: Record<string, unknown>; matched_policies: string[] }> {
      return request({ method: 'GET', path: `/v1/authenticator_policies/effective/${enc(userId)}` });
    },
  };
}
