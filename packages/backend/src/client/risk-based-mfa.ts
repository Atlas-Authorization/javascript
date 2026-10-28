import { type RequestFn } from './request';

/** The risk level at or above which a sign-in is stepped up. */
export type RiskLevel = 'low' | 'medium' | 'high';

/** What to do at high risk when the user has NO enrolled factor. */
export type OnHighRiskNoFactor = 'allow' | 'block' | 'require_enroll';

/** `audit` scores and records every sign-in but never changes the outcome. */
export type RiskMode = 'enforce' | 'audit';

/** What a risk level does; `default` keeps the step-up threshold behaviour. */
export type RiskLevelAction = 'default' | 'allow' | 'notify' | 'mfa' | 'block';

export interface RiskLevelActions {
  medium: RiskLevelAction;
  high: RiskLevelAction;
}

/** Per-signal score weights that feed the risk total. */
export interface RiskWeights {
  newDevice: number;
  newSubnet: number;
  newIp: number;
  velocity: number;
  impossibleTravel: number;
  /** The account was idle past the dormant-account threshold before this sign-in. */
  dormantAccount?: number;
}

/** Per-signal on/off toggles. A disabled signal contributes nothing. */
export interface RiskSignalToggles {
  newDevice: boolean;
  newSubnet: boolean;
  newIp: boolean;
  velocity: boolean;
  impossibleTravel: boolean;
  dormantAccount?: boolean;
}

/**
 * Adaptive / risk-based MFA config (Auth0 "Adaptive MFA" parity). OFF by
 * default and can only ever ADD friction — nothing here can weaken the sign-in
 * gate.
 */
export interface RiskBasedMfa {
  object: 'risk_based_mfa';
  enabled: boolean;
  step_up_threshold: RiskLevel;
  on_high_risk_no_factor: OnHighRiskNoFactor;
  weights: RiskWeights;
  signals: RiskSignalToggles;
  mode: RiskMode;
  level_actions: RiskLevelActions;
  reputation: RiskReputation;
  fraud: FraudConfig;
  /** Per-user baseline: unusual sign-in hour or never-seen country adds `weight` points each. */
  baseline: { enabled: boolean; weight: number };
  /** Re-evaluate a session when it refreshes from a different network. */
  mid_session: { enabled: boolean; action: 'revoke' | 'notify' | 'audit' };
}

export type FraudAction = 'allow' | 'challenge' | 'block';

export interface FraudRule {
  id: string;
  name: string;
  enabled: boolean;
  action: FraudAction;
  /** Reason code returned when the rule matches. */
  reason: string;
  /** All conditions must hold. */
  conditions: Array<{
    field: 'country' | 'asn' | 'datacenter' | 'anonymizer' | 'headless' | 'automation' | 'client_class' | 'bot_score' | 'email_disposable' | 'ip_velocity' | 'device_velocity' | 'email_velocity';
    op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin';
    value: string | number | boolean | Array<string | number>;
  }>;
}

export interface FraudConfig {
  /** Two-letter country codes that are always blocked. */
  sanctioned_countries: string[];
  rules: FraudRule[];
  /** Cap on lookups per device per hour; adaptive halves it for bot-like, datacenter or anonymized clients. */
  device_rate_limit?: { enabled: boolean; per_hour: number; adaptive: boolean };
}

export interface FraudLookupBody {
  ip: string;
  user_agent?: string;
  /** The stable id from the JS SDK. */
  device_id?: string;
  email?: string;
  /** A user of this instance, for user_age_days / user_mfa_enabled / user_banned rules. */
  user_id?: string;
  /** The organization the action is for, for org_id rules. */
  org_id?: string;
  /** Device features reported by the SDK (see the telemetry beacon). */
  device?: Record<string, unknown>;
}

export interface FraudLookup {
  object: 'fraud_lookup';
  verdict: FraudAction;
  reasons: string[];
  matched_rules: string[];
  device_id: string | null;
  signals: Record<string, string | number | boolean | null>;
}

/** External IP-reputation / email-risk feeds (bring your own provider key). */
export interface RiskReputation {
  provider: 'none' | 'ipqs' | 'spur' | 'minfraud';
  /** Score points added when the IP is flagged. */
  ip_weight: number;
  /** Provider fraud score (1-100) at or above which the IP is flagged. */
  min_score: number;
  flag_anonymizers: boolean;
  email_checks: boolean;
  email_weight: number;
}

