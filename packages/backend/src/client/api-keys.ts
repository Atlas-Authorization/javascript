import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

export type ApiKeySubjectType = 'user' | 'organization';

/**
 * An end-user API key — Clerk `api_keys` parity. A tenant mints these for ITS OWN
 * users/organizations and later asks Atlas to {@link ApiKeysResource.verify} one a
 * subject presented. Only a hash is stored, so the `ak_` secret is shown exactly
 * once at mint (see {@link ApiKeyWithSecret}); a read reports only the `prefix`.
 */
export interface ApiKey {
  object: 'api_key';
  id: string;
  subject_type: ApiKeySubjectType;
  subject_id: string;
  name: string | null;
  /** Enough to tell two keys apart in a listing; not enough to use one. */
  prefix: string;
  claims: Record<string, unknown>;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

/** The mint response: the key plus its secret, revealed exactly once. */
export interface ApiKeyWithSecret extends ApiKey {
  secret: string;
  note: string;
}

export interface CreateApiKeyBody {
  subject_type: ApiKeySubjectType;
  subject_id: string;
  name?: string;
  claims?: Record<string, unknown>;
  /** Epoch ms; null (or omitted) never expires. */
  expires_at?: number | null;
}

export interface UpdateApiKeyBody {
  name?: string | null;
  claims?: Record<string, unknown>;
  expires_at?: number | null;
}

/**
 * The verify verdict. Every negative — unknown, malformed, revoked, expired, or a
 * key whose subject was since deleted — resolves to the SAME `{ valid: false }`,
 * so a caller learns nothing about which keys exist.
 */
export type ApiKeyVerification =
  | { object: 'api_key_verification'; valid: false }
  | {
      object: 'api_key_verification';
      valid: true;
      id: string;
      subject_type: ApiKeySubjectType;
      subject_id: string;
      claims: Record<string, unknown>;
      last_used_at: number | null;
    };

export function apiKeysResource(request: RequestFn) {
  return {
    /** Optionally narrowed to one subject. */
    list(query?: {
      subject_type?: ApiKeySubjectType;
      subject_id?: string;
    }): Promise<ListPage<ApiKey>> {
      return request({ method: 'GET', path: '/v1/api_keys', query });
    },
    /** Mint a key. The secret is returned once, here. */
    create(body: CreateApiKeyBody, idempotencyKey?: string): Promise<ApiKeyWithSecret> {
      return request({ method: 'POST', path: '/v1/api_keys', body, idempotencyKey });
    },
    /** Check a presented secret. Rate-limited — it is an online credential check. */
    verify(secret: string): Promise<ApiKeyVerification> {
      return request({ method: 'POST', path: '/v1/api_keys/verify', body: { secret } });
    },
    get(id: string): Promise<ApiKey> {
      return request({ method: 'GET', path: `/v1/api_keys/${enc(id)}` });
    },
    update(id: string, body: UpdateApiKeyBody): Promise<ApiKey> {
      return request({ method: 'PATCH', path: `/v1/api_keys/${enc(id)}`, body });
    },
    /** Revoke a key. It stays queryable but never authenticates again. */
    delete(id: string): Promise<{ object: 'api_key'; id: string; revoked: true }> {
      return request({ method: 'DELETE', path: `/v1/api_keys/${enc(id)}` });
    },
  };
}
