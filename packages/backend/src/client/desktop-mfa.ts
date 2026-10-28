import { enc, type RequestFn } from './request';

export type DesktopMfaFactor = 'push' | 'totp' | 'passkey';

/** Who must pass a second factor at workstation login, with which factors, and how long offline unlock lasts. */
export interface DesktopMfaPolicy {
  object: 'desktop_mfa_policy';
  enabled: boolean;
  applies_to: 'all' | 'selected';
  user_ids: string[];
  org_ids: string[];
  allowed_factors: DesktopMfaFactor[];
  offline_enabled: boolean;
  offline_grace_hours: number;
  offline_pin_required: boolean;
  /** `account`: any passkey the user holds answers the passkey factor. `device`: only keys registered through that workstation. */
  passkey_scope: 'account' | 'device';
  /** Relying-party domain the agents use; null uses the application's passkey RP id. */
  passkey_rp_id: string | null;
  passkey_require_uv: boolean;
  /** Device-bound SSO (macOS Platform SSO, Windows broker) accepts registrations and logins. */
  device_sso_enabled: boolean;
  device_sso_session_minutes: number;
  device_sso_refresh_days: number;
}

/** A device registered for device-bound SSO. */
export interface DeviceSsoRegistration {
  object: 'device_sso_registration';
  id: string;
  user_id: string;
  platform: 'macos' | 'windows';
  hostname: string | null;
  agent_version: string | null;
  status: 'active' | 'revoked';
  signing_key_id: string;
  user_key_registered: boolean;
  user_key_method: 'user_secure_enclave_key' | 'user_tpm_key' | null;
  local_username: string | null;
  last_login_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

/** A passkey registered through a workstation. It answers the desktop passkey factor and never a web sign-in. */
export interface DesktopPasskey {
  object: 'desktop_passkey';
  id: string;
  device_id: string;
  user_id: string;
  name: string | null;
  aaguid: string | null;
  transports: string[];
  backed_up: boolean;
  last_used_at: number | null;
  created_at: number;
}

export type UpdateDesktopMfaPolicyBody = Partial<Omit<DesktopMfaPolicy, 'object'>>;

/** A workstation running the Atlas Windows or macOS login agent. */
export interface DesktopDevice {
  object: 'desktop_device';
  id: string;
  user_id: string;
  device_key_id: string;
  hostname: string | null;
  platform: 'windows' | 'macos' | 'linux';
  agent_version: string | null;
  status: 'active' | 'revoked';
  offline_pin_set: boolean;
  /** Raised to void every offline verifier issued so far. */
  bundle_generation: number;
  last_seen_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

export interface DesktopDeviceDetail extends DesktopDevice {
  offline_bundles: Array<{ id: string; generation: number; issued_at: number; expires_at: number; revoked_at: number | null }>;
}

export interface DesktopEnrolmentCode {
  object: 'desktop_enrolment_code';
  /** Shown once. The user types it into the workstation agent. */
  code: string;
  expires_at: number;
  user_id: string;
}

/** Desktop-login MFA: policy, enrolment codes and enrolled workstations. */
export function desktopMfaResource(request: RequestFn) {
  return {
    getPolicy(): Promise<DesktopMfaPolicy> {
      return request({ method: 'GET', path: '/v1/desktop_mfa/policy' });
    },
    /** Send only the fields to change. */
    updatePolicy(body: UpdateDesktopMfaPolicyBody): Promise<DesktopMfaPolicy> {
      return request({ method: 'PUT', path: '/v1/desktop_mfa/policy', body });
    },
    /** A single-use code for a user to enrol a workstation (default 60 minutes, at most 7 days). */
    createEnrolmentCode(body: { user_id: string; expires_in_minutes?: number }): Promise<DesktopEnrolmentCode> {
      return request({ method: 'POST', path: '/v1/desktop_mfa/enrolment_codes', body });
    },
    listDevices(query: { user_id?: string } = {}): Promise<{ object: 'list'; data: DesktopDevice[]; has_more: boolean }> {
      return request({ method: 'GET', path: '/v1/desktop_mfa/devices', query });
    },
    getDevice(id: string): Promise<DesktopDeviceDetail> {
      return request({ method: 'GET', path: `/v1/desktop_mfa/devices/${enc(id)}` });
    },
    listDevicePasskeys(id: string): Promise<{ object: 'list'; data: DesktopPasskey[]; has_more: boolean }> {
      return request({ method: 'GET', path: `/v1/desktop_mfa/devices/${enc(id)}/passkeys` });
    },
    deleteDevicePasskey(id: string, passkeyId: string): Promise<{ object: 'desktop_passkey'; id: string; deleted: boolean }> {
      return request({ method: 'DELETE', path: `/v1/desktop_mfa/devices/${enc(id)}/passkeys/${enc(passkeyId)}` });
    },
    /** The workstation's next call is refused and it wipes its offline cache. */
    revokeDevice(id: string): Promise<DesktopDevice> {
      return request({ method: 'POST', path: `/v1/desktop_mfa/devices/${enc(id)}/revoke` });
    },
    /** Void every offline verifier without revoking the workstation; it gets a fresh one on its next sync. */
    revokeOfflineCache(id: string): Promise<DesktopDevice> {
      return request({ method: 'POST', path: `/v1/desktop_mfa/devices/${enc(id)}/revoke_offline_cache` });
    },
    deleteDevice(id: string): Promise<{ object: 'desktop_device'; id: string; deleted: boolean }> {
      return request({ method: 'DELETE', path: `/v1/desktop_mfa/devices/${enc(id)}` });
    },
    /** Devices registered for device-bound SSO (macOS Platform SSO, Windows broker). */
    listDeviceSsoRegistrations(query: { user_id?: string } = {}): Promise<{ object: 'list'; data: DeviceSsoRegistration[]; has_more: boolean }> {
      return request({ method: 'GET', path: '/v1/device_sso/registrations', query });
    },
    getDeviceSsoRegistration(id: string): Promise<DeviceSsoRegistration> {
      return request({ method: 'GET', path: `/v1/device_sso/registrations/${enc(id)}` });
    },
    /** Ends every session the device holds and refuses its next call. */
    revokeDeviceSsoRegistration(id: string): Promise<DeviceSsoRegistration> {
      return request({ method: 'POST', path: `/v1/device_sso/registrations/${enc(id)}/revoke` });
    },
    deleteDeviceSsoRegistration(id: string): Promise<{ object: 'device_sso_registration'; id: string; deleted: boolean }> {
      return request({ method: 'DELETE', path: `/v1/device_sso/registrations/${enc(id)}` });
    },
  };
}
