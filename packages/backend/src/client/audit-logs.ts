import type { RequestFn } from './request';
import type { CursorPage, CursorParams } from './types';

export interface AuditLog {
  object: 'audit_log';
  id: string;
  /** Who acted; `key_name` names the secret or platform key when a key did. */
  actor?: { type: string; id: string | null; key_name: string | null; key_prefix: string | null };
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: number;
}

export interface ListAuditLogsParams extends CursorParams {
  actor_id?: string;
  action?: string;
}

export function auditLogsResource(request: RequestFn) {
  return {
    list(params: ListAuditLogsParams = {}): Promise<CursorPage<AuditLog>> {
      return request({ method: 'GET', path: '/v1/audit_logs', query: { ...params } });
    },
  };
}
