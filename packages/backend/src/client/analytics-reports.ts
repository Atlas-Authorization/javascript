import { enc, type RequestFn } from './request';
import type { DeletedObject } from './types';

/** The window every analytics read takes: `from`/`to` (epoch ms or ISO 8601) or `days`, at most 180. */
export interface AnalyticsParams {
  from?: number | string;
  to?: number | string;
  days?: number;
  granularity?: 'day' | 'week' | 'month';
  /** Only members of this organization (not available for failures). */
  organization_id?: string;
}

export interface AnalyticsReport<Row> {
  object: string;
  window: { from: number; to: number; granularity: string; organization_id: string | null };
  data: Row[];
  [meta: string]: unknown;
}

export interface FunnelRow {
  method: string;
  started: number;
  completed: number;
  abandoned: number;
  in_progress: number;
  needs_first_factor: number;
  needs_second_factor: number;
  needs_email_verification: number;
  completion_rate: number;
}
export interface JourneyFunnelRow { step: string; held: number; completed: number; applied: number; denied: number; completion_rate: number }
export interface FailureRow { phase: string; reason: string; method: string; count: number; share: number }
export interface BreakdownRow { value: string; count: number; share: number }
export interface ActiveUsersRow { bucket: string; active_users: number; new_users: number; returning_users: number; sign_ins: number }
export interface PasskeyAdoptionRow { bucket: string; passkey_sign_ins: number; sign_ins: number; passkey_share: number }
export interface InactiveUserRow { user_id: string; email: string | null; last_sign_in_at: string | null; created_at: string }
export interface MfaCoverageRow { protection: string; users: number; share: number }
export interface AccessByAppRow { client_id: string; name: string; users: number; active_grants: number; users_in_window: number }

export type AlertMetric = 'sign_in_success_rate' | 'failed_passkey_ratio' | 'failed_sign_ins' | 'sign_in_p95_seconds' | 'api_usage_spike' | 'unused_permissions';

export type UsageSubjectType = 'api_key' | 'end_user_api_key' | 'organization';

/** One key's or organization's API usage against its 7-day hourly baseline. */
export interface ApiUsageSubject {
  type: UsageSubjectType;
  id: string;
  current: number;
  current_per_hour: number;
  baseline_per_hour: number;
  /** current_per_hour / baseline_per_hour (the baseline is floored at 1 request an hour). */
  ratio: number;
  error_rate: number;
}

export interface AnalyticsAlertRule {
  object: 'analytics_alert_rule';
  id: string;
  name: string;
  metric: AlertMetric;
  comparator: 'lt' | 'gt';
  threshold: number;
  window_minutes: number;
  min_sample: number;
  cooldown_minutes: number;
  email_contacts: string[];
  webhook_url: string | null;
  has_webhook_secret: boolean;
  enabled: boolean;
  subject_type: UsageSubjectType | null;
  subject_id: string | null;
  ssf: boolean;
  state: 'ok' | 'firing';
  last_value: number | null;
  last_evaluated_at: number | null;
  last_triggered_at: number | null;
  last_error: string | null;
  created_at: number;
}

export interface AnalyticsAlertRuleInput {
  name: string;
  metric: AlertMetric;
  comparator: 'lt' | 'gt';
  threshold: number;
  /** 5 to 1440 (default 60). */
  window_minutes?: number;
  /** Ratios and latency are not evaluated on fewer observations (default 20). */
  min_sample?: number;
  /** Minutes between notifications while the rule stays firing (default 60). */
  cooldown_minutes?: number;
  email_contacts?: string[];
  /** A public HTTPS endpoint; the body is signed like any Atlas webhook. */
  webhook_url?: string | null;
  enabled?: boolean;
  /** api_usage_spike: which kind of subject to watch (null = all). */
  subject_type?: UsageSubjectType | null;
  /** api_usage_spike: one key or organization (needs subject_type). */
  subject_id?: string | null;
  /** Also raise a Shared Signals event when the rule fires. */
  ssf?: boolean;
}

