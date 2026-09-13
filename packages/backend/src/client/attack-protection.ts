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
}

/** Only the two flags are writable; the rest of the object is read-only. */
export interface UpdateAttackProtectionBody {
  brute_force?: { enabled?: boolean };
  breached_password?: { enabled?: boolean };
}

export function attackProtectionResource(request: RequestFn) {
  return {
    get(): Promise<AttackProtection> {
      return request({ method: 'GET', path: '/v1/attack_protection' });
    },
    update(body: UpdateAttackProtectionBody): Promise<AttackProtection> {
      return request({ method: 'PATCH', path: '/v1/attack_protection', body });
    },
  };
}
