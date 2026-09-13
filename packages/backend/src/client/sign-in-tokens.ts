import type { RequestFn } from './request';

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
    create(body: CreateSignInTokenBody, idempotencyKey?: string): Promise<SignInToken> {
      return request({ method: 'POST', path: '/v1/sign_in_tokens', body, idempotencyKey });
    },
  };
}
