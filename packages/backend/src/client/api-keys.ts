import { enc, type RequestFn } from './request';
import type { CursorPage, ListPage } from './types';

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

/**
 * §P1-8 a short-lived, offline-verifiable access JWT minted from a long-lived
 * `ak_` key (`POST /v1/api_keys/token`). Signed with the instance's RS256 key, so
 * any resource server verifies it against the public JWKS without a round trip.
 */
export interface ApiKeyToken {
  object: 'api_key_token';
  token: string;
  token_type: 'Bearer';
  jti: string;
  key_id: string;
  subject_type: ApiKeySubjectType;
  subject_id: string;
  scopes: string[];
  constraints: Record<string, unknown>;
  expires_in: number;
  expires_at: number;
  /** Which JWKS/issuer a verifier should check, so it needn't parse the JWT first. */
  issuer: string;
}

export interface MintApiKeyTokenBody {
  /** The long-lived `ak_` secret to mint from. */
  secret: string;
  /** Requested lifetime; clamped to the key's ceiling, its expiry, and the global cap. */
  ttl_seconds?: number;
  audience?: string | string[];
}

/** One entry in the revocation feed: an id and when it was revoked. */
export interface RevokedApiKeyRef {
  object: 'api_key';
  id: string;
  revoked_at: number | null;
}

export interface ListRevokedApiKeysQuery {
  /** An ISO-8601 instant, epoch-millis, or a `next_cursor` from a previous page. */
  since?: string;
  /** Page size (server clamps to its own maximum). */
  limit?: number;
}

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
    /**
     * §P1-8 mint a short-lived delegated token from an `ak_` key. Rate-limited —
     * presenting the secret is the same online credential surface as verify.
     */
    mintToken(body: MintApiKeyTokenBody): Promise<ApiKeyToken> {
      return request({ method: 'POST', path: '/v1/api_keys/token', body });
    },
    /**
     * §P1-8 the revocation feed a resource server polls to deny-list revoked keys
     * while their delegated tokens are still live. Keyset-paginated via `since`.
     */
    listRevoked(query: ListRevokedApiKeysQuery = {}): Promise<CursorPage<RevokedApiKeyRef>> {
      return request({ method: 'GET', path: '/v1/api_keys/revoked', query: { ...query } });
    },
  };
}
