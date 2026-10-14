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
  /** Per-key spend caps, or `null` when the key has none. */
  limits?: ApiKeyLimit[] | null;
  /** Each cap with its current-window usage (empty when the key has no caps). */
  usage?: ApiKeyLimitState[];
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

/** The window a spend cap counts over. `request` caps a single debit; `day`/`month` are UTC calendar windows; `total` never resets. */
export type ApiKeyLimitPeriod = 'request' | 'day' | 'month' | 'total';

/** A per-key spend cap, metered with {@link apiKeysResource} `recordUsage`. */
export interface ApiKeyLimit {
  /** App-defined unit, e.g. `"requests"` or `"usd_cents"`. */
  unit: string;
  /** The cap, in `unit`. */
  amount: number;
  period: ApiKeyLimitPeriod;
}

/** A spend cap with its current-window usage. */
export interface ApiKeyLimitState {
  unit: string;
  period: ApiKeyLimitPeriod;
  amount: number;
  /** Used in the current window (always 0 for a per-request cap). */
  used: number;
  /** `amount - used`, never below 0 (the cap itself for a per-request cap). */
  remaining: number;
  /** Epoch ms the current window started; null for a per-request cap. */
  window_start: number | null;
  /** Epoch ms the current window ends; null for per-request and total caps. */
  resets_at: number | null;
}

/** A raw usage counter for one unit in its current window. */
export interface ApiKeyUsageCounter {
  unit: string;
  period: 'day' | 'month' | 'total';
  used: number;
  window_start: number;
  /** Epoch ms the window ends; null for `total`. */
  resets_at: number | null;
}

/** Body of `POST /v1/api_keys/{id}/usage`. */
export interface RecordApiKeyUsageBody {
  /** How much to debit, in `unit` (a positive integer). */
  amount: number;
  /** The unit to debit, matching the unit of the caps it should count against. */
  unit: string;
  /** Retry-safe key: the same value returns the first outcome without counting again (kept 24 hours). */
  idempotency_key?: string;
}

/**
 * The outcome of a usage debit. A refusal is NOT an error: it resolves with
 * `allowed: false` and `code: 'LIMIT_EXCEEDED'`, and nothing was recorded.
 */
export interface ApiKeyUsageDebit {
  object: 'api_key_usage_debit';
  key_id: string;
  unit: string;
  amount: number;
  /** true when the debit was recorded; false when it would exceed a cap. */
  allowed: boolean;
  /** Present only when `allowed` is false. */
  code?: 'LIMIT_EXCEEDED';
  /** The caps that refused the debit (empty when allowed). */
  exceeded: ApiKeyLimitState[];
  /** Every cap on the key after this call. */
  usage: ApiKeyLimitState[];
  /** The debited unit's day, month and total counters after this call. */
  counters: ApiKeyUsageCounter[];
  /** true when this is the stored outcome of an earlier call with the same idempotency key. */
  idempotent_replay: boolean;
}

/** A key's current-window usage (`GET /v1/api_keys/{id}/usage`). */
export interface ApiKeyUsage {
  object: 'api_key_usage';
  key_id: string;
  limits: ApiKeyLimit[] | null;
  usage: ApiKeyLimitState[];
  /** Current-window counters for every unit the key has been debited in, capped or not. */
  counters: ApiKeyUsageCounter[];
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
  /** Per-key spend caps, metered with `recordUsage`. */
  limits?: ApiKeyLimit[] | null;
}

export interface UpdateApiKeyBody {
  name?: string | null;
  claims?: Record<string, unknown>;
  expires_at?: number | null;
  /** Replace the spend caps; `null` clears them (counters are kept). */
  limits?: ApiKeyLimit[] | null;
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
      name?: string | null;
      claims: Record<string, unknown>;
      scopes?: string[] | null;
      constraints?: Record<string, unknown>;
      /** The key's spend caps (null when none). */
      limits?: ApiKeyLimit[] | null;
      /** Each cap with its current-window usage. */
      usage?: ApiKeyLimitState[];
      last_used_at: number | null;
      expires_at?: number | null;
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
     * Meter usage against a key's spend caps, atomically. When the debit fits
     * every cap for `unit` it is recorded and `allowed` is true; when it would
     * exceed one, nothing is recorded and the call resolves (it does not throw)
     * with `allowed: false` and `code: 'LIMIT_EXCEEDED'`. Reusing an
     * `idempotency_key` with a different unit or amount is a 409
     * `IDEMPOTENCY_CONFLICT`; a revoked or expired key is a 409 `CONFLICT`.
     */
    recordUsage(id: string, body: RecordApiKeyUsageBody): Promise<ApiKeyUsageDebit> {
      return request({ method: 'POST', path: `/v1/api_keys/${enc(id)}/usage`, body });
    },
    /** A key's current-window usage: each cap's state plus every unit's counters. */
    getUsage(id: string): Promise<ApiKeyUsage> {
      return request({ method: 'GET', path: `/v1/api_keys/${enc(id)}/usage` });
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
