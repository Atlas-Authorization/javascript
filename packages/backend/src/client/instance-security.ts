import { enc, type RequestFn } from './request';

/**
 * §5/§11.2 instance security config — the agent mirror of the dashboard security
 * screen. Settings that live OUTSIDE `auth_config` (so a raw `PATCH /v1/instance`
 * cannot reach them): the per-flow kill switches, the customer IP allowlist, and
 * the write-only provider secrets (captcha, Kerberos proxy, LDAP bind password).
 * No secret is ever readable back.
 */

export interface InstanceKillSwitches {
  /** Refuse sign-ups for this instance only. */
  disableSignUps?: boolean;
  /** Refuse all sign-ins for this instance — the heaviest per-tenant control. */
  disableSignIns?: boolean;
  /** Require a bot challenge for this instance only. */
  forceChallenge?: boolean;
  /** Provider keys temporarily refused (e.g. a provider outage). */
  disabledProviders?: string[];
}

export interface InstanceSecurity {
  object: 'instance_security';
  kill_switches: InstanceKillSwitches;
  ip_allowlist: string[];
}

export interface UpdateInstanceSecurityBody {
  kill_switches?: InstanceKillSwitches;
  /** CIDRs / IPs; `[]` clears the allowlist. Every entry is validated. */
  ip_allowlist?: string[];
  /**
   * Required to set an allowlist that omits the caller's own IP — which would
   * lock THIS management API out irreversibly. Otherwise such a list is a 422.
   */
  confirm_lockout?: boolean;
}

/** A confirmed self-lockout returns the config plus a plain-language `warning`. */
export interface InstanceSecurityResult extends InstanceSecurity {
  warning?: string;
}

export function instanceSecurityResource(request: RequestFn) {
  return {
    get(): Promise<InstanceSecurity> {
      return request({ method: 'GET', path: '/v1/instance/security' });
    },
    update(body: UpdateInstanceSecurityBody): Promise<InstanceSecurityResult> {
      return request({ method: 'PATCH', path: '/v1/instance/security', body });
    },

    /** Store the captcha provider secret. Refused while the provider is `none`. */
    setCaptchaSecret(
      body: { secret: string },
    ): Promise<{ object: 'captcha_secret'; provider: string; set: true }> {
      return request({ method: 'PUT', path: '/v1/instance/captcha_secret', body });
    },
    deleteCaptchaSecret(): Promise<{ object: 'captcha_secret'; provider: string; deleted: true }> {
      return request({ method: 'DELETE', path: '/v1/instance/captcha_secret' });
    },

    /** Store the Kerberos/IWA trusted-proxy secret. Refused while the strategy is off. */
    setKerberosSecret(body: { secret: string }): Promise<{ object: 'kerberos_secret'; set: true }> {
      return request({ method: 'PUT', path: '/v1/instance/kerberos_secret', body });
    },
    deleteKerberosSecret(): Promise<{ object: 'kerberos_secret'; deleted: true }> {
      return request({ method: 'DELETE', path: '/v1/instance/kerberos_secret' });
    },

    /** Store an LDAP connection's service-account bind password. The connection
     *  must already exist in `auth_config.ldap.connections`. */
    setLdapBindPassword(
      connectionId: string,
      body: { bind_password: string },
    ): Promise<{ object: 'ldap_bind_password'; connection_id: string; set: true }> {
      return request({
        method: 'PUT',
        path: `/v1/instance/ldap_connections/${enc(connectionId)}/bind_password`,
        body,
      });
    },
    deleteLdapBindPassword(
      connectionId: string,
    ): Promise<{ object: 'ldap_bind_password'; connection_id: string; deleted: true }> {
      return request({
        method: 'DELETE',
        path: `/v1/instance/ldap_connections/${enc(connectionId)}/bind_password`,
      });
    },
  };
}
