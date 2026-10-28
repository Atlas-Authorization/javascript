import { type RequestFn } from './request';

export type LeastPrivilegeSubjectType = 'api_key' | 'oauth_client' | 'mcp_gateway' | 'agent';

export interface LeastPrivilegePermission {
  /** A scope, `tool:<name>`, `<kind>:<resource>` for an agent grant, or `default_policy:allow`. */
  permission: string;
  kind: 'scope' | 'tool' | 'grant' | 'default_policy' | 'wildcard';
  detail?: string;
}

export interface LeastPrivilegeChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface LeastPrivilegeSubject {
  object: 'least_privilege_subject';
  subject_type: LeastPrivilegeSubjectType;
  subject_id: string;
  name: string | null;
  window_days: number;
  /** How many of the window's days the usage data covers. */
  observed_days: number;
  /** `low` when the data covers less than the window. */
  confidence: 'high' | 'low';
  granted: LeastPrivilegePermission[];
  used: Array<{ permission: string; uses: number; last_used_at: number }>;
  unused: Array<LeastPrivilegePermission & { last_used_at: null }>;
  /** The narrower grant. It only ever removes permissions. */
  suggestion: { summary: string; changes: LeastPrivilegeChange[]; digest: string } | null;
  /** The suggestion can be applied with one call. */
  applicable: boolean;
  note?: string;
}

export interface LeastPrivilegeReport {
  object: 'least_privilege_report';
  generated_at: number;
  window_days: number;
  summary: { subjects: number; with_unused: number; unused_permissions: number; applicable_suggestions: number };
  data: LeastPrivilegeSubject[];
}

export interface LeastPrivilegeReportQuery {
  days?: number;
  subject_type?: LeastPrivilegeSubjectType;
  subject_id?: string;
  only_unused?: boolean;
  limit?: number;
}

export interface ApplyLeastPrivilegeBody {
  subject_type: LeastPrivilegeSubjectType;
  subject_id: string;
  /** `suggestion.digest` from the report: what you previewed is what is applied. */
  digest: string;
  days?: number;
  /** Required when the report's `confidence` is `low`. */
  acknowledge_short_window?: boolean;
}

/**
 * The least-privilege report: what each secret key, OAuth client, MCP gateway and
 * agent holds against what it used, and the narrower grant that would cover it.
 * Preview an `apply` with `dryRun` first.
 */
export function leastPrivilegeResource(request: RequestFn) {
  return {
    report(query: LeastPrivilegeReportQuery = {}): Promise<LeastPrivilegeReport> {
      return request({ method: 'GET', path: '/v1/least_privilege/report', query: { ...query } });
    },
    /** One credential's report. */
    get(type: LeastPrivilegeSubjectType, id: string, query: { days?: number } = {}): Promise<LeastPrivilegeSubject> {
      return request({ method: 'GET', path: `/v1/least_privilege/report/${type}/${encodeURIComponent(id)}`, query: { ...query } });
    },
    /** The report as CSV, one row per used or unused permission. */
    exportCsv(query: LeastPrivilegeReportQuery = {}): Promise<string> {
      return request({ method: 'GET', path: '/v1/least_privilege/report', query: { ...query, format: 'csv' }, raw: true });
    },
    /** Apply a suggestion. `dryRun: true` previews it without changing anything. */
    apply(body: ApplyLeastPrivilegeBody, options: { dryRun?: boolean } = {}): Promise<{
      object: 'least_privilege_change';
      subject_type: LeastPrivilegeSubjectType;
      subject_id: string;
      applied: true;
      summary: string;
      changes: LeastPrivilegeChange[];
    }> {
      return request({ method: 'POST', path: '/v1/least_privilege/apply', body, ...(options.dryRun ? { query: { dry_run: true } } : {}) });
    },
  };
}
