import type { FapiClient } from './fapi';

/**
 * The signed-in person's own security checkup in one read (`GET /v1/client/me/security_summary`): how they can
 * sign in, which providers, second factors, passkeys and devices they hold, and their open sessions. Ids and labels
 * only, never a secret. Works with the cookie session or a native app's session token.
 */
export interface SecuritySummary {
  object: 'security_summary';
  user_id: string;
  password_enabled: boolean;
  /** Epoch milliseconds; null when the account has no password or it was never changed. */
  password_changed_at: number | null;
  mfa_enabled: boolean;
  has_passkey: boolean;
  /** What the user can sign in with right now, e.g. `password`, `passkey`, `email_code`, `oauth_google`. */
  sign_in_methods: string[];
  linked_providers: Array<{
    id: string;
    provider: string;
    provider_user_id: string;
    email_address: string | null;
    email_verified: boolean;
  }>;
  mfa_factors: Array<{ id: string; type: string; verified: true; created_at: number }>;
  backup_codes_remaining: number | null;
  passkeys: Array<{ id: string; name: string | null; created_at: number; last_used_at: number | null }>;
  trusted_devices: Array<{
    kind: 'remembered_browser' | 'device_key';
    id: string;
    label: string | null;
    created_at: number;
    last_used_at: number | null;
    expires_at: number | null;
  }>;
  active_sessions: {
    count: number;
    latest: { id: string; last_active_at: number; current?: boolean; ip_address: string | null; country: string | null } | null;
  };
}

/** Thrown when the request is refused; `code` is the server's stable error code. */
export class SecuritySummaryError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'SecuritySummaryError';
  }
}

/** The signed-in user's security summary. */
export async function getSecuritySummary(client: FapiClient): Promise<SecuritySummary> {
  const res = await client.request<SecuritySummary>('/v1/client/me/security_summary', { method: 'GET' });
  if (!res.ok || !res.data) {
    const first = res.errors[0];
    throw new SecuritySummaryError(res.status, first?.code ?? 'UNKNOWN', first?.message ?? 'The request failed.');
  }
  return res.data;
}
