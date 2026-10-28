import { type RequestFn } from './request';
import type { CursorPage, CursorParams } from './types';

const enc = encodeURIComponent;

/** Encrypted object storage for your own secrets (not a password vault). */
export interface VaultObject {
  object: 'vault_object';
  id: string;
  name: string;
  /** The mandatory labels bound into the encryption. */
  key_context: Record<string, string>;
  metadata: Record<string, unknown>;
  /** The current version number. */
  version: number;
  /** `atlas`, or the customer KMS wrapping the current version's data key. */
  key_provider: string;
  created_at: number;
  updated_at: number;
}

export interface VaultObjectWithValue extends VaultObject {
  value: string;
}

export interface VaultObjectVersion {
  object: 'vault_object_version';
  version: number;
  current: boolean;
  key_provider: string;
  created_at: number;
}

export interface CreateVaultObjectBody {
  name: string;
  /** Up to 64 KiB. */
  value: string;
  /** 1–10 string labels; the value can only be opened under this context. */
  key_context: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface ListVaultObjectsParams extends CursorParams {
  name_prefix?: string;
  /** Match objects whose context contains every label. Sent as JSON. */
  key_context?: Record<string, string>;
}

export interface VaultKeyProvider {
  object: 'vault_key_provider';
  id: string;
  provider: 'aws_kms' | 'gcp_kms' | 'azure_key_vault';
  config: Record<string, unknown>;
  updated_at: number;
}

export interface SetVaultKeyProviderBody {
  provider: 'aws_kms' | 'gcp_kms' | 'azure_key_vault';
  /** aws_kms: `{region, key_id}`; gcp_kms: `{crypto_key}`; azure_key_vault: `{vault_url, key_name, key_version?}`. */
  config: Record<string, unknown>;
  /** Write-only. */
  credentials: Record<string, unknown>;
}

export function vaultResource(request: RequestFn) {
  return {
    create(body: CreateVaultObjectBody, idempotencyKey?: string): Promise<VaultObject> {
      return request({ method: 'POST', path: '/v1/vault/objects', body, idempotencyKey });
    },
    /** Metadata only, newest first. */
    list(params: ListVaultObjectsParams = {}): Promise<CursorPage<VaultObject>> {
      const { key_context, ...rest } = params;
      return request({
        method: 'GET',
        path: '/v1/vault/objects',
        query: { ...rest, ...(key_context ? { key_context: JSON.stringify(key_context) } : {}) },
      });
    },
    /** The decrypted value of the current version, or of `version`. Audited. */
    read(id: string, version?: number): Promise<VaultObjectWithValue> {
      return request({ method: 'GET', path: `/v1/vault/objects/${enc(id)}`, query: version ? { version } : undefined });
    },
    metadata(id: string): Promise<VaultObject> {
      return request({ method: 'GET', path: `/v1/vault/objects/${enc(id)}/metadata` });
    },
    versions(id: string): Promise<{ object: 'list'; data: VaultObjectVersion[] }> {
      return request({ method: 'GET', path: `/v1/vault/objects/${enc(id)}/versions` });
    },
    /** Append a version. Pass `version_check` (the version you read) to fail with 409 on a concurrent update. */
    update(id: string, body: { value: string; version_check?: number }): Promise<VaultObject> {
      return request({ method: 'PUT', path: `/v1/vault/objects/${enc(id)}`, body });
    },
    delete(id: string): Promise<{ object: 'vault_object.deleted'; id: string; deleted: boolean }> {
      return request({ method: 'DELETE', path: `/v1/vault/objects/${enc(id)}` });
    },
    /** Bring your own AWS KMS, Google Cloud KMS or Azure Key Vault key for new versions. */
    keyProvider: {
      get(): Promise<VaultKeyProvider> {
        return request({ method: 'GET', path: '/v1/vault/key_provider' });
      },
      set(body: SetVaultKeyProviderBody): Promise<VaultKeyProvider> {
        return request({ method: 'PUT', path: '/v1/vault/key_provider', body });
      },
      remove(): Promise<{ object: 'vault_key_provider.deleted'; deleted: boolean }> {
        return request({ method: 'DELETE', path: '/v1/vault/key_provider' });
      },
    },
    /**
     * Customer-managed encryption of everything Atlas stores for the instance: a data key wrapped by the KMS key set in
     * `keyProvider`. If the KMS key is revoked, Atlas fails closed (503 CUSTOMER_KEY_UNAVAILABLE).
     */
    dataKeyProvider: {
      get(): Promise<DataKeyProviderStatus> {
        return request({ method: 'GET', path: '/v1/instance/data_key_provider' });
      },
      enable(): Promise<DataKeyProviderStatus> {
        return request({ method: 'POST', path: '/v1/instance/data_key_provider' });
      },
      /** How long a loaded data key may be used without your KMS confirming it, in seconds (60 to 3,600; default 300). */
      setCacheWindow(cacheWindowSeconds: number): Promise<DataKeyProviderStatus> {
        return request({ method: 'PUT', path: '/v1/instance/data_key_provider', body: { cache_window_seconds: cacheWindowSeconds } });
      },
      rotate(): Promise<DataKeyProviderStatus> {
        return request({ method: 'POST', path: '/v1/instance/data_key_provider/rotate' });
      },
      /** Re-wrap data keys onto the provider as configured now; pass `previous` when the old key is no longer configured. */
      rewrap(body: { previous?: SetVaultKeyProviderBody } = {}): Promise<{ object: 'data_key_rewrap'; data_keys: number; vault_versions: number; skipped: number }> {
        return request({ method: 'POST', path: '/v1/instance/data_key_provider/rewrap', body });
      },
      check(): Promise<{ object: 'data_key_health'; ok: boolean; reason: string | null; message: string | null; checked_at: number }> {
        return request({ method: 'POST', path: '/v1/instance/data_key_provider/check' });
      },
      /** Crypto-shreds the data protected by the key. Irreversible. */
      remove(): Promise<{ object: 'data_key_provider.deleted'; deleted: boolean }> {
        return request({ method: 'DELETE', path: '/v1/instance/data_key_provider', body: { confirm: 'shred' } });
      },
    },
  };
}

export interface DataKeyProviderStatus {
  object: 'data_key_provider';
  enabled: boolean;
  provider: string | null;
  key_versions: Array<{ version: number; current: boolean; key: string; created_at: number }>;
  current_version: number | null;
  health: { ok: boolean | null; checked_at: number | null; error: string | null } | null;
  /** How long a revoked key keeps working before Atlas fails closed. */
  fail_closed_after_seconds: number;
  cache_window_seconds: number;
  cache_window_min_seconds: number;
  cache_window_max_seconds: number;
}
