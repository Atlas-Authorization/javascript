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
  /** Epoch ms the session ends from inactivity unless there is activity first (same value as `abandon_at`). */
  idle_expires_at?: number;
  created_at: number;
}

/** The session after a keep-alive {@link sessionsResource} `touch`. */
export interface TouchedSession extends Session {
  idle_expires_at: number;
  /** true when this touch moved the inactivity window; false when one within the last 60 seconds already had. */
  extended: boolean;
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

/** A JWT minted from a named JWT template. */
export interface SessionTemplateToken {
  object: string;
  jwt: string;
  /** Seconds until the token expires. */
  expires_in: number;
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
    /**
     * `POST /v1/sessions/:id/touch` — keep a session alive from your backend:
     * slides its inactivity window as if the user had just loaded a page. Never
     * extends past the absolute expiry and never revives an ended session (409
     * `SESSION_REVOKED` / `SESSION_IDLE_EXPIRED` / `SESSION_EXPIRED`). At most one
     * effective write per minute, so calling it on every request is safe.
     */
    touch(id: string): Promise<TouchedSession> {
      return request({ method: 'POST', path: `/v1/sessions/${enc(id)}/touch` });
    },
    /**
     * `POST /v1/sessions/:id/tokens/:template` — mint a token from a named JWT
     * template for this session. The reserved name `session` is refused.
     */
    getToken(id: string, template: string): Promise<SessionTemplateToken> {
      return request({
        method: 'POST',
        path: `/v1/sessions/${enc(id)}/tokens/${enc(template)}`,
      });
    },
  };
}