export interface UpdateRiskBasedMfaBody {
  enabled?: boolean;
  step_up_threshold?: RiskLevel;
  on_high_risk_no_factor?: OnHighRiskNoFactor;
  weights?: Partial<RiskWeights>;
  signals?: Partial<RiskSignalToggles>;
  mode?: RiskMode;
  level_actions?: Partial<RiskLevelActions>;
  reputation?: Partial<RiskReputation>;
  fraud?: Partial<FraudConfig>;
  baseline?: Partial<RiskBasedMfa['baseline']>;
  mid_session?: Partial<RiskBasedMfa['mid_session']>;
}

/** One risk-scored sign-in on the audit / shadow-mode timeline. */
export interface RiskEvent {
  object: 'risk_event';
  id: string;
  user_id: string;
  level: RiskLevel;
  score: number;
  /** Names of the signals that fired. */
  signals: string[];
  /** The action decided; in audit mode, what WOULD have happened. */
  action: string;
  mode: RiskMode;
  ip: string | null;
  feedback: 'legit' | 'fraud' | null;
  feedback_at: string | null;
  created_at: string;
}

export interface RiskEventMetrics {
  object: 'risk_event_metrics';
  days: number;
  total: number;
  buckets: Array<{ level: string; action: string; mode: string; count: number }>;
}

/**
 * Read and tune the instance's adaptive-MFA engine — when a second factor is
 * demanded, and how each risk signal is weighted.
 */
export function riskBasedMfaResource(request: RequestFn) {
  return {
    /** Read the current adaptive-MFA config. */
    get(): Promise<RiskBasedMfa> {
      return request({ method: 'GET', path: '/v1/risk_based_mfa' });
    },
    /** Change any subset of the config; omitted fields are left unchanged. */
    update(body: UpdateRiskBasedMfaBody): Promise<RiskBasedMfa> {
      return request({ method: 'PATCH', path: '/v1/risk_based_mfa', body });
    },
    /** Fraud decision (allow / challenge / block with reason codes) for a sign-up, sign-in or checkout. */
    fraudLookup(body: FraudLookupBody): Promise<FraudLookup> {
      return request({ method: 'POST', path: '/v1/fraud/lookup', body });
    },
    /** Store the reputation provider's API key (write-only; minfraud: "<account id>:<license key>"). */
    setReputationSecret(secret: string, provider?: 'ipqs' | 'spur' | 'minfraud'): Promise<{ object: 'risk_reputation_secret'; provider: string; set: true }> {
      return request({ method: 'PUT', path: '/v1/risk_based_mfa/reputation_secret', body: { secret, provider } });
    },
    /** Remove a stored reputation provider key (default: the configured provider). */
    removeReputationSecret(provider?: 'ipqs' | 'spur' | 'minfraud'): Promise<{ object: 'risk_reputation_secret'; provider: string; deleted: true }> {
      return request({ method: 'DELETE', path: '/v1/risk_based_mfa/reputation_secret', query: { provider } });
    },
  };
}

/** The risk-event timeline, metrics and feedback. */
export function riskEventsResource(request: RequestFn) {
  return {
    /** Newest first. Page with `before` (the created_at of the last row). */
    list(query: { user_id?: string; level?: RiskLevel; limit?: number; before?: string } = {}): Promise<{ object: 'list'; data: RiskEvent[] }> {
      return request({ method: 'GET', path: '/v1/risk_events', query });
    },
    /** Counts per level / action / mode over the last `days`. */
    metrics(query: { days?: number } = {}): Promise<RiskEventMetrics> {
      return request({ method: 'GET', path: '/v1/risk_events/metrics', query });
    },
    /** Mark a scored sign-in `legit` or `fraud`; the fired signals' weights move accordingly. */
    feedback(id: string, verdict: 'legit' | 'fraud'): Promise<RiskEvent> {
      return request({ method: 'POST', path: `/v1/risk_events/${encodeURIComponent(id)}/feedback`, body: { verdict } });
    },
  };
}
