import { type RequestFn } from './request';



export type AuditRetentionGetResult = Record<string, unknown>;

export type AuditRetentionSetBody = {
  retention_days?: number | null;
  confirm_deletion?: boolean;
};

export type AuditRetentionSetResult = Record<string, unknown>;

/** Operations on `/v1/audit_retention` (2). */
export function auditRetentionOpsResource(request: RequestFn) {
  return {
    /** How long the instance audit log is kept: the effective days, whether it is configured, and the allowed range (30 to 3,650; the default is 365). */
    get(): Promise<AuditRetentionGetResult> {
      return request({ method: 'GET', path: '/v1/audit_retention' });
    },
    /** Set audit log retention in days (`null` returns to the default). Entries older than the retention are deleted by an hourly sweep, so shortening it needs `confirm_deletion: true`. */
    set(body?: AuditRetentionSetBody): Promise<AuditRetentionSetResult> {
      return request({ method: 'PUT', path: '/v1/audit_retention', body });
    },
  };
}
