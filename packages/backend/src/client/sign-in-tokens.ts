import { enc, type RequestFn } from './request';

export interface SignInToken {
  object: 'sign_in_token';
  user_id: string;
  token: string;
  expires_in: number;
}

export interface CreateSignInTokenBody {
  user_id: string;
  /**
   * Accepted by the wire type but currently ignored server-side — the token
   * always lives 60 seconds. Kept so the shape matches the BAPI.
   */
  expires_in_seconds?: number;
}

export function signInTokensResource(request: RequestFn) {
  return {
    /**
     * @deprecated The sign-in token API is deprecated (sunset 2027-04-01). Use
     * `sessions.createBrowserTicket()`: the same one-time ticket, plus a ready URL.
     */
    create(body: CreateSignInTokenBody, idempotencyKey?: string): Promise<SignInToken> {
      return request({ method: 'POST', path: '/v1/sign_in_tokens', body, idempotencyKey });
    },
    /**
     * `POST /v1/sign_in_tokens/:id/revoke` — revoke an unused sign-in token
     * before its 60-second window elapses.
     *
     * @deprecated The sign-in token API is deprecated (sunset 2027-04-01).
     * Use `sessions.createBrowserTicket()` (or `sessions.create()` for a server-side session).
     */
    revoke(id: string): Promise<{ object: 'sign_in_token'; id: string; revoked: true }> {
      return request({ method: 'POST', path: `/v1/sign_in_tokens/${enc(id)}/revoke` });
    },
  };
}
