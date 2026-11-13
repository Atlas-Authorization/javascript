/**
 * Signed-in password change / first password, and the browsers a user trusted to
 * skip two-factor ("remember this device"). All of these act on the current
 * session, which can be the cookie session or, in a native app, the session
 * token sent as a bearer.
 */
import type { FieldError } from './attempt';
import type { FapiClient } from './fapi';

export type PasswordChangeResult =
  | {
      ok: true;
      userId: string;
      /** How many OTHER sessions were signed out (0 when the instance keeps them). */
      sessionsRevoked: number;
      /** Bearer clients only: a fresh session token. Store it in place of the old one. */
      sessionToken?: string;
      expiresIn?: number;
    }
  | { ok: false; errors: FieldError[]; status: number };

/**
 * Change the password of the signed-in user. Proves the CURRENT password (no recent sign-in needed),
 * applies the sign-up password policy, and signs the user's other sessions out unless the instance opted out.
 * Errors: `current_password` wrong (`VERIFICATION_FAILED`), new password breaks the policy or reuses a recent one
 * (`PASSWORD_POLICY`, `PASSWORD_BREACHED`), or the account has no password yet (use {@link setPassword}).
 */
export async function changePassword(client: FapiClient, input: { currentPassword: string; newPassword: string }): Promise<PasswordChangeResult> {
  const res = await client.post<{ id: string; sessions_revoked?: number; session_token?: string; expires_in?: number }>('/v1/client/me/change_password', {
    current_password: input.currentPassword,
    new_password: input.newPassword,
  });
  if (!res.ok || !res.data) return { ok: false, errors: res.errors, status: res.status };
  return {
    ok: true,
    userId: res.data.id,
    sessionsRevoked: res.data.sessions_revoked ?? 0,
    ...(res.data.session_token ? { sessionToken: res.data.session_token, expiresIn: res.data.expires_in } : {}),
  };
}

export type SetPasswordResult = { ok: true; userId: string; hasPassword: true } | { ok: false; errors: FieldError[]; status: number };

/**
 * Give an account that has no password (an OAuth-only user, or a guest) its first one. Needs a recent sign-in:
 * a stale session answers 403 `STEP_UP_REQUIRED` (re-authenticate, then retry; guests are exempt).
 * An account that already has a password answers 409; use {@link changePassword}.
 */
export async function setPassword(client: FapiClient, password: string): Promise<SetPasswordResult> {
  const res = await client.post<{ id: string; has_password: true }>('/v1/client/me/set_password', { password });
  if (!res.ok || !res.data) return { ok: false, errors: res.errors, status: res.status };
  return { ok: true, userId: res.data.id, hasPassword: true };
}

/** A browser the user chose to trust for two-factor. The token itself is never exposed. */
export interface TrustedDevice {
  id: string;
  device: Record<string, unknown>;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number;
}

interface TrustedDeviceView {
  id: string;
  device?: Record<string, unknown>;
  created_at: number;
  last_used_at: number | null;
  expires_at: number;
}

export type TrustedDevicesResult = { ok: true; devices: TrustedDevice[] } | { ok: false; errors: FieldError[]; status: number };

/** The signed-in user's trusted devices. */
export async function listTrustedDevices(client: FapiClient): Promise<TrustedDevicesResult> {
  const res = await client.get<{ data: TrustedDeviceView[] }>('/v1/client/me/trusted_devices');
  if (!res.ok || !res.data) return { ok: false, errors: res.errors, status: res.status };
  return {
    ok: true,
    devices: res.data.data.map((d) => ({ id: d.id, device: d.device ?? {}, createdAt: d.created_at, lastUsedAt: d.last_used_at, expiresAt: d.expires_at })),
  };
}

export type RevokeTrustedDeviceResult = { ok: true } | { ok: false; errors: FieldError[]; status: number };

/** Stop trusting one device: the next sign-in on it must pass two-factor again. Unknown id answers 404. */
export async function revokeTrustedDevice(client: FapiClient, id: string): Promise<RevokeTrustedDeviceResult> {
  const res = await client.request<unknown>(`/v1/client/me/trusted_devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
  return res.ok ? { ok: true } : { ok: false, errors: res.errors, status: res.status };
}

export type RevokeAllTrustedDevicesResult = { ok: true; count: number } | { ok: false; errors: FieldError[]; status: number };

/** Forget every device this user trusted: each must pass two-factor again on its next sign-in. `count` is how many were forgotten. */
export async function revokeAllTrustedDevices(client: FapiClient): Promise<RevokeAllTrustedDevicesResult> {
  const res = await client.request<{ count?: number }>('/v1/client/me/trusted_devices', { method: 'DELETE' });
  return res.ok ? { ok: true, count: typeof res.data?.count === 'number' ? res.data.count : 0 } : { ok: false, errors: res.errors, status: res.status };
}
