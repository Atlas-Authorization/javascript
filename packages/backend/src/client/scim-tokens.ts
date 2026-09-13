import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

export interface ScimToken {
  object: 'scim_token';
  id: string;
  name: string | null;
  organization_id: string;
  connection_id: string | null;
  prefix: string;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

/** Create reveals the usable secret exactly once. */
export interface ScimTokenWithSecret extends ScimToken {
  secret: string;
  note: string;
}

export interface CreateScimTokenBody {
  organization_id: string;
  name?: string;
  connection_id?: string;
}

export function scimTokensResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<ScimToken>> {
      return request({ method: 'GET', path: '/v1/scim_tokens' });
    },
    create(body: CreateScimTokenBody, idempotencyKey?: string): Promise<ScimTokenWithSecret> {
      return request({ method: 'POST', path: '/v1/scim_tokens', body, idempotencyKey });
    },
    revoke(
      id: string,
    ): Promise<{ object: 'scim_token'; id: string; revoked: true; note: string }> {
      return request({ method: 'POST', path: `/v1/scim_tokens/${enc(id)}/revoke` });
    },
  };
}
