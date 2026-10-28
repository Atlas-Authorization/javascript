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

/** One published instance signing key (`GET /v1/instance/signing_keys`). */
export interface SigningKey {
  object: 'signing_key';
  kid: string;
  alg: 'RS256' | 'ES256' | string;
  status: 'current' | 'previous';
  /** `main` signs every token; `secondary` signs access tokens for APIs set to the other algorithm. */
  role: 'main' | 'secondary';
  /** When a previous key leaves the JWKS (epoch ms); null for a current key. */
  retires_at: number | null;
  /** On the current main key: `local`, or the KMS that holds its private half. */
  provider?: 'local' | SigningKeyProviderKind;
}

/** The cloud key management services a signing key can live in. */
export type SigningKeyProviderKind = 'aws_kms' | 'gcp_kms' | 'azure_key_vault';

/** The instance's key management service (`GET /v1/instance/signing_key_provider`). Never carries credentials. */
export interface SigningKeyProviderSettings {
  object: 'signing_key_provider';
  id?: string;
  provider: 'local' | SigningKeyProviderKind;
  /** The non-secret settings (region, key / key ring / vault, algorithm). Null for `local`. */
  config: Record<string, unknown> | null;
  /** True when the current main key is in this KMS. */
  active: boolean;
  /** The KMS key version tokens are signed with (ARN, resource name or key id). */
  key_version: string | null;
  last_verified_at?: number | null;
  created_at?: number;
  updated_at?: number;
}

/**
 * Switch signing to a key in your own KMS. Config and credentials per provider:
 *  - `aws_kms`: config `{ region, key_id?, alg? }`, credentials `{ access_key_id, secret_access_key, session_token? }`
 *  - `gcp_kms`: config `{ crypto_key, key_version? }`, credentials `{ service_account_json }` (the key file)
 *  - `azure_key_vault`: config `{ vault_url, key_name, key_version?, alg? }`, credentials `{ tenant_id, client_id, client_secret }`
 * Without a key id / version Atlas creates a new key version in the KMS. Add
 * `config.secondary` for a second key of the other algorithm (aws: `{ alg, key_id? }`;
 * gcp: `{ crypto_key, key_version? }`; azure: `{ key_name, key_version?, alg }`).
 */
export interface SetSigningKeyProviderBody {
  provider: SigningKeyProviderKind;
  config: Record<string, unknown>;
  credentials: Record<string, unknown>;
  /** How long the previous key stays published (default 86400, at most 2592000). */
  grace_period_seconds?: number;
  /** Publish only the new key now. */
  emergency?: boolean;
}

export interface RotateSigningKeyBody {
  /** How long the previous key stays published (default 86400, at most 2592000). */
  grace_period_seconds?: number;
  /** Publish only the new key now (suspected compromise). */
  emergency?: boolean;
  /** The new main key's algorithm; omit to keep the current one. */
  alg?: 'RS256' | 'ES256';
  /** With keys in a key management service: rotate only the `main` or the `secondary` key (default both). */
  key?: 'main' | 'secondary';
}

export interface SigningKeyRotation {
  object: 'signing_key_rotation';
  kid: string;
  alg: 'RS256' | 'ES256';
  previous_kid: string | null;
  previous_retires_at: number | null;
  emergency: boolean;
  /** Where the key lives (`local` or the key management service). */
  provider?: 'local' | SigningKeyProviderKind;
  /** With keys in a key management service: the current second-algorithm key, if configured. */
  secondary_kid?: string | null;
}

export function instanceSecurityResource(request: RequestFn) {
  return {
    /** The published token-signing keys, newest first. */
    listSigningKeys(): Promise<{ object: 'list'; data: SigningKey[] }> {
      return request({ method: 'GET', path: '/v1/instance/signing_keys' });
    },
    /** Rotate the signing key (optionally switching between RS256 and ES256). */
    rotateSigningKey(body: RotateSigningKeyBody = {}): Promise<SigningKeyRotation> {
      return request({ method: 'POST', path: '/v1/instance/signing_keys/rotate', body });
    },
    /** The key management service the signing key lives in (`local` when none). */
    getSigningKeyProvider(): Promise<SigningKeyProviderSettings> {
      return request({ method: 'GET', path: '/v1/instance/signing_key_provider' });
    },
    /** Sign every token with a key in your own AWS KMS, Google Cloud KMS or Azure Key Vault. */
    setSigningKeyProvider(
      body: SetSigningKeyProviderBody,
    ): Promise<SigningKeyProviderSettings & { rotation: SigningKeyRotation }> {
      return request({ method: 'PUT', path: '/v1/instance/signing_key_provider', body });
    },
    /** Stop using the KMS: rotate back to a key Atlas holds and forget the credentials. */
    removeSigningKeyProvider(
      body: RotateSigningKeyBody = {},
    ): Promise<{ object: 'signing_key_provider'; provider: 'local'; deleted: true; rotation: SigningKeyRotation | null }> {
      return request({ method: 'DELETE', path: '/v1/instance/signing_key_provider', body });
    },
    get(): Promise<InstanceSecurity> {
      return request({ method: 'GET', path: '/v1/instance/security' });
    },
    update(body: UpdateInstanceSecurityBody): Promise<InstanceSecurityResult> {
      return request({ method: 'PATCH', path: '/v1/instance/security', body });
    },

    /** Store the captcha provider secret. Refused while the provider is `none`. */
    setCaptchaSecret(
      body: { secret: string; provider?: string },
    ): Promise<{ object: 'captcha_secret'; provider: string; set: true }> {
      return request({ method: 'PUT', path: '/v1/instance/captcha_secret', body });
    },
    deleteCaptchaSecret(): Promise<{ object: 'captcha_secret'; provider: string; deleted: true }> {
      return request({ method: 'DELETE', path: '/v1/instance/captcha_secret' });
    },
    /**
     * Store (write-only, encrypted) the wallet RPC endpoint for an EIP-155 chain
     * — used by wallet token gating and the Sign in with Ethereum ENS lookup. An
     * empty url removes it. The URL is never returned.
     */
    setWalletRpcSecret(body: {
      chain_id: number;
      url: string;
    }): Promise<{ object: 'wallet_rpc_secret'; chain_id: number; set: boolean }> {
      return request({ method: 'PUT', path: '/v1/instance/wallet_rpc_secret', body });
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
