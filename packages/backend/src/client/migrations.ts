import { splitBundleParts, type BetterAuthImportActionItem } from './better-auth-imports';
import { enc, type RequestFn } from './request';
import type { CursorPage, CursorParams } from './types';

/**
 * Migrate to Atlas from any source: the vendor-neutral surface every vendor
 * plugs into (`{source}`: `auth0`, `clerk`, `cognito`, `firebase`, …,
 * `better_auth`, `custom`).
 *
 *   imports  `/v1/migrations/{source}/imports` — a sealed migration bundle
 *            (`@atlasauth/migrate`, or `atlas migrate export <vendor>`):
 *            `getPublicKey()`, `upload()` (create + parts + finalize), read the
 *            `report`, `apply()`; applying again after a failure resumes.
 *   bridge   `/v1/migrations/{source}/bridge` — the zero-logout bridge settings
 *            (a vendor JWT preset, or imported sessions).
 *   sources  `/v1/migrations/sources` — what each source supports.
 */

export type MigrationSourceId =
  | 'better_auth'
  | 'auth0'
  | 'clerk'
  | 'cognito'
  | 'firebase'
  | 'supabase'
  | 'workos'
  | 'authjs'
  | 'okta'
  | 'stytch'
  | 'keycloak'
  | 'fusionauth'
  | 'kinde'
  | 'descope'
  | 'lucia'
  | 'ory'
  | 'frontegg'
  | 'propelauth'
  | 'magic'
  | 'userfront'
  | 'corbado'
  | 'custom';

export type MigrationImportStatus = 'uploading' | 'analyzing' | 'ready' | 'invalid' | 'queued' | 'applying' | 'completed' | 'failed';

export interface MigrationImportKey {
  object: 'migration_import_key';
  kid: string;
  /** base64url raw X25519 public key. One key serves every source. */
  public_key: string;
  alg: 'X25519-HKDF-SHA256-A256GCM';
  status: 'active' | 'retired';
  fingerprint: string;
  /** `kid:public_key`, the form the exporters take. */
  compact: string;
  created_at: number;
  retired_at: number | null;
}

/** Options of a non-Better-Auth import (a `better_auth` import takes {@link BetterAuthImportOptions}). */
export interface MigrationImportOptions {
  models?: Array<'organization' | 'role' | 'user' | 'identity' | 'mfa_factor' | 'passkey' | 'membership' | 'invitation' | 'api_key' | 'sso_connection' | 'jwks' | 'session'>;
  on_email_conflict?: 'skip' | 'link';
  create_app_roles?: boolean;
  import_oauth_tokens?: boolean;
  passkeys_on_rp_mismatch?: 'skip' | 'import';
  import_sessions?: boolean;
  import_jwks?: boolean;
  jwks_cutover_days?: number;
  /** Source provider name → Atlas provider key. */
  provider_map?: Record<string, string>;
  /** Hash parameters that live outside the export, per algorithm id (Firebase signer key …). */
  password_hash_params?: Record<string, Record<string, string | number | boolean>>;
  retain_bundle?: boolean;
  [option: string]: unknown;
}

interface MigrationReportCommon {
  skipped: Array<{ model: string; row_id: string | null; reason_code: string; reason: string }>;
  skipped_total: number;
  skipped_by_code: Record<string, number>;
  conflicts: Array<{ model: string; row_id: string | null; code: string; message: string; resolution: 'merge' | 'skip'; existing_id: string | null }>;
  conflicts_total: number;
  action_items: BetterAuthImportActionItem[];
  warnings: string[];
  notes: Record<string, unknown>;
}

export interface MigrationImportReport extends MigrationReportCommon {
  models: Array<{ model: string; label: string; found: number; will_create: number; will_update: number; will_skip: number }>;
  /** Users per password-hash algorithm. */
  password_algorithms?: Record<string, number>;
}

export interface MigrationImportResult extends MigrationReportCommon {
  models: Array<{ model: string; label: string; found: number; created: number; updated: number; unchanged: number; skipped: number; failed: number }>;
  completed_at: number | null;
}

