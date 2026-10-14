import type { RequestFn } from './request';

/**
 * The instance's lazy-migration connection: on sign-in, Atlas can verify a
 * password against your legacy user store and (optionally) import the user.
 * The signing secret is never returned — only `has_signing_secret`.
 */
export interface LegacyAuthConnection {
  object: 'legacy_auth_connection';
  id?: string;
  enabled?: boolean;
  verify_url?: string;
  has_signing_secret?: boolean;
  import_on_login?: boolean;
  timeout_ms?: number;
  strategy?: string;
  /** Epoch ms. */
  created_at?: number;
  /** Epoch ms. */
  updated_at?: number;
  /** Present and `false` when no connection exists yet. */
  configured?: boolean;
}

/** `PUT /v1/legacy_auth_connection` — create or replace the connection. */
export interface PutLegacyAuthConnectionBody {
  /** Your HTTPS verify endpoint (public https on a production instance). */
  verify_url: string;
  /** Whether sign-in consults the legacy store. Default false. */
  enabled?: boolean;
  /** HMAC signing secret. Write-only; required on create, omit on edit to keep the stored one. */
  signing_secret?: string;
  /** Create the user locally on a successful verify. Default true. */
  import_on_login?: boolean;
  /** Fail-closed call budget, 1–30000 ms. Default 5000. */
  timeout_ms?: number;
  strategy?: 'password';
}

export function legacyAuthConnectionResource(request: RequestFn) {
  return {
    /** Returns `{ configured: false }` when none exists. */
    get(): Promise<LegacyAuthConnection> {
      return request({ method: 'GET', path: '/v1/legacy_auth_connection' });
    },
    set(body: PutLegacyAuthConnectionBody, idempotencyKey?: string): Promise<LegacyAuthConnection> {
      return request({ method: 'PUT', path: '/v1/legacy_auth_connection', body, idempotencyKey });
    },
    delete(): Promise<{ object: 'legacy_auth_connection'; deleted: boolean }> {
      return request({ method: 'DELETE', path: '/v1/legacy_auth_connection' });
    },
  };
}
