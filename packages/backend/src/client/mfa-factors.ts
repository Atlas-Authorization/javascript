import { enc, type RequestFn } from './request';

/** An existing second factor to import with a user (`atlas.users.create({ mfa })`). */
export interface ImportedMfa {
  /** An authenticator-app secret. SHA1, SHA256 or SHA512; 6 or 8 digits; 30 or 60 second step. */
  totp?: {
    secret_base32: string;
    algorithm?: 'SHA1' | 'SHA256' | 'SHA512';
    digits?: 6 | 8;
    period?: 30 | 60;
    verified_at?: number | string;
  };
  /** A counter-based (HOTP) token. Give `totp` or `hotp`, not both. */
  hotp?: {
    secret_base32: string;
    algorithm?: 'SHA1' | 'SHA256' | 'SHA512';
    digits?: 6 | 8;
    /** The next counter the token will produce. Default 0. */
    counter?: number;
    verified_at?: number | string;
  };
  /** Plaintext recovery codes; they are hashed on import. */
  backup_codes?: string[];
}

export type SmartCardMappingKind = 'san_email' | 'san_upn' | 'subject_cn' | 'serial' | 'fingerprint';

export interface Yubikey {
  object: 'yubikey';
  id: string;
  public_id: string;
  label: string | null;
  user_id: string | null;
  has_private_id: boolean;
  last_counter: number | null;
  created_at: number;
}

export interface SmartCardMapping {
  object: 'smartcard_mapping';
  id: string;
  user_id: string;
  kind: SmartCardMappingKind;
  value: string;
  label: string | null;
  last_used_at: number | null;
  created_at: number;
}

type SecretSet<T extends string> = { object: T; set: true };
type SecretDeleted<T extends string> = { object: T; deleted: true };

/**
 * The additional authentication factors: the write-only BYOK secrets (Yubico cloud, Duo, the
 * smart card proxy), the self-held Yubico OTP key registry, smart card certificate mappings and
 * the admin reset for security questions. Turn the factors on in the auth config (`mfa.factors`,
 * `mfa.hotp`, `mfa.yubikey`, `mfa.duo`, `mfa.smartCard`, `mfa.securityQuestions`).
 */
export function mfaFactorsResource(request: RequestFn) {
  return {
    /** Store the Yubico cloud API secret key (base64). Write-only. */
    setYubicoSecret(secret: string): Promise<SecretSet<'yubico_secret'>> {
      return request({ method: 'PUT', path: '/v1/instance/yubico_secret', body: { secret } });
    },
    removeYubicoSecret(): Promise<SecretDeleted<'yubico_secret'>> {
      return request({ method: 'DELETE', path: '/v1/instance/yubico_secret' });
    },
    /** Store the Duo client secret. Write-only. */
    setDuoSecret(secret: string): Promise<SecretSet<'duo_secret'>> {
      return request({ method: 'PUT', path: '/v1/instance/duo_secret', body: { secret } });
    },
    removeDuoSecret(): Promise<SecretDeleted<'duo_secret'>> {
      return request({ method: 'DELETE', path: '/v1/instance/duo_secret' });
    },
    /** Ask Duo whether the configured integration key, stored secret and API host are accepted. */
    duoHealthCheck(): Promise<{ object: 'duo_health_check'; ok: boolean; message: string }> {
      return request({ method: 'POST', path: '/v1/instance/duo_health_check' });
    },
    /** Store the shared secret your TLS proxy sends so Atlas trusts its certificate headers. Write-only. */
    setSmartCardSecret(secret: string): Promise<SecretSet<'smart_card_secret'>> {
      return request({ method: 'PUT', path: '/v1/instance/smart_card_secret', body: { secret } });
    },
    removeSmartCardSecret(): Promise<SecretDeleted<'smart_card_secret'>> {
      return request({ method: 'DELETE', path: '/v1/instance/smart_card_secret' });
    },

    yubikeys: {
      /** Registered self-held YubiKeys. The AES keys are never returned. */
      list(): Promise<{ object: 'list'; data: Yubikey[] }> {
        return request({ method: 'GET', path: '/v1/yubikeys' });
      },
      /** Register a YubiKey's AES key for self-held Yubico OTP. `userId` assigns it; otherwise the first user to enrol it claims it. */
      register(body: { publicId: string; aesKey: string; privateId?: string; label?: string; userId?: string }): Promise<Yubikey> {
        return request({
          method: 'POST',
          path: '/v1/yubikeys',
          body: { public_id: body.publicId, aes_key: body.aesKey, private_id: body.privateId, label: body.label, user_id: body.userId },
        });
      },
      remove(id: string): Promise<{ object: 'yubikey'; id: string; deleted: true }> {
        return request({ method: 'DELETE', path: `/v1/yubikeys/${enc(id)}` });
      },
    },

    smartCardMappings: {
      list(userId: string): Promise<{ object: 'list'; data: SmartCardMapping[] }> {
        return request({ method: 'GET', path: `/v1/users/${enc(userId)}/smartcard_mappings` });
      },
      /** Pre-register the certificate attribute that signs a user in. A `serial` needs the certificate's `issuer` DN. */
      add(userId: string, body: { kind: SmartCardMappingKind; value: string; issuer?: string; label?: string }): Promise<SmartCardMapping> {
        return request({ method: 'POST', path: `/v1/users/${enc(userId)}/smartcard_mappings`, body });
      },
      remove(userId: string, mappingId: string): Promise<{ object: 'smartcard_mapping'; id: string; deleted: true }> {
        return request({ method: 'DELETE', path: `/v1/users/${enc(userId)}/smartcard_mappings/${enc(mappingId)}` });
      },
    },

    /** Clear a user's security-question answers (and any lockout). */
    resetSecurityQuestions(userId: string): Promise<{ object: 'security_questions'; user_id: string; deleted: boolean }> {
      return request({ method: 'DELETE', path: `/v1/users/${enc(userId)}/security_questions` });
    },
  };
}
