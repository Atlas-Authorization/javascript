import { enc, type RequestFn } from './request';

/**
 * §5/§11.2 instance security config — the agent mirror of the dashboard security
 * screen. Settings that live OUTSIDE `auth_config` (so a raw `PATCH /v1/instance`
 * cannot reach them): the per-flow kill switches, the customer IP allowlist, and
 * the write-only provider secrets (captcha, Kerberos proxy, LDAP bind password),
 * and the trusted reverse proxy secret. No secret is ever readable back.
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

/**
 * The trusted reverse proxy secret: with it, a proxy that serves the Frontend
 * API from your own origin sends `X-Atlas-Proxy-Secret` + `X-Atlas-Client-IP`,
 * and Atlas uses the browser's IP for rate limits, lockout, risk signals, geo,
 * audit logs and session metadata. Never returned after creation.
 */
export interface ProxySecret {
  object: 'proxy_secret';
  /** Whether a proxy secret is set. */
  set: boolean;
  /** When the current secret was created (epoch ms), or null. */
  created_at: number | null;
  /** After a rotation: when the replaced secret stops working (epoch ms), or null. */
  previous_expires_at: number | null;
  secret_header: 'X-Atlas-Proxy-Secret';
  client_ip_header: 'X-Atlas-Client-IP';
}

/** Create / rotate result: the secret, shown only here. */
export interface ProxySecretCreated extends ProxySecret {
  /** `aps_…`. Store it in your proxy's environment; Atlas keeps only a hash. */
  secret: string;
  /** true when an existing secret was replaced. */
  rotated: boolean;
}

export interface CreateProxySecretBody {
  /** On rotation: seconds the replaced secret keeps working. Default 86400, 0 = stop now, at most 604800. */
  overlap_seconds?: number | null;
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

    /** Whether a trusted reverse proxy secret is set (never the secret). */
    getProxySecret(): Promise<ProxySecret> {
      return request({ method: 'GET', path: '/v1/instance/proxy_secret' });
    },
    /** Create, or rotate (with `overlap_seconds`), the trusted reverse proxy secret. The secret is returned once. */
    createProxySecret(body: CreateProxySecretBody = {}): Promise<ProxySecretCreated> {
      return request({ method: 'POST', path: '/v1/instance/proxy_secret', body });
    },
    /** Remove the proxy secret: `X-Atlas-Client-IP` is ignored again. */
    deleteProxySecret(): Promise<{ object: 'proxy_secret'; deleted: true }> {
      return request({ method: 'DELETE', path: '/v1/instance/proxy_secret' });
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
