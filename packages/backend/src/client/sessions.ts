import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

export interface Session {
  object: 'session';
  id: string;
  user_id: string;
  status: string;
  last_active_organization_id: string | null;
  impersonated_by: string | null;
  last_active_at: number;
  expire_at: number;
  abandon_at: number;
  created_at: number;
}

export interface ListSessionsParams {
  /** Required by the BAPI: sessions are always scoped to one user. */
  user_id: string;
}

export interface CreateSessionParams {
  /** The user to mint a session for. */
  user_id: string;
  /** Optional impersonation actor — records who is acting as the user. */
  actor?: { sub: string };
}

/**
 * A freshly-minted session. Unlike a listed {@link Session}, this carries the
 * bearer `jwt` and `refresh_token` in-body — returned by design for headless use
 * (the sk_ caller already holds full power; it saves the pk_ redeem/exchange
 * hops). Store the refresh_token to keep the session alive.
 */
export interface MintedSession {
  object: 'session';
  id: string;
  user_id: string;
  jwt: string;
  refresh_token: string;
  expires_in: number;
  impersonated_by?: { sub: string };
}

export function sessionsResource(request: RequestFn) {
  return {
    /**
     * `POST /v1/sessions` — mint a session for a user without the sign-in flow.
     * Returns the bearer jwt + refresh token in-body. Refused for a banned user.
     */
    create(params: CreateSessionParams): Promise<MintedSession> {
      return request({ method: 'POST', path: '/v1/sessions', body: { ...params } });
    },
    /** `GET /v1/sessions?user_id=` — requires a user_id. */
    list(params: ListSessionsParams): Promise<ListPage<Session>> {
      return request({ method: 'GET', path: '/v1/sessions', query: { ...params } });
    },
    get(id: string): Promise<Session> {
      return request({ method: 'GET', path: `/v1/sessions/${enc(id)}` });
    },
    revoke(id: string): Promise<{ object: 'session'; id: string; status: 'revoked' }> {
      return request({ method: 'POST', path: `/v1/sessions/${enc(id)}/revoke` });
    },
  };
}
