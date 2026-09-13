import { enc, type RequestFn } from './request';
import type { CursorPage, CursorParams } from './types';

/**
 * §13.4 GDPR/DSAR admin surface — the Data Protection Officer's console over
 * data-subject requests. A user files export/erasure requests from the FAPI;
 * this lets an operator SEE every request and ACTION it out of band: fulfil it
 * now, ahead of its grace window, or reject it with a recorded reason. A
 * fulfilled or rejected request is terminal — a second action is a 409.
 */
export interface DataSubjectRequest {
  object: 'data_subject_request';
  id: string;
  type: string;
  status: string;
  user_id: string;
  requested_by_type: string | null;
  requested_by_id: string | null;
  reason: string | null;
  scheduled_for: number | null;
  requested_at: number;
  updated_at: number;
  completed_at: number | null;
  /** The export package — present on `get` and on a fulfilled export. */
  result?: unknown;
}

export interface ListDataSubjectRequestsParams extends CursorParams {
  type?: string;
  status?: string;
  user_id?: string;
}

export function dataSubjectRequestsResource(request: RequestFn) {
  return {
    list(
      params: ListDataSubjectRequestsParams = {},
    ): Promise<CursorPage<DataSubjectRequest>> {
      return request({ method: 'GET', path: '/v1/data_subject_requests', query: { ...params } });
    },
    get(id: string): Promise<DataSubjectRequest> {
      return request({ method: 'GET', path: `/v1/data_subject_requests/${enc(id)}` });
    },
    /** Fulfil a request now — build the export package, or run the erasure — ahead of schedule. */
    fulfill(id: string, idempotencyKey?: string): Promise<DataSubjectRequest> {
      return request({
        method: 'POST',
        path: `/v1/data_subject_requests/${enc(id)}/fulfill`,
        idempotencyKey,
      });
    },
    /** Reject a request with a recorded reason. Terminal — it cannot be re-actioned. */
    reject(
      id: string,
      body: { reason?: string } = {},
      idempotencyKey?: string,
    ): Promise<DataSubjectRequest> {
      return request({
        method: 'POST',
        path: `/v1/data_subject_requests/${enc(id)}/reject`,
        body,
        idempotencyKey,
      });
    },
  };
}
