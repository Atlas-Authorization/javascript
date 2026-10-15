import type { FapiClient } from './fapi';

/**
 * End-user API key self-service — a signed-in user manages their OWN `ak_` keys
 * (or, when the application allows it, their active organization's) over
 * `/v1/client/me/api_keys`. Cookie-authenticated through the {@link FapiClient};
 * the feature is off until the application enables it.
 *
 * Creating a key needs a RECENT re-authentication: a stale session gets an
 * {@link ApiKeyRequestError} whose `code` is `STEP_UP_REQUIRED`. Re-authenticate
 * (`reauthenticate()`), then call `createApiKey` again.
 */

/** An end-user API key as its owner sees it. The secret is never part of it. */
export interface UserApiKey {
  object: 'api_key';
  id: string;
  subject_type: 'user' | 'organization';
  subject_id: string;
  name: string | null;
  /** The public `ak_…` head — recognises a key, cannot be used as one. */
  prefix: string;
  claims: Record<string, unknown>;
  scopes: string[] | null;
  /** Usage limits on the key, when the application sets them. */
  limits?: Record<string, unknown> | null;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

/** The create response: the key plus its one-time `secret`. */
export interface CreatedUserApiKey extends UserApiKey {
  /** The plaintext `ak_…` key. Shown exactly once — store it now. */
  secret: string;
  note?: string;
}

export interface UserApiKeyList {
  data: UserApiKey[];
  /** The scopes a new key may carry. */
  allowedScopes: string[];
  /** The claim names a new key may set. */
  allowedClaims: string[];
  /** The most active keys this user (or organization) may hold. */
  maxActiveKeys: number;
  /** Active (unrevoked, unexpired) keys held now. */
  activeCount: number;
}

export interface CreateUserApiKeyInput {
  name?: string;
  /** Absolute expiry, epoch milliseconds. Not with `expiresInSeconds`. */
  expiresAt?: number;
  /** Relative lifetime in seconds. Not with `expiresAt`. */
  expiresInSeconds?: number;
  /** Only scopes the application allows (`allowedScopes`). */
  scopes?: string[];
  /** Only claim names the application allows (`allowedClaims`). */
  claims?: Record<string, unknown>;
  /** Create the key for this (active) organization instead of the user. */
  organizationId?: string;
}

/** A refused request. `code` is the server's stable error code. */
export class ApiKeyRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly param?: string;
  /**
   * The server's stable reason (`too_many_attempts`, …), when it sent one: the
   * catalog key `error.<reason>` a UI shows instead of `message`. See
   * `localizedErrorMessage`.
   */
  readonly reason?: string;
  /** The server's `meta` detail for this error, when it sent one. */
  readonly meta?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    param?: string,
    reason?: string,
    meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiKeyRequestError';
    this.status = status;
    this.code = code;
    this.param = param;
    if (reason) this.reason = reason;
    if (meta) this.meta = meta;
  }

  /** True when the action needs a fresh re-authentication first. */
  get needsReverification(): boolean {
    return this.code === 'STEP_UP_REQUIRED';
  }
}

const BASE = '/v1/client/me/api_keys';

async function call<T>(client: FapiClient, path: string, init: RequestInit = {}): Promise<T> {
  const res = await client.request<T>(path, init);
  if (!res.ok || !res.data) {
    const first = res.errors[0];
    throw new ApiKeyRequestError(
      res.status,
      first?.code ?? 'UNKNOWN',
      first?.message ?? 'The request failed.',
      first?.param,
      first?.reason,
      first?.meta,
    );
  }
  return res.data;
}

/** List the user's keys (or the active organization's, with `organizationId`). */
export async function listApiKeys(
  client: FapiClient,
  options: { organizationId?: string } = {},
): Promise<UserApiKeyList> {
  const query = options.organizationId
    ? `?organization_id=${encodeURIComponent(options.organizationId)}`
    : '';
  const body = await call<{
    data: UserApiKey[];
    allowed_scopes?: string[];
    allowed_claims?: string[];
    max_active_keys?: number;
    active_count?: number;
  }>(client, `${BASE}${query}`, { method: 'GET' });
  return {
    data: body.data ?? [],
    allowedScopes: body.allowed_scopes ?? [],
    allowedClaims: body.allowed_claims ?? [],
    maxActiveKeys: body.max_active_keys ?? 0,
    activeCount: body.active_count ?? 0,
  };
}

/** Create a key. The returned `secret` is shown exactly once. */
export async function createApiKey(
  client: FapiClient,
  input: CreateUserApiKeyInput = {},
): Promise<CreatedUserApiKey> {
  const body: Record<string, unknown> = {};
  if (input.name !== undefined) body.name = input.name;
  if (input.expiresAt !== undefined) body.expires_at = input.expiresAt;
  if (input.expiresInSeconds !== undefined) body.expires_in_seconds = input.expiresInSeconds;
  if (input.scopes !== undefined) body.scopes = input.scopes;
  if (input.claims !== undefined) body.claims = input.claims;
  if (input.organizationId !== undefined) body.organization_id = input.organizationId;
  return call<CreatedUserApiKey>(client, BASE, { method: 'POST', body: JSON.stringify(body) });
}

/** Rename a key (`null` clears the name). */
export async function updateApiKey(
  client: FapiClient,
  id: string,
  input: { name: string | null },
): Promise<UserApiKey> {
  return call<UserApiKey>(client, `${BASE}/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: input.name }),
  });
}

/** Revoke a key. Immediate and permanent. */
export async function revokeApiKey(
  client: FapiClient,
  id: string,
): Promise<{ object: 'api_key'; id: string; revoked: true }> {
  return call<{ object: 'api_key'; id: string; revoked: true }>(
    client,
    `${BASE}/${encodeURIComponent(id)}/revoke`,
    { method: 'POST' },
  );
}
