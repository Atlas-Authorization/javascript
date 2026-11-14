/**
 * Signed-in password change / first password, and the browsers a user trusted to
 * skip two-factor ("remember this device"). All of these act on the current
 * session, which can be the cookie session or, in a native app, the session
 * token sent as a bearer.
 */
import type { FieldError } from './attempt';
import type { FapiClient, FapiResponse } from './fapi';
import { stepUpRequirement, type StepUpRequirement } from './step-up';

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

/**
 * A refused security-page call. `stepUpRequired` is true when the server answered `STEP_UP_REQUIRED` (the session
 * must prove a credential again first); `stepUp` says which factors it accepts. Re-authenticate with `stepUp()`
 * (or `retryWithStepUp`) and call again.
 */
export interface SecurityFailure {
  ok: false;
  errors: FieldError[];
  status: number;
  stepUpRequired: boolean;
  stepUp?: StepUpRequirement;
}

function failure(res: FapiResponse<unknown>): SecurityFailure {
  const stepUp = stepUpRequirement(res.errors);
  return { ok: false, errors: res.errors, status: res.status, stepUpRequired: stepUp !== null, ...(stepUp ? { stepUp } : {}) };
}

// ---- Sessions ----

/** One of the user's sessions (a signed-in device). */
export interface AccountSession {
  id: string;
  status: string;
  /** The session making this call. Cookie and session-token (bearer) callers both get it marked. */
  current: boolean;
  lastActiveAt: number;
  expiresAt: number;
  createdAt: number;
  ipAddress: string | null;
  deviceLabel: string | null;
  browser: string | null;
  os: string | null;
  deviceType: string | null;
  location: string | null;
  /** First-factor strategy the session signed in with (e.g. `password`, `passkey`, `oauth`). Null for sessions from before it was recorded. */
  signInMethod: string | null;
  /** The social or enterprise provider when `signInMethod` is one (e.g. `google`). */
  provider: string | null;
  /** Authentication methods references (RFC 8176), e.g. `['pwd', 'otp']`. */
  amr: string[] | null;
}

interface SessionView {
  id: string;
  status: string;
  current?: boolean;
  last_active_at: number;
  expire_at: number;
  created_at: number;
  ip_address?: string | null;
  device_label?: string | null;
  browser?: string | null;
  os?: string | null;
  device_type?: string | null;
  location?: string | null;
  sign_in_method?: string | null;
  provider?: string | null;
  amr?: string[] | null;
}

export type AccountSessionsResult = { ok: true; sessions: AccountSession[] } | SecurityFailure;

/** The signed-in user's sessions, newest activity first as the server orders them. */
export async function listSessions(client: FapiClient): Promise<AccountSessionsResult> {
  const res = await client.get<{ data: SessionView[] }>('/v1/client/sessions');
  if (!res.ok || !res.data) return failure(res);
  return {
    ok: true,
    sessions: res.data.data.map((s) => ({
      id: s.id,
      status: s.status,
      current: s.current === true,
      lastActiveAt: s.last_active_at,
      expiresAt: s.expire_at,
      createdAt: s.created_at,
      ipAddress: s.ip_address ?? null,
      deviceLabel: s.device_label ?? null,
      browser: s.browser ?? null,
      os: s.os ?? null,
      deviceType: s.device_type ?? null,
      location: s.location ?? null,
      signInMethod: s.sign_in_method ?? null,
      provider: s.provider ?? null,
      amr: s.amr ?? null,
    })),
  };
}

export type RevokeSessionResult = { ok: true } | SecurityFailure;

/** Sign one session out. Revoking the current session signs this device out too. */
export async function revokeAccountSession(client: FapiClient, id: string): Promise<RevokeSessionResult> {
  const res = await client.post<unknown>(`/v1/client/sessions/${encodeURIComponent(id)}/revoke`, {});
  return res.ok ? { ok: true } : failure(res);
}

export type RevokeOtherSessionsResult = { ok: true; count: number } | SecurityFailure;

/** Sign every OTHER session out; this one stays. `count` is how many ended. */
export async function revokeAllSessions(client: FapiClient): Promise<RevokeOtherSessionsResult> {
  const res = await client.post<{ sessions_revoked?: number }>('/v1/client/sessions/revoke_all', {});
  return res.ok ? { ok: true, count: typeof res.data?.sessions_revoked === 'number' ? res.data.sessions_revoked : 0 } : failure(res);
}

// ---- Two-factor methods ----

