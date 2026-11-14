import { type RequestFn } from './request';



export type MigrationsGetBetterAuthBridgeResult = {
  object?: 'better_auth_bridge';
  enabled?: boolean;
  /** End of the migration window, or null (Unix milliseconds). */
  ends_at?: number | null;
  cookie_prefix?: string;
  live_fallback?: {
    enabled?: boolean;
    base_url?: string | null;
    /** Whether a secret is stored — never the secret. */
    has_secret?: boolean;
  };
  /** The Frontend API path the SDKs call. */
  exchange_path?: string;
  stats?: {
    exchanged?: number;
    from_import?: number;
    from_live?: number;
  };
  /** Created, or null when never configured (Unix milliseconds). */
  created_at?: number | null;
  /** Updated, or null when never configured (Unix milliseconds). */
  updated_at?: number | null;
};

export type MigrationsSetBetterAuthBridgeBody = {
  /** Whether the exchange endpoint accepts Better Auth sessions. Default false. */
  enabled?: boolean;
  /** End of the migration window (ISO-8601 or Unix ms); null = open until disabled. After it, every exchange is refused. */
  ends_at?: string | number | null;
  /** Better Auth's advanced.cookiePrefix (default "better-auth"); the session cookie is <prefix>.session_token. */
  cookie_prefix?: string;
  /** Validate a session missing from the import (created after the export) by asking the old app, server to server. */
  live_fallback?: {
    /** Turn the live check on. Requires base_url. */
    enabled?: boolean;
    /** The old app's Better Auth base URL including its base path, e.g. https://app.example.com/api/auth. Atlas calls <base_url>/get-session. Public https on a production instance. */
    base_url?: string | null;
    /** The old app's BETTER_AUTH_SECRET. Write-only: lets Atlas check the cookie signature and sign a bare token for the live call. Omit to keep, null to clear. */
    secret?: string | null;
  };
};

export type MigrationsSetBetterAuthBridgeResult = {
  object?: 'better_auth_bridge';
  enabled?: boolean;
  /** End of the migration window, or null (Unix milliseconds). */
  ends_at?: number | null;
  cookie_prefix?: string;
  live_fallback?: {
    enabled?: boolean;
    base_url?: string | null;
    /** Whether a secret is stored — never the secret. */
    has_secret?: boolean;
  };
  /** The Frontend API path the SDKs call. */
  exchange_path?: string;
  stats?: {
    exchanged?: number;
    from_import?: number;
    from_live?: number;
  };
  /** Created, or null when never configured (Unix milliseconds). */
  created_at?: number | null;
  /** Updated, or null when never configured (Unix milliseconds). */
  updated_at?: number | null;
};

export type MigrationsDeleteBetterAuthBridgeResult = {
  object?: 'better_auth_bridge';
  deleted?: boolean;
};

/** Operations on `/v1/migrations` (3). */
export function migrationsOpsResource(request: RequestFn) {
  return {
    /** Read the Better Auth session-bridge settings (migration window, cookie prefix, live fallback) and exchange counts. Reports live_fallback.has_secret, never the secret. */
    getBetterAuthBridge(): Promise<MigrationsGetBetterAuthBridgeResult> {
      return request({ method: 'GET', path: '/v1/migrations/better_auth/bridge' });
    },
    /** Create or update the Better Auth session-bridge settings. Every field is optional and merged onto the stored ones; the Better Auth secret is write-only. */
    setBetterAuthBridge(body: MigrationsSetBetterAuthBridgeBody): Promise<MigrationsSetBetterAuthBridgeResult> {
      return request({ method: 'PUT', path: '/v1/migrations/better_auth/bridge', body });
    },
    /** Remove the Better Auth session-bridge settings (the bridge is off and the stored secret is deleted). */
    deleteBetterAuthBridge(): Promise<MigrationsDeleteBetterAuthBridgeResult> {
      return request({ method: 'DELETE', path: '/v1/migrations/better_auth/bridge' });
    },
  };
}
