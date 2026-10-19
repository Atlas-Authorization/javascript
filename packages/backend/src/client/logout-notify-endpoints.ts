import { enc, type RequestFn } from './request';

/**
 * Logout fan-out ("also notify") endpoints: downstream services that receive the
 * same signed `logout_token` as your OIDC apps whenever an Atlas session ends,
 * plus a subject-wide one (sub, no sid) on ban, deletion or deprovisioning.
 */
export interface LogoutNotifyEndpoint {
  object: 'logout_notify_endpoint';
  id: string;
  url: string;
  /** The client_id this endpoint follows; null = instance-wide. */
  oauth_client_id: string | null;
  /** The `aud` its logout_tokens carry. */
  audience: string;
  description?: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateLogoutNotifyEndpointBody {
  /** Public https endpoint. */
  url: string;
  /** A client_id of this instance to follow; omit for instance-wide. */
  oauth_client_id?: string | null;
  /** The logout_token `aud`. Default: the client_id when following a client, else the instance id. */
  audience?: string | null;
  /** Up to 200 characters. */
  description?: string | null;
}

export interface UpdateLogoutNotifyEndpointBody {
  url?: string;
  audience?: string | null;
  description?: string | null;
}

/** One logout_token sent to a fan-out endpoint. */
export interface LogoutNotifyDelivery {
  object: 'logout_notify_delivery';
  id: string;
  sub: string;
  /** null = a subject-wide logout (ban / deletion). */
  sid?: string | null;
  status: 'pending' | 'success' | 'failed';
  attempt_number: number;
  http_status?: number | null;
  response_snippet?: string | null;
  next_retry_at?: number | null;
  delivered_at?: number | null;
  created_at: number;
}

export interface LogoutNotifyList<T> {
  object: 'list';
  data: T[];
  has_more?: boolean;
  next_cursor?: string | null;
}

export function logoutNotifyEndpointsResource(request: RequestFn) {
  return {
    list(): Promise<LogoutNotifyList<LogoutNotifyEndpoint>> {
      return request({ method: 'GET', path: '/v1/logout_notify_endpoints' });
    },
    /** Register an endpoint. The URL must be public https. */
    create(body: CreateLogoutNotifyEndpointBody, idempotencyKey?: string): Promise<LogoutNotifyEndpoint> {
      return request({ method: 'POST', path: '/v1/logout_notify_endpoints', body, idempotencyKey });
    },
    get(id: string): Promise<LogoutNotifyEndpoint> {
      return request({ method: 'GET', path: `/v1/logout_notify_endpoints/${enc(id)}` });
    },
    update(id: string, body: UpdateLogoutNotifyEndpointBody, idempotencyKey?: string): Promise<LogoutNotifyEndpoint> {
      return request({ method: 'PATCH', path: `/v1/logout_notify_endpoints/${enc(id)}`, body, idempotencyKey });
    },
    /** Its queued deliveries go with it. */
    delete(
      id: string,
      idempotencyKey?: string,
    ): Promise<{ object: 'logout_notify_endpoint'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/logout_notify_endpoints/${enc(id)}`, idempotencyKey });
    },
    /** The endpoint's delivery log, newest first. */
    listDeliveries(id: string, params: { limit?: number } = {}): Promise<LogoutNotifyList<LogoutNotifyDelivery>> {
      return request({
        method: 'GET',
        path: `/v1/logout_notify_endpoints/${enc(id)}/deliveries`,
        query: { ...params },
      });
    },
  };
}
