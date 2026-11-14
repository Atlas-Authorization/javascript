import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

export type RiskSignalSeverityName = 'low' | 'medium' | 'high' | 'critical';

export interface RiskSignal {
  object: 'risk_signal';
  id: string;
  subject: { type: 'user' | 'ip'; value: string };
  signal_type: string;
  severity: RiskSignalSeverityName;
  source: string;
  metadata: Record<string, unknown>;
  expires_at: number;
  revoked_at: number | null;
  status: 'active' | 'expired' | 'revoked';
  created_at: number;
}

/** Exactly one of `user_id`, `email` (a verified address) or `ip`. */
export type RiskSignalInput = {
  signal_type: string;
  severity: RiskSignalSeverityName;
  /** 60 to 2592000, default 3600. */
  ttl_seconds?: number;
  /** Up to 2 KB, kept private. */
  metadata?: Record<string, unknown>;
  source?: string;
} & ({ user_id: string } | { email: string } | { ip: string });

export interface RiskReplayVerdict {
  level: 'low' | 'medium' | 'high';
  score: number;
  action: 'none' | 'notify' | 'require_second_factor' | 'require_enroll' | 'block';
  signals: string[];
}

export interface RiskReplayOutcome {
  levels: { low: number; medium: number; high: number };
  actions: Record<string, number>;
}

export interface RiskReplay {
  object: 'risk_replay';
  window: { since: number; until: number; days: number };
  truncated: boolean;
  sign_ins: number;
  users: number;
  current: RiskReplayOutcome;
  candidate: RiskReplayOutcome;
  /** Sign-ins whose action differs. */
  changed: number;
  adds_friction: number;
  removes_friction: number;
  samples: Array<{ user_id: string; at: number; ip: string | null; current: RiskReplayVerdict; candidate: RiskReplayVerdict }>;
  notes: string[];
}

export interface RiskReplayInput {
  /** 1 to 30, default 7. */
  days?: number;
  user_id?: string;
  /** The most recent sign-ins to score, default 5000. */
  limit?: number;
  /** Risk-policy fields to try (as in `PATCH /v1/risk_based_mfa`); the rest stay as they are. */
  candidate?: {
    step_up_threshold?: 'low' | 'medium' | 'high';
    on_high_risk_no_factor?: 'allow' | 'block' | 'require_enroll';
    weights?: Record<string, number>;
    signals?: Record<string, boolean>;
    level_actions?: { medium?: string; high?: string };
    baseline?: { enabled?: boolean; weight?: number };
  };
}

/** Bring-your-own risk signals (`/v1/risk_signals`) and the risk-policy what-if replay. */
export function riskSignalsResource(request: RequestFn) {
  return {
    /** Report a signal. While live it adds points to risk evaluations of that user or IP; it never lowers friction. */
    create(body: RiskSignalInput, options: { idempotencyKey?: string } = {}): Promise<RiskSignal> {
      return request({ method: 'POST', path: '/v1/risk_signals', body, idempotencyKey: options.idempotencyKey });
    },
    list(query: { user_id?: string; ip?: string; status?: 'active' | 'all'; limit?: number; before?: string } = {}): Promise<ListPage<RiskSignal>> {
      return request({ method: 'GET', path: '/v1/risk_signals', query });
    },
    get(id: string): Promise<RiskSignal> {
      return request({ method: 'GET', path: `/v1/risk_signals/${enc(id)}` });
    },
    /** End a signal now. */
    revoke(id: string): Promise<RiskSignal> {
      return request({ method: 'DELETE', path: `/v1/risk_signals/${enc(id)}` });
    },
    /** What would a different risk policy have done to recent sign-ins? Changes nothing. */
    replay(body: RiskReplayInput = {}): Promise<RiskReplay> {
      return request({ method: 'POST', path: '/v1/risk_based_mfa/replay', body });
    },
  };
}
