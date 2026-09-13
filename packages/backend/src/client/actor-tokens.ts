import { enc, type RequestFn } from './request';

export interface ActorToken {
  object: 'actor_token';
  id: string;
  user_id: string;
  actor: { sub: string };
  /** The one-time opaque secret, revealed once. */
  token: string;
  expires_in: number;
}

export interface CreateActorTokenBody {
  user_id: string;
  actor: { sub: string };
  /** Clamped server-side to [1, 3600]; defaults to 60. */
  expires_in_seconds?: number;
}

export function actorTokensResource(request: RequestFn) {
  return {
    create(body: CreateActorTokenBody, idempotencyKey?: string): Promise<ActorToken> {
      return request({ method: 'POST', path: '/v1/actor_tokens', body, idempotencyKey });
    },
    revoke(id: string): Promise<{ object: 'actor_token'; id: string; revoked: true }> {
      return request({ method: 'POST', path: `/v1/actor_tokens/${enc(id)}/revoke` });
    },
  };
}
