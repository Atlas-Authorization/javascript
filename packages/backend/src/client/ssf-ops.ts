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

export interface SsfMetadata {
  issuer?: string;
  delivery_methods_supported?: string[];
  configuration_endpoint?: string;
  status_endpoint?: string;
  verification_endpoint?: string;
}

export interface SsfConfigurationBody {
  iss?: string;
  aud?: string;
  events_supported?: string[];
  events_delivered?: string[];
  min_verification_interval?: number;
  /** Events the receiver asks for. */
  events_requested?: string[];
  /** `method` is poll by default (the transmitter assigns the endpoint); push needs an https `endpoint_url`. */
  delivery?: { method?: string; endpoint_url?: string };
  description?: string;
}

export interface SsfUpdateConfigurationBody extends Omit<SsfConfigurationBody, 'delivery'> {
  stream_id: string;
  delivery?: Record<string, unknown>;
}

export type SsfStreamConfiguration = Record<string, unknown>;

export interface SsfCreatedConfiguration {
  stream_id?: string;
  iss?: string;
  aud?: string;
  events_supported?: string[];
  events_delivered?: string[];
  delivery?: Record<string, unknown>;
}

export interface SsfAddSubjectBody {
  stream_id: string;
  subject: Record<string, unknown>;
  verified?: boolean;
}

export interface SsfPollBody {
  /** Ids of the SETs received so far. */
  ack?: string[];
  /** Per-id errors for SETs that could not be processed. */
  setErrs?: Record<string, unknown>;
  maxEvents?: number;
  returnImmediately?: boolean;
}

export interface SsfPollResult {
  sets?: Record<string, unknown>;
  moreAvailable?: boolean;
}

/** Operations on `/v1/ssf` (15). */
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
    /** SSF transmitter configuration metadata: issuer, supported delivery methods and the management endpoints. */
    getMetadata(): Promise<SsfMetadata> {
      return request({ method: 'GET', path: '/v1/ssf/metadata' });
    },
    /** Create an event stream (SSF 1.0 8.1.1.1). One stream per receiver; a second is a 409. */
    createConfiguration(body?: SsfConfigurationBody, idempotencyKey?: string): Promise<SsfCreatedConfiguration> {
      return request({ method: 'POST', path: '/v1/ssf/configuration', body, idempotencyKey });
    },
    /** Read one stream (`stream_id`) or all of the receiver's streams. Another receiver's stream is a 404. */
    getConfiguration(query?: { stream_id?: string }): Promise<SsfStreamConfiguration> {
      return request({ method: 'GET', path: '/v1/ssf/configuration', query: { ...query } });
    },
    /** Update a stream: only the members present change; the delivery method cannot change. */
    updateConfiguration(body: SsfUpdateConfigurationBody, idempotencyKey?: string): Promise<SsfStreamConfiguration> {
      return request({ method: 'PATCH', path: '/v1/ssf/configuration', body, idempotencyKey });
    },
    /** Replace a stream: a receiver-supplied member left out is deleted. */
    replaceConfiguration(body: SsfUpdateConfigurationBody, idempotencyKey?: string): Promise<SsfStreamConfiguration> {
      return request({ method: 'PUT', path: '/v1/ssf/configuration', body, idempotencyKey });
    },
    /** Delete a stream. 204. */
    deleteConfiguration(query: { stream_id: string }, idempotencyKey?: string): Promise<void> {
      return request({ method: 'DELETE', path: '/v1/ssf/configuration', query, body: {}, idempotencyKey });
    },
    /** Add a subject to a stream (SSF 1.0 8.1.3.2). */
    addSubject(body: SsfAddSubjectBody, idempotencyKey?: string): Promise<Record<string, unknown>> {
      return request({ method: 'POST', path: '/v1/ssf/add_subject', body, idempotencyKey });
    },
    /** Remove a subject from a stream (SSF 1.0 8.1.3.3). An unknown subject is ignored. 204. */
    removeSubject(body: { stream_id: string; subject: Record<string, unknown> }, idempotencyKey?: string): Promise<void> {
      return request({ method: 'POST', path: '/v1/ssf/remove_subject', body, idempotencyKey });
    },
    /** Request a verification event (SSF 1.0 8.1.4.2): a signed event carrying the optional `state` is delivered on the stream. 204. */
    requestVerification(body: { stream_id: string; state?: string }, idempotencyKey?: string): Promise<void> {
      return request({ method: 'POST', path: '/v1/ssf/verification', body, idempotencyKey });
    },
    /** Poll a stream (RFC 8936): acknowledge with `ack`, report invalid events with `setErrs`, receive up to `maxEvents` unacknowledged ones. */
    pollStream(id: string, body?: SsfPollBody, idempotencyKey?: string): Promise<SsfPollResult> {
      return request({ method: 'POST', path: `/v1/ssf/streams/${enc(id)}/poll`, body, idempotencyKey });
    },
  };
}
