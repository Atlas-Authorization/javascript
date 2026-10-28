import type { RequestFn } from './request';

export interface AttackProtection {
  object: 'attack_protection';
  brute_force: {
    enabled: boolean;
    tiers: Array<{
      threshold: number;
      window_ms: number;
      lock_ms: number;
      notify_user: boolean;
      flag_for_admin: boolean;
    }>;
  };
  breached_password: { enabled: boolean };
  suspicious_ip: {
    enabled: boolean;
    ip_allowlist: string[];
    managed_by: 'dashboard_security';
  };
  captcha: {
    provider: string;
    site_key_set: boolean;
    secret_set: boolean;
    managed_by: 'auth_config_and_captcha_secret';
  };
  /** Read-only reflections of auth_config.attackProtection. */
  country_restrictions?: {
    mode: 'off' | 'allow' | 'deny';
    countries: string[];
    sign_up: boolean;
    sign_in: boolean;
    block_unknown: boolean;
    managed_by: 'auth_config';
  };
  device_accounts?: { enabled: boolean; max_accounts: number; window_days: number; managed_by: 'auth_config' };
  /** Dormant-account reactivation alerts (writable). */
  dormant_accounts?: DormantAccountsSettings;
}

/**
 * When an account idle for `threshold_days` signs in again: an audit entry, the
 * `user.reactivated` webhook, an optional security notice to the user, and —
 * with `require_mfa` — a second-factor step-up (`on_no_factor` decides for an
 * account without one).
 */
export interface DormantAccountsSettings {
  enabled: boolean;
  /** 1–3650; default 90. */
  threshold_days: number;
  require_mfa: boolean;
  on_no_factor: 'allow' | 'require_enroll' | 'block';
  notify_user: boolean;
}

/** The writable parts; the rest of the object is read-only. */
export interface UpdateAttackProtectionBody {
  brute_force?: { enabled?: boolean };
  breached_password?: { enabled?: boolean };
  dormant_accounts?: Partial<DormantAccountsSettings>;
}

export function attackProtectionResource(request: RequestFn) {
  return {
    get(): Promise<AttackProtection> {
      return request({ method: 'GET', path: '/v1/attack_protection' });
    },
    update(body: UpdateAttackProtectionBody): Promise<AttackProtection> {
      return request({ method: 'PATCH', path: '/v1/attack_protection', body });
    },
    /** Store the Play Integrity response-decryption key (base64 AES-256) for app attestation. Write-only. */
    /** Store the Play Integrity decryption key (default) or, with kind 'devicecheck', the Apple DeviceCheck .p8 key. Write-only. */
    setAppAttestationSecret(secret: string, kind: 'play_integrity' | 'devicecheck' = 'play_integrity'): Promise<{ object: 'app_attestation_secret'; set: true }> {
      return request({ method: 'PUT', path: '/v1/attack_protection/app_attestation_secret', body: { secret, kind } });
    },
    removeAppAttestationSecret(kind: 'play_integrity' | 'devicecheck' = 'play_integrity'): Promise<{ object: 'app_attestation_secret'; deleted: true }> {
      return request({ method: 'DELETE', path: '/v1/attack_protection/app_attestation_secret', query: { kind } });
    },
  };
}
