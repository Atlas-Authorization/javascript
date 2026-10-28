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
  /**
   * Epoch ms the session ends from inactivity unless there is activity first
   * (same value as `abandon_at`). Returned by every session read: `sessions.get`,
   * `sessions.list`, `users.listSessions` and `sessions.touch`.
   */
  idle_expires_at?: number;
  created_at: number;
  /** Custom per-session data your backend (or a post_login Action) attached; null when none. */
  custom_data?: Record<string, unknown> | null;
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
  /** Custom per-session data to attach (a JSON object, at most 2 KB). */
  custom_data?: Record<string, unknown>;
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
  custom_data?: Record<string, unknown> | null;
}

/** A JWT minted from a named JWT template. */
/** An identity-integration token (claims: /schemas/integration-token-v1.json). */
export interface SessionIntegrationToken {
  object: 'integration_token';
  integration: string;
  product: string;
  jwt: string;
  /** Seconds until the token expires (at most 120). */
  expires_in: number;
  audience: string;
}

export interface SessionTemplateToken {
  object: string;
  jwt: string;
  /** Seconds until the token expires. */
  expires_in: number;
}

/**
 * `getToken(id, { for })`: an identity-integration token. With a per-call
 * audience (`audience`, `cbid`, or `audienceParams` for the integration's own
 * parameter), the token's `aud` is that one, when the integration permits it.
 */
export interface IntegrationTokenRequest {
  for: string;
  audience?: string;
  /** Cookie Munch: the site id (`aud` = `cookiemunch:<cbid>`). */
  cbid?: string;
  audienceParams?: Record<string, string>;
}

export function sessionsResource(request: RequestFn) {
  /**
   * `POST /v1/sessions/:id/tokens/:template` — mint a token from a named JWT
   * template for this session. The reserved name `session` is refused.
   */
  function getToken(id: string, template: string): Promise<SessionTemplateToken>;
  /**
   * `getToken(id, { for })` — an identity-integration token for this session
   * (`POST /v1/sessions/:id/integration_tokens/:integration`): a preset such as
   * `chatly`, or a custom integration id.
   */
  function getToken(id: string, options: IntegrationTokenRequest): Promise<SessionIntegrationToken>;
  function getToken(id: string, what: string | IntegrationTokenRequest): Promise<SessionTemplateToken | SessionIntegrationToken> {
    if (typeof what === 'object') {
      // A per-call audience: `audience`, `cbid` (cookiemunch) or the integration's own parameter.
      const query: Record<string, string> = { ...(what.audienceParams ?? {}) };
      if (what.cbid) query.cbid = what.cbid;
      if (what.audience) query.audience = what.audience;
      return request({
        method: 'POST',
        path: `/v1/sessions/${enc(id)}/integration_tokens/${enc(what.for)}`,
        ...(Object.keys(query).length ? { query } : {}),
      });
    }
    return request({ method: 'POST', path: `/v1/sessions/${enc(id)}/tokens/${enc(what)}` });
  }
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
     * `PUT /v1/sessions/:id/custom_data` — replace the session's custom data
     * (null clears it). At most 2 KB; only an active session can be changed.
     * Not for secrets: the signed-in user can read it.
     */
    setCustomData(id: string, customData: Record<string, unknown> | null): Promise<Session> {
      return request({ method: 'PUT', path: `/v1/sessions/${enc(id)}/custom_data`, body: { custom_data: customData } });
    },
    /**
     * `PATCH /v1/sessions/:id/custom_data` — merge keys into the session's custom
     * data; a key set to null is removed.
     */
    updateCustomData(id: string, patch: Record<string, unknown>): Promise<Session> {
      return request({ method: 'PATCH', path: `/v1/sessions/${enc(id)}/custom_data`, body: { custom_data: patch } });
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
    getToken,
  };
}