export interface MigrationImport {
  object: 'migration_import';
  id: string;
  source: MigrationSourceId;
  format: 'atlas-migration-bundle' | 'atlas-better-auth-bundle';
  status: MigrationImportStatus;
  key_id: string | null;
  parts: number;
  bytes: number;
  bundle_sha256: string | null;
  bundle_purged: boolean;
  options: Record<string, unknown>;
  manifest: {
    exported_at: string;
    exporter: { name: string; version: string };
    origin: string | null;
    source_version: string | null;
    models: string[];
    providers: string[];
    rp_id: string | null;
    warnings: string[];
  } | null;
  total: number;
  progress: { total: number; processed: number; succeeded: number; failed: number; percent: number } | null;
  report: MigrationImportReport | null;
  result: MigrationImportResult | null;
  error: { code: string; message: string } | null;
  created_at: number;
  updated_at: number;
  analyzed_at: number | null;
  apply_started_at: number | null;
  completed_at: number | null;
}

export interface MigrationClaimMap {
  subject?: string;
  email?: string;
  email_verified?: string;
  name?: string;
  session_key?: string;
  mfa?: string;
}

/** PUT body of the bridge settings; every field optional, merged onto the stored ones. */
export interface MigrationBridgeSettingsUpdate {
  enabled?: boolean;
  ends_at?: string | number | null;
  mode?: 'jwt' | 'session_table' | 'remote';
  preset?: string | null;
  preset_vars?: Record<string, string>;
  issuer?: string | null;
  jwks_url?: string | null;
  audience?: string[] | null;
  algorithms?: string[] | null;
  claim_map?: MigrationClaimMap;
  expired_grace_seconds?: number;
  cookie_names?: string[];
  create_users?: boolean;
  /** Write-only HS256 secret; omit to keep, null to clear. */
  shared_secret?: string | null;
}

export interface MigrationBridgeSettings {
  object: 'migration_bridge';
  source: MigrationSourceId;
  enabled: boolean;
  ends_at: number | null;
  mode: 'jwt' | 'session_table' | 'remote';
  preset: string | null;
  preset_vars: Record<string, string>;
  issuer: string | null;
  jwks_url: string | null;
  audience: string[] | null;
  algorithms: string[];
  claim_map: Record<string, string>;
  expired_grace_seconds: number;
  cookie_names: string[];
  create_users: boolean;
  has_shared_secret: boolean;
  exchange_path: string;
  stats: { exchanged: number; from_import: number; from_jwt: number };
  created_at: number | null;
  updated_at: number | null;
}

export interface MigrationSourceView {
  object: 'migration_source';
  source: MigrationSourceId;
  label: string;
  models: string[];
  passwords: 'export' | 'ticket' | 'lazy' | 'none';
  export_via: Array<'api' | 'file' | 'database' | 'support_ticket'>;
  bridge: { mode: 'jwt' | 'session_table' | 'remote' | 'none'; preset: string | null; vars: Record<string, string>; cookies: string[] };
  lazy_migration: { preset: string; config: Record<string, { label: string; required: boolean }>; secret: { label: string; required: boolean } | null } | null;
  password_algorithms: string[];
  limits: string | null;
}

const TERMINAL: readonly MigrationImportStatus[] = ['ready', 'invalid', 'completed', 'failed'];