export function analyticsResource(request: RequestFn) {
  const read = <Row>(path: string, params: object): Promise<AnalyticsReport<Row>> =>
    request({ method: 'GET', path, query: { ...params } });
  const csv = (path: string, params: object): Promise<string> =>
    request({ method: 'GET', path, query: { ...params, format: 'csv' }, raw: true });
  return {
    /** Where sign-in (or sign-up) attempts end, per method. */
    funnel: (params: AnalyticsParams & { kind?: 'sign_in' | 'sign_up' } = {}) => read<FunnelRow>('/v1/analytics/funnel', params),
    /** What happened at each step of a sign-in journey. */
    journeyFunnel: (params: Omit<AnalyticsParams, 'organization_id'> & { journey_id: string }) => read<JourneyFunnelRow>('/v1/analytics/journey_funnel', params),
    /** Failed attempts by reason and method. */
    failures: (params: Omit<AnalyticsParams, 'organization_id'> = {}) => read<FailureRow>('/v1/analytics/failures', params),
    /** Sign-ins by method, device, browser, os or country. */
    breakdown: (params: AnalyticsParams & { dimension?: 'method' | 'device' | 'browser' | 'os' | 'country' } = {}) =>
      read<BreakdownRow>('/v1/analytics/breakdown', params),
    /** DAU/WAU/MAU and a series, with new vs returning users. */
    activeUsers: (params: AnalyticsParams = {}) => read<ActiveUsersRow>('/v1/analytics/active_users', params),
    passkeyAdoption: (params: AnalyticsParams = {}) => read<PasskeyAdoptionRow>('/v1/analytics/passkey_adoption', params),
    /** API usage per secret key, end-user API key or organization against its own baseline, highest ratio first. */
    apiUsage: (params: { subject_type?: UsageSubjectType; subject_id?: string; window_minutes?: number } = {}): Promise<{
      object: 'api_usage';
      window_minutes: number;
      baseline_hours: number;
      generated_at: number;
      data: ApiUsageSubject[];
    }> => request({ method: 'GET', path: '/v1/analytics/api_usage', query: { ...params } }),
    reports: {
      inactiveUsers: (params: AnalyticsParams & { inactive_days?: number; limit?: number; starting_after?: string } = {}) =>
        read<InactiveUserRow>('/v1/analytics/reports/inactive_users', params),
      mfaCoverage: (params: AnalyticsParams = {}) => read<MfaCoverageRow>('/v1/analytics/reports/mfa_coverage', params),
      accessByApp: (params: AnalyticsParams = {}) => read<AccessByAppRow>('/v1/analytics/reports/access_by_app', params),
    },
    /**
     * Any analytics read as CSV text, e.g. `exportCsv('breakdown', { dimension: 'country' })`.
     * For Parquet call the same path with `format=parquet` over HTTP (a binary body).
     */
    exportCsv: (report: 'funnel' | 'failures' | 'breakdown' | 'active_users' | 'passkey_adoption' | 'reports/inactive_users' | 'reports/mfa_coverage' | 'reports/access_by_app', params: object = {}) =>
      csv(`/v1/analytics/${report}`, params),
    alertRules: {
      list(): Promise<{ object: 'list'; data: AnalyticsAlertRule[]; has_more: boolean }> {
        return request({ method: 'GET', path: '/v1/analytics/alert_rules' });
      },
      get(id: string): Promise<AnalyticsAlertRule> {
        return request({ method: 'GET', path: `/v1/analytics/alert_rules/${enc(id)}` });
      },
      /** A webhook rule's `webhook_secret` is in this response only. */
      create(body: AnalyticsAlertRuleInput, idempotencyKey?: string): Promise<AnalyticsAlertRule & { webhook_secret?: string }> {
        return request({ method: 'POST', path: '/v1/analytics/alert_rules', body, idempotencyKey });
      },
      update(id: string, body: Partial<AnalyticsAlertRuleInput>): Promise<AnalyticsAlertRule & { webhook_secret?: string }> {
        return request({ method: 'PATCH', path: `/v1/analytics/alert_rules/${enc(id)}`, body });
      },
      delete(id: string): Promise<DeletedObject> {
        return request({ method: 'DELETE', path: `/v1/analytics/alert_rules/${enc(id)}` });
      },
      /** Measure now; `notify: true` also sends the rule's email and webhook. */
      test(id: string, body: { notify?: boolean } = {}): Promise<{ object: 'analytics_alert_test'; value: number | null; sample: number; subject: ApiUsageSubject | null; notified: boolean; error: string | null }> {
        return request({ method: 'POST', path: `/v1/analytics/alert_rules/${enc(id)}/test`, body });
      },
    },
  };
}