/** A second factor on the account. `phone` is masked; the secret is never returned after enrolment. */
export interface MfaFactorSummary {
  id: string;
  /** `totp`, `sms`, `hotp`, `yubikey`, `duo`, `push`, ... */
  type: string;
  verified: boolean;
  phone?: string;
  publicId?: string;
  createdAt: number;
}

interface MfaFactorView {
  id: string;
  type: string;
  verified: boolean;
  phone?: string;
  public_id?: string;
  created_at: number;
}

const factorOf = (f: MfaFactorView): MfaFactorSummary => ({
  id: f.id,
  type: f.type,
  verified: f.verified,
  ...(f.phone ? { phone: f.phone } : {}),
  ...(f.public_id ? { publicId: f.public_id } : {}),
  createdAt: f.created_at,
});

export type MfaFactorsResult = { ok: true; factors: MfaFactorSummary[]; backupCodesRemaining: number } | SecurityFailure;

/** The user's second factors and how many recovery codes are left. */
export async function listMfaFactors(client: FapiClient): Promise<MfaFactorsResult> {
  const res = await client.get<{ data: MfaFactorView[]; backup_codes_remaining?: number }>('/v1/client/me/mfa');
  if (!res.ok || !res.data) return failure(res);
  return { ok: true, factors: res.data.data.map(factorOf), backupCodesRemaining: res.data.backup_codes_remaining ?? 0 };
}

/** A started authenticator-app enrolment. The secret is shown once: render `qrSvg` (trusted markup from the server) or `uri`, then verify. */
export interface TotpEnrollment {
  factorId: string;
  secret: string;
  /** The `otpauth://` URI. */
  uri: string;
  /** The URI as an inline SVG QR code. */
  qrSvg: string;
  /** How many consecutive codes {@link verifyTotp} must send (1 or 2). */
  requiredCodes: number;
}

export type StartTotpResult = { ok: true; enrollment: TotpEnrollment } | SecurityFailure;

/** Begin adding an authenticator app. Needs a recent sign-in: a stale session answers `stepUpRequired`. */
export async function startTotp(client: FapiClient): Promise<StartTotpResult> {
  const res = await client.post<{ id: string; secret: string; uri: string; qr_svg: string; required_codes?: number }>('/v1/client/me/mfa/totp', {});
  if (!res.ok || !res.data) return failure(res);
  const d = res.data;
  return { ok: true, enrollment: { factorId: d.id, secret: d.secret, uri: d.uri, qrSvg: d.qr_svg, requiredCodes: d.required_codes ?? 1 } };
}

export type VerifyFactorResult =
  | {
      ok: true;
      factor: MfaFactorSummary;
      /** One-time recovery codes, present when this factor was the account's first: show them now, they are not shown again. */
      backupCodes?: string[];
    }
  | SecurityFailure;

interface VerifiedFactorView extends MfaFactorView {
  backup_codes?: string[];
}

const verified = (d: VerifiedFactorView): VerifyFactorResult => ({
  ok: true,
  factor: factorOf(d),
  ...(d.backup_codes?.length ? { backupCodes: d.backup_codes } : {}),
});

/** Confirm an authenticator app with the code(s) it shows (`requiredCodes` consecutive ones). */
export async function verifyTotp(client: FapiClient, factorId: string, codes: string[]): Promise<VerifyFactorResult> {
  const res = await client.post<VerifiedFactorView>(`/v1/client/me/mfa/totp/${encodeURIComponent(factorId)}/verify`, { codes });
  return res.ok && res.data ? verified(res.data) : failure(res);
}

export type StartSmsResult = { ok: true; factorId: string; /** The number the code went to, masked. */ phone: string } | SecurityFailure;

/** Begin texted codes: texts a code to `phone` (E.164). Refused when the app offers no SMS factor. */
export async function startSms(client: FapiClient, phone: string): Promise<StartSmsResult> {
  const res = await client.post<MfaFactorView>('/v1/client/me/mfa/sms', { phone });
  return res.ok && res.data ? { ok: true, factorId: res.data.id, phone: res.data.phone ?? '' } : failure(res);
}

/** Confirm the texted number with the code that arrived. */
export async function verifySms(client: FapiClient, factorId: string, code: string): Promise<VerifyFactorResult> {
  const res = await client.post<VerifiedFactorView>(`/v1/client/me/mfa/sms/${encodeURIComponent(factorId)}/verify`, { code });
  return res.ok && res.data ? verified(res.data) : failure(res);
}