export function migrationsResource(request: RequestFn) {
  const importsFor = (source: MigrationSourceId | string) => {
    const base = `/v1/migrations/${enc(source)}/imports`;
    const self = {
      /** The import public key (created on first read; shared by every source). */
      getPublicKey(): Promise<MigrationImportKey> {
        return request({ method: 'GET', path: `${base}/public_key` });
      },
      /** Replace the import key; bundles sealed to the old one no longer finalize. */
      rotatePublicKey(): Promise<MigrationImportKey> {
        return request({ method: 'POST', path: `${base}/public_key/rotate` });
      },
      create(body: { options?: MigrationImportOptions } = {}, idempotencyKey?: string): Promise<MigrationImport> {
        return request({ method: 'POST', path: base, body, idempotencyKey });
      },
      list(params: CursorParams = {}): Promise<CursorPage<MigrationImport>> {
        return request({ method: 'GET', path: base, query: { ...params } });
      },
      get(id: string): Promise<MigrationImport> {
        return request({ method: 'GET', path: `${base}/${enc(id)}` });
      },
      /** Upload part `part` (1-based) of the sealed bundle text. */
      uploadPart(id: string, part: number, data: string): Promise<{ object: 'migration_import_part'; import_id: string; part: number; bytes: number; sha256: string }> {
        return request({ method: 'PUT', path: `${base}/${enc(id)}/parts/${part}`, body: { data } });
      },
      /** Close the upload; Atlas checks the key and the format, then runs the dry run. */
      finalize(id: string): Promise<MigrationImport> {
        return request({ method: 'POST', path: `${base}/${enc(id)}/finalize` });
      },
      dryRun(id: string, body: { options?: MigrationImportOptions } = {}): Promise<MigrationImport> {
        return request({ method: 'POST', path: `${base}/${enc(id)}/dry_run`, body });
      },
      /** Import (or resume). Pass confirm_conflicts when the dry run reported conflicts. */
      apply(id: string, body: { confirm_conflicts?: boolean } = {}): Promise<MigrationImport> {
        return request({ method: 'POST', path: `${base}/${enc(id)}/apply`, body });
      },
      delete(id: string): Promise<{ object: 'migration_import'; id: string; deleted: true }> {
        return request({ method: 'DELETE', path: `${base}/${enc(id)}` });
      },
      /**
       * Create an import (or continue `importId`), upload the sealed bundle text
       * in parts from `resumeFrom` (1-based) and finalize it.
       */
      async upload(
        bundleText: string,
        opts: { options?: MigrationImportOptions; partBytes?: number; importId?: string; resumeFrom?: number; onPart?: (n: number, of: number) => void } = {},
      ): Promise<MigrationImport> {
        const parts = splitBundleParts(bundleText, opts.partBytes);
        if (parts.length === 0) throw new Error('The bundle is empty.');
        const id = opts.importId ?? (await self.create(opts.options ? { options: opts.options } : {})).id;
        for (let i = Math.max(0, (opts.resumeFrom ?? 1) - 1); i < parts.length; i++) {
          await self.uploadPart(id, i + 1, parts[i]!);
          opts.onPart?.(i + 1, parts.length);
        }
        return self.finalize(id);
      },
      /** Poll until the import leaves analyzing / queued / applying. */
      async waitFor(
        id: string,
        opts: { intervalMs?: number; timeoutMs?: number; onProgress?: (imp: MigrationImport) => void; sleep?: (ms: number) => Promise<void> } = {},
      ): Promise<MigrationImport> {
        const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
        const deadline = Date.now() + (opts.timeoutMs ?? 6 * 3600_000);
        for (;;) {
          const imp = await self.get(id);
          opts.onProgress?.(imp);
          if (TERMINAL.includes(imp.status) || imp.status === 'uploading') return imp;
          if (Date.now() > deadline) throw new Error(`Timed out waiting for migration import ${id} (status ${imp.status}).`);
          await sleep(opts.intervalMs ?? 2000);
        }
      },
    };
    return self;
  };
  const bridgeFor = (source: MigrationSourceId | string) => {
    const path = `/v1/migrations/${enc(source)}/bridge`;
    return {
      get(): Promise<MigrationBridgeSettings> {
        return request({ method: 'GET', path });
      },
      update(body: MigrationBridgeSettingsUpdate): Promise<MigrationBridgeSettings> {
        return request({ method: 'PUT', path, body });
      },
      delete(): Promise<{ object: 'migration_bridge'; source: string; deleted: true }> {
        return request({ method: 'DELETE', path });
      },
    };
  };
  return {
    /** Every migration source and what it supports. */
    sources(): Promise<CursorPage<MigrationSourceView>> {
      return request({ method: 'GET', path: '/v1/migrations/sources' });
    },
    /** The import surface of one source: `migrations.imports('auth0').upload(text)`. */
    imports: importsFor,
    /** The zero-logout bridge settings of one source. */
    bridge: bridgeFor,
  };
}

