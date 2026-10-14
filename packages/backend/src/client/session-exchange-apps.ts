import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

/**
 * A downstream app that exchanges an Atlas session for its own. When the Atlas
 * session ends, Atlas POSTs a signed `logout_token` to `backchannel_logout_uri`
 * (verify it with `verifyLogoutToken`).
 */
export interface SessionExchangeApp {
  object: 'session_exchange_app';
  id: string;
  name: string;
  backchannel_logout_uri: string;
  /** The `aud` claim the logout_token carries. */
  audience: string;
  created_at: number;
  updated_at: number;
}

export interface CreateSessionExchangeAppBody {
  name: string;
  /** Public https endpoint that receives `logout_token=<jwt>` (form-encoded). */
  backchannel_logout_uri: string;
  /** Override for the logout_token `aud`. Defaults to the app id. */
  audience?: string | null;
}

export interface UpdateSessionExchangeAppBody {
  name?: string;
  backchannel_logout_uri?: string;
  audience?: string | null;
}

export function sessionExchangeAppsResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<SessionExchangeApp> & { next_cursor?: string | null }> {
      return request({ method: 'GET', path: '/v1/session_exchange_apps' });
    },
    create(body: CreateSessionExchangeAppBody, idempotencyKey?: string): Promise<SessionExchangeApp> {
      return request({ method: 'POST', path: '/v1/session_exchange_apps', body, idempotencyKey });
    },
    get(id: string): Promise<SessionExchangeApp> {
      return request({ method: 'GET', path: `/v1/session_exchange_apps/${enc(id)}` });
    },
    update(id: string, body: UpdateSessionExchangeAppBody): Promise<SessionExchangeApp> {
      return request({ method: 'PATCH', path: `/v1/session_exchange_apps/${enc(id)}`, body });
    },
    /** Queued back-channel logout deliveries are deleted with it. */
    delete(id: string): Promise<{ object: 'session_exchange_app'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/session_exchange_apps/${enc(id)}` });
    },
  };
}
