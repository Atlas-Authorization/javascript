import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

export type LogStreamType = 'http' | 'datadog' | 'splunk';

/**
 * A log stream — the instance event feed forwarded to an external sink (generic
 * HTTP, Datadog, Splunk HEC), Auth0-style. Destination SECRETS (datadog api_key,
 * splunk token, http auth headers) are write-only: encrypted at rest and never
 * returned, so the `destination` here carries only non-secret fields plus `has_*`
 * markers.
 */
export interface LogStream {
  object: 'log_stream';
  id: string;
  name: string;
  type: LogStreamType;
  enabled: boolean;
  status: string;
  event_filter: string[] | null;
  /** Non-secret destination fields plus has_* markers; NEVER a secret value. */
  destination: Record<string, unknown>;
  cursor: string | null;
  consecutive_failures: number;
  last_error: string | null;
  last_delivered_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface CreateLogStreamBody {
  name: string;
  type: LogStreamType;
  /** Shape depends on `type`: http {url,headers?}, datadog {site,api_key}, splunk {hec_endpoint,token}. */
  destination: Record<string, unknown>;
  /** null (or omitted) forwards everything; an array of event-type prefixes filters. */
  event_filter?: string[] | null;
  enabled?: boolean;
}

/** PATCH accepts everything create does except `type`, which is immutable. */
export interface UpdateLogStreamBody {
  name?: string;
  /** Merged over the stored destination; a secret left out is kept. */
  destination?: Record<string, unknown>;
  event_filter?: string[] | null;
  enabled?: boolean;
  status?: 'active' | 'paused';
}

/** The tester's outcome: one synthetic event sent to the sink, its status reported. */
export interface LogStreamTestResult {
  object: 'log_stream_test_result';
  id: string;
  ok: boolean;
  status: number | null;
  error: string | null;
}

export function logStreamsResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<LogStream>> {
      return request({ method: 'GET', path: '/v1/log_streams' });
    },
    get(id: string): Promise<LogStream> {
      return request({ method: 'GET', path: `/v1/log_streams/${enc(id)}` });
    },
    create(body: CreateLogStreamBody, idempotencyKey?: string): Promise<LogStream> {
      return request({ method: 'POST', path: '/v1/log_streams', body, idempotencyKey });
    },
    update(id: string, body: UpdateLogStreamBody): Promise<LogStream> {
      return request({ method: 'PATCH', path: `/v1/log_streams/${enc(id)}`, body });
    },
    delete(id: string): Promise<{ object: 'log_stream'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/log_streams/${enc(id)}` });
    },
    /** Send ONE synthetic event with the real credentials; the cursor is never touched. */
    test(id: string): Promise<LogStreamTestResult> {
      return request({ method: 'POST', path: `/v1/log_streams/${enc(id)}/test` });
    },
  };
}