export type RemoveMfaFactorResult = { ok: true } | SecurityFailure;

/** Remove a second factor. Always needs a recent sign-in. */
export async function removeMfaFactor(client: FapiClient, factorId: string): Promise<RemoveMfaFactorResult> {
  const res = await client.request<unknown>(`/v1/client/me/mfa/${encodeURIComponent(factorId)}`, { method: 'DELETE' });
  return res.ok ? { ok: true } : failure(res);
}

export type RegenerateBackupCodesResult = { ok: true; codes: string[] } | SecurityFailure;

/** Replace the recovery codes with a new set (the old ones stop working at once). Show them now: they are not shown again. Always needs a recent sign-in. */
export async function regenerateBackupCodes(client: FapiClient): Promise<RegenerateBackupCodesResult> {
  const res = await client.post<{ codes: string[] }>('/v1/client/me/mfa/backup_codes', {});
  return res.ok && res.data ? { ok: true, codes: res.data.codes } : failure(res);
}

// ---- Passkeys and linked accounts ----

/** A passkey on the account (the credential id and key are never exposed). */
export interface AccountPasskey {
  id: string;
  name: string | null;
  backedUp: boolean;
  lastUsedAt: number | null;
  createdAt: number;
  /** The authenticator model's name and icon, when the instance resolves them. */
  authenticator: { name: string | null; icon: string | null } | null;
}

interface PasskeyView {
  id: string;
  name: string | null;
  backed_up: boolean;
  last_used_at: number | null;
  created_at: number;
  authenticator?: { name: string | null; icon: string | null } | null;
}

export type AccountPasskeysResult = { ok: true; passkeys: AccountPasskey[] } | SecurityFailure;

/** The signed-in user's passkeys. */
export async function listPasskeys(client: FapiClient): Promise<AccountPasskeysResult> {
  const res = await client.get<{ data: PasskeyView[] }>('/v1/client/me/passkeys');
  if (!res.ok || !res.data) return failure(res);
  return {
    ok: true,
    passkeys: res.data.data.map((p) => ({
      id: p.id,
      name: p.name,
      backedUp: p.backed_up,
      lastUsedAt: p.last_used_at,
      createdAt: p.created_at,
      authenticator: p.authenticator ?? null,
    })),
  };
}

export type RemovePasskeyResult = { ok: true } | SecurityFailure;

/** Remove a passkey. Needs a recent sign-in. */
export async function removePasskey(client: FapiClient, id: string): Promise<RemovePasskeyResult> {
  const res = await client.request<unknown>(`/v1/client/me/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' });
  return res.ok ? { ok: true } : failure(res);
}

export type UnlinkExternalAccountResult = { ok: true } | SecurityFailure;

/**
 * Unlink a connected sign-in provider. Needs a recent sign-in, and answers 409 `LAST_AUTH_METHOD`
 * when it is the account's only way in (set a password or connect another provider first).
 */
export async function unlinkExternalAccount(client: FapiClient, id: string): Promise<UnlinkExternalAccountResult> {
  const res = await client.request<unknown>(`/v1/client/me/external_accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  return res.ok ? { ok: true } : failure(res);
}

// ---- Notification preferences ----

/** One security-notification category and whether this user gets it. */
export interface NotificationPreference {
  category: string;
  label: string;
  enabled: boolean;
  /** False for a category that cannot be turned off (grey the toggle out). */
  optional: boolean;
}

export type NotificationPreferencesResult = { ok: true; preferences: NotificationPreference[] } | SecurityFailure;

/** The user's security-notification preferences, every category included. */
export async function getNotificationPreferences(client: FapiClient): Promise<NotificationPreferencesResult> {
  const res = await client.get<{ preferences: NotificationPreference[] }>('/v1/client/me/notification_preferences');
  return res.ok && res.data ? { ok: true, preferences: res.data.preferences } : failure(res);
}

/** Turn categories on or off, e.g. `{ new_device: false }`; returns the full resulting set. An unknown or non-optional category answers 400. */
export async function updateNotificationPreferences(client: FapiClient, preferences: Record<string, boolean>): Promise<NotificationPreferencesResult> {
  const res = await client.request<{ preferences: NotificationPreference[] }>('/v1/client/me/notification_preferences', {
    method: 'PATCH',
    body: JSON.stringify({ preferences }),
  });
  return res.ok && res.data ? { ok: true, preferences: res.data.preferences } : failure(res);
}
