import { type RequestFn } from './request';

/** Event type URIs (CAEP + RISC) a stream can subscribe to. */
export type SsfEventType =
  | 'https://schemas.openid.net/secevent/caep/event-type/session-revoked'
  | 'https://schemas.openid.net/secevent/caep/event-type/credential-change'
  | 'https://schemas.openid.net/secevent/caep/event-type/assurance-level-change'
  | 'https://schemas.openid.net/secevent/caep/event-type/token-claims-change'
  | 'https://schemas.openid.net/secevent/caep/event-type/risk-level-change'
  | 'https://schemas.openid.net/secevent/risc/event-type/account-disabled'
  | 'https://schemas.openid.net/secevent/risc/event-type/account-enabled'
  | 'https://schemas.openid.net/secevent/risc/event-type/account-purged'
  | 'https://schemas.openid.net/secevent/risc/event-type/credential-compromise';

export interface SsfStream {
  object: 'ssf_stream';
  id: string;
  default_subjects?: 'ALL' | 'NONE';
  description: string | null;
  delivery: { method: string; endpoint_url?: string | null };
  delivery_method: 'push' | 'poll';
  audience: string;
  events_requested: string[];
  events_supported: string[];
  status: 'enabled' | 'paused' | 'disabled';
  created_at: number;
  updated_at: number;
  pending_events?: number;
}

/** Returned once on create for a poll stream. */
export interface SsfStreamCreated extends SsfStream {
  poll_token?: string;
  poll_endpoint?: string;
}

export interface CreateSsfStreamBody {
  delivery_method: 'push' | 'poll';
  /** Push only: the https endpoint that receives each SET. */
  endpoint_url?: string;
  /** Push only: sent as the `Authorization` header (write-only). */
  authorization_header?: string;
  audience?: string;
  description?: string;
  events_requested?: string[];
  default_subjects?: 'ALL' | 'NONE';
}

export interface UpdateSsfStreamBody {
  endpoint_url?: string;
  authorization_header?: string;
  description?: string;
  events_requested?: string[];
  status?: 'enabled' | 'paused' | 'disabled';
}

export interface SsfEventRecord {
  object: 'ssf_event';
  id: string;
  event_type: string;
  user_id: string | null;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  last_error: string | null;
  delivered_at: number | null;
  created_at: number;
}

/** `sync_posture` (device-compliance-change only) records the device's compliance in Atlas device posture and nothing else. */
export type SsfReceiverAction = 'revoke_sessions' | 'refresh_claims' | 'ban' | 'sync_posture' | 'ignore';

export interface SsfReceiver {
  object: 'ssf_receiver';
  id: string;
  name: string;
  issuer: string;
  jwks_uri: string;
  audience: string | null;
  actions: Record<string, SsfReceiverAction>;
  enabled: boolean;
  last_received_at: number | null;
  created_at: number;
  /** Only on create. */
  receive_endpoint?: string;
}

export interface CreateSsfReceiverBody {
  name: string;
  issuer: string;
  jwks_uri: string;
  audience?: string;
  actions?: Record<string, SsfReceiverAction>;
}

/** Shared Signals Framework (SSF 1.0) with CAEP and RISC: transmitter streams and inbound receivers. */
export function ssfResource(request: RequestFn) {
  const stream = (id: string) => `/v1/ssf/streams/${encodeURIComponent(id)}`;
  const receiver = (id: string) => `/v1/ssf/receivers/${encodeURIComponent(id)}`;
  return {
    subjects: {
      /** Add a subject to a stream (iss_sub, email, phone_number, opaque, account, did or uri identifier). */
      add(streamId: string, subject: Record<string, string>): Promise<void> {
        return request({ method: 'POST', path: '/v1/ssf/subjects/add', body: { stream_id: streamId, subject } });
      },
      remove(streamId: string, subject: Record<string, string>): Promise<void> {
        return request({ method: 'POST', path: '/v1/ssf/subjects/remove', body: { stream_id: streamId, subject } });
      },
    },
    /** Raise a CAEP / RISC event for one of your users by hand (opt-in, opt-out-*, identifier-recycled, recovery-* ...). */
    emit(body: { user_id: string; event: string; subject?: Record<string, string>; data?: Record<string, unknown> }): Promise<{ object: 'ssf_event_emit'; event: string; user_id: string }> {
      return request({ method: 'POST', path: '/v1/ssf/events', body });
    },
    streams: {
      list(): Promise<{ object: 'list'; data: SsfStream[] }> {
        return request({ method: 'GET', path: '/v1/ssf/streams' });
      },
      create(body: CreateSsfStreamBody): Promise<SsfStreamCreated> {
        return request({ method: 'POST', path: '/v1/ssf/streams', body });
      },
      get(id: string): Promise<SsfStream> {
        return request({ method: 'GET', path: stream(id) });
      },
      update(id: string, body: UpdateSsfStreamBody): Promise<SsfStream> {
        return request({ method: 'PATCH', path: stream(id), body });
      },
      delete(id: string): Promise<void> {
        return request({ method: 'DELETE', path: stream(id) });
      },
      /** Queue a verification event so the receiver can confirm the stream works. */
      verify(id: string, state?: string): Promise<{ object: 'ssf_verification'; stream_id: string; state: string }> {
        return request({ method: 'POST', path: `${stream(id)}/verify`, body: { state } });
      },
      /** SSF 1.0 subject management: `default_subjects` ALL streams carry everyone but removed subjects, NONE streams only added ones. */
      subjects(id: string): Promise<{ object: 'list'; default_subjects: 'ALL' | 'NONE'; data: Array<{ object: 'ssf_stream_subject'; subject: Record<string, string>; mode: 'include' | 'exclude'; created_at: number }> }> {
        return request({ method: 'GET', path: `${stream(id)}/subjects` });
      },
      events(id: string, query: { limit?: number } = {}): Promise<{ object: 'list'; data: SsfEventRecord[] }> {
        return request({ method: 'GET', path: `${stream(id)}/events`, query });
      },
    },
    receivers: {
      list(): Promise<{ object: 'list'; data: SsfReceiver[] }> {
        return request({ method: 'GET', path: '/v1/ssf/receivers' });
      },
      create(body: CreateSsfReceiverBody): Promise<SsfReceiver> {
        return request({ method: 'POST', path: '/v1/ssf/receivers', body });
      },
      update(id: string, body: Partial<Omit<CreateSsfReceiverBody, 'issuer'>> & { enabled?: boolean }): Promise<SsfReceiver> {
        return request({ method: 'PATCH', path: receiver(id), body });
      },
      delete(id: string): Promise<void> {
        return request({ method: 'DELETE', path: receiver(id) });
      },
    },
  };
}
