import { enc, type RequestFn } from './request';



export type SsfGetStreamStatusResult = {
  object: 'ssf_stream_status';
  [key: string]: unknown;
};

export type SsfUpdateStreamStatusBody = {
  status?: 'enabled' | 'paused' | 'disabled';
};

export type SsfUpdateStreamStatusResult = {
  object: 'ssf_stream_status';
  [key: string]: unknown;
};

export type SsfVerifyBody = {
  stream_id?: string;
  state?: string;
};

export interface SsfGetStatusQuery {
  /** The stream whose status to read. */
  stream_id?: string;
}

export type SsfGetStatusResult = {
  stream_id: string;
  status: 'enabled' | 'paused' | 'disabled';
};

export type SsfUpdateStatusBody = {
  stream_id?: string;
  status?: 'enabled' | 'paused' | 'disabled';
  reason?: string;
};

/** Operations on `/v1/ssf` (5). */
export function ssfOpsResource(request: RequestFn) {
  return {
    /** The stream's delivery status: enabled, paused or disabled (SSF stream status). */
    getStreamStatus(id: string): Promise<SsfGetStreamStatusResult> {
      return request({ method: 'GET', path: `/v1/ssf/streams/${enc(id)}/status` });
    },
    /** Set the stream's delivery status to enabled, paused or disabled. A paused stream collects nothing. */
    updateStreamStatus(id: string, body?: SsfUpdateStreamStatusBody, idempotencyKey?: string): Promise<SsfUpdateStreamStatusResult> {
      return request({ method: 'POST', path: `/v1/ssf/streams/${enc(id)}/status`, body, idempotencyKey });
    },
    /** SSF 1.0 verification endpoint: queue a verification event carrying `state` for the stream named by `stream_id`. 204. */
    verify(body?: SsfVerifyBody, idempotencyKey?: string): Promise<void> {
      return request({ method: 'POST', path: '/v1/ssf/verify', body, idempotencyKey });
    },
    /** SSF 1.0 stream status endpoint: the status (enabled, paused, disabled) of the stream named by the `stream_id` query parameter. */
    getStatus(query?: SsfGetStatusQuery): Promise<SsfGetStatusResult> {
      return request({ method: 'GET', path: '/v1/ssf/status', query: { ...query } });
    },
    /** SSF 1.0 stream status endpoint: set the status of the stream named by `stream_id`. */
    updateStatus(body?: SsfUpdateStatusBody, idempotencyKey?: string): Promise<void> {
      return request({ method: 'POST', path: '/v1/ssf/status', body, idempotencyKey });
    },
  };
}
