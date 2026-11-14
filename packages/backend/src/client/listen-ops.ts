import { type RequestFn } from './request';



export type ListenCreateSessionBody = {
  /** Event types or patterns to forward, such as `user.created` or `user.*`. Omit for every event. */
  events?: string[];
  /** How long the session lives. Default 3600. */
  ttl_seconds?: number;
};

export type ListenCreateSessionResult = {
  object?: 'listen_session';
  id?: string;
  /** Verify forwarded deliveries with this secret, exactly like a webhook signing secret. */
  secret?: string;
  events?: string[];
  /** Epoch milliseconds. */
  expires_at?: number;
  stream_url?: string;
};

/** Operations on `/v1/listen` (1). */
export function listenOpsResource(request: RequestFn) {
  return {
    /** Start a local webhook forwarding session (what `atlas listen` uses). Returns a session id, a signing secret for that session only (it is unrelated to any registered endpoint's secret) and the stream URL. The session needs no storage: it expires at `expires_at` (default 1 hour, `ttl_seconds` 60 to 43200). */
    createSession(body: ListenCreateSessionBody, idempotencyKey?: string): Promise<ListenCreateSessionResult> {
      return request({ method: 'POST', path: '/v1/listen/sessions', body, idempotencyKey });
    },
  };
}
