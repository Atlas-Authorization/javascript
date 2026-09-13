import { type RequestFn } from './request';

/** The risk level at or above which a sign-in is stepped up. */
export type RiskLevel = 'low' | 'medium' | 'high';

/** What to do at high risk when the user has NO enrolled factor. */
export type OnHighRiskNoFactor = 'allow' | 'block' | 'require_enroll';

/** Per-signal score weights that feed the risk total. */
export interface RiskWeights {
  newDevice: number;
  newSubnet: number;
  newIp: number;
  velocity: number;
  impossibleTravel: number;
}

/** Per-signal on/off toggles. A disabled signal contributes nothing. */
export interface RiskSignalToggles {
  newDevice: boolean;
  newSubnet: boolean;
  newIp: boolean;
  velocity: boolean;
  impossibleTravel: boolean;
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
}

export interface UpdateRiskBasedMfaBody {
  enabled?: boolean;
  step_up_threshold?: RiskLevel;
  on_high_risk_no_factor?: OnHighRiskNoFactor;
  weights?: Partial<RiskWeights>;
  signals?: Partial<RiskSignalToggles>;
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
  };
}
