import { enc, type RequestFn } from './request';
import type { CursorPage, CursorParams } from './types';

/**
 * Migrate from Better Auth: import a sealed bundle made by
 * `@atlasauth/better-auth-migrate` (`npx atlas-better-auth-export`).
 *
 *   1. `getPublicKey()` — the key the exporter seals the bundle to.
 *   2. `create()`, `uploadPart()` for each part, `finalize()` — or `upload()`
 *      for all three. Atlas opens the bundle and runs the dry run.
 *   3. Read the import's `report`, then `apply()`. Applying again after a
 *      failure resumes where it stopped; every record is an idempotent upsert.
 */

export type BetterAuthImportStatus =
  | 'uploading'
  | 'analyzing'
  | 'ready'
  | 'invalid'
  | 'queued'
  | 'applying'
  | 'completed'
  | 'failed';

export interface BetterAuthImportKey {
  object: 'better_auth_import_key';
  kid: string;
  /** base64url raw X25519 public key. */
  public_key: string;
  alg: 'X25519-HKDF-SHA256-A256GCM';
  status: 'active' | 'retired';
  /** SHA-256 of the raw key, first 16 bytes as hex pairs. */
  fingerprint: string;
  /** `kid:public_key`, the form `--public-key` takes. */
  compact: string;
  created_at: number;
  retired_at: number | null;
}

export interface BetterAuthImportOptions {
  models?: string[];
  on_email_conflict?: 'skip' | 'link';
  default_role?: string;
  create_app_roles?: boolean;
  import_oauth_tokens?: boolean;
  passkeys_on_rp_mismatch?: 'skip' | 'import';
  import_subscriptions?: boolean;
  plan_map?: Record<string, string>;
  import_jwks?: boolean;
  jwks_cutover_days?: number;
  import_sessions?: boolean;
  retain_bundle?: boolean;
}

export interface BetterAuthImportActionItem {
  code: string;
  severity: 'required' | 'recommended' | 'info';
  message: string;
  count: number;
  items: string[];
}

interface ReportCommon {
  skipped: Array<{ model: string; row_id: string | null; reason_code: string; reason: string }>;
  skipped_total: number;
  skipped_by_code: Record<string, number>;
  conflicts: Array<{ model: string; row_id: string | null; code: string; message: string; resolution: 'merge' | 'skip'; existing_id: string | null; value?: string }>;
  conflicts_total: number;
  action_items: BetterAuthImportActionItem[];
  warnings: string[];
  notes: Record<string, unknown>;
}

export interface BetterAuthImportReport extends ReportCommon {
  models: Array<{ model: string; label: string; found: number; will_create: number; will_update: number; will_skip: number }>;
}

export interface BetterAuthImportResult extends ReportCommon {
  models: Array<{ model: string; label: string; found: number; created: number; updated: number; unchanged: number; skipped: number; failed: number }>;
  completed_at: number | null;
}

export interface BetterAuthImport {
  object: 'better_auth_import';
  id: string;
  status: BetterAuthImportStatus;
  key_id: string | null;
  parts: number;
  bytes: number;
  bundle_sha256: string | null;
  bundle_purged: boolean;
  options: BetterAuthImportOptions;
  source: {
    exported_at: string;
    exporter: { name: string; version: string };
    better_auth_version: string | null;
    base_url: string | null;
    plugins: string[];
    models: string[];
    rp_id: string | null;
    social_providers: string[];
  } | null;
  total: number;
  progress: { total: number; processed: number; succeeded: number; failed: number; percent: number } | null;
  report: BetterAuthImportReport | null;
  result: BetterAuthImportResult | null;
  error: { code: string; message: string } | null;
  created_at: number;
  updated_at: number;
  analyzed_at: number | null;
  apply_started_at: number | null;
  completed_at: number | null;
}

export interface ImportedJwk {
  object: 'imported_jwk';
  kid: string;
  source: string;
  jwk: Record<string, unknown>;
  import_id: string | null;
  expires_at: number | null;
  created_at: number;
}

/** Bytes per uploaded part (the API takes at most 10 MiB). Parts end on a line boundary. */
export const BETTER_AUTH_IMPORT_PART_BYTES = 8 * 1024 * 1024;

/** Split a sealed bundle's text into upload parts on line boundaries. */
export function splitBundleParts(text: string, maxBytes = BETTER_AUTH_IMPORT_PART_BYTES): string[] {
  const enc8 = new TextEncoder();
  const parts: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    const n = enc8.encode(line).length + 1;
    if (size > 0 && size + n > maxBytes) {
      parts.push(`${current.join('\n')}\n`);
      current = [];
      size = 0;
    }
    current.push(line);
    size += n;
  }
  if (current.length) parts.push(`${current.join('\n')}\n`);
  return parts;
}

const TERMINAL: readonly BetterAuthImportStatus[] = ['ready', 'invalid', 'completed', 'failed'];

export function betterAuthImportsResource(request: RequestFn) {
  const base = '/v1/better_auth_imports';
  const self = {
    /** The import public key (created on first read). */
    getPublicKey(): Promise<BetterAuthImportKey> {
      return request({ method: 'GET', path: `${base}/public_key` });
    },
    /** Replace the import key; bundles sealed to the old one no longer finalize. */
    rotatePublicKey(): Promise<BetterAuthImportKey> {
      return request({ method: 'POST', path: `${base}/public_key/rotate` });
    },
    create(body: { options?: BetterAuthImportOptions } = {}, idempotencyKey?: string): Promise<BetterAuthImport> {
      return request({ method: 'POST', path: base, body, idempotencyKey });
    },
    list(params: CursorParams = {}): Promise<CursorPage<BetterAuthImport>> {
      return request({ method: 'GET', path: base, query: { ...params } });
    },
    get(id: string): Promise<BetterAuthImport> {
      return request({ method: 'GET', path: `${base}/${enc(id)}` });
    },
    /** Upload part `part` (1-based) of the sealed bundle text. */
    uploadPart(id: string, part: number, data: string): Promise<{ object: 'better_auth_import_part'; import_id: string; part: number; bytes: number; sha256: string }> {
      return request({ method: 'PUT', path: `${base}/${enc(id)}/parts/${part}`, body: { data } });
    },
    /** Close the upload; Atlas checks the key and runs the dry run. */
    finalize(id: string): Promise<BetterAuthImport> {
      return request({ method: 'POST', path: `${base}/${enc(id)}/finalize` });
    },
    /** Run the dry run again, optionally with new options. */
    dryRun(id: string, body: { options?: BetterAuthImportOptions } = {}): Promise<BetterAuthImport> {
      return request({ method: 'POST', path: `${base}/${enc(id)}/dry_run`, body });
    },
    /** Import (or resume). Pass confirm_conflicts when the dry run reported conflicts. */
    apply(id: string, body: { confirm_conflicts?: boolean } = {}): Promise<BetterAuthImport> {
      return request({ method: 'POST', path: `${base}/${enc(id)}/apply`, body });
    },
    delete(id: string): Promise<{ object: 'better_auth_import'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `${base}/${enc(id)}` });
    },
    /** Better Auth JWT keys published in the instance JWKS for the cutover. */
    listJwks(): Promise<CursorPage<ImportedJwk>> {
      return request({ method: 'GET', path: `${base}/jwks` });
    },
    deleteJwk(kid: string): Promise<{ object: 'imported_jwk'; kid: string; deleted: true }> {
      return request({ method: 'DELETE', path: `${base}/jwks/${enc(kid)}` });
    },
    /** Create an import, upload the sealed bundle text in parts and finalize it. */
    async upload(
      bundleText: string,
      opts: { options?: BetterAuthImportOptions; partBytes?: number; onPart?: (n: number, of: number) => void } = {},
    ): Promise<BetterAuthImport> {
      const parts = splitBundleParts(bundleText, opts.partBytes);
      if (parts.length === 0) throw new Error('The bundle is empty.');
      const created = await self.create(opts.options ? { options: opts.options } : {});
      for (let i = 0; i < parts.length; i++) {
        await self.uploadPart(created.id, i + 1, parts[i]!);
        opts.onPart?.(i + 1, parts.length);
      }
      return self.finalize(created.id);
    },
    /** Poll until the import leaves analyzing / queued / applying. */
    async waitFor(
      id: string,
      opts: { intervalMs?: number; timeoutMs?: number; onProgress?: (imp: BetterAuthImport) => void; sleep?: (ms: number) => Promise<void> } = {},
    ): Promise<BetterAuthImport> {
      const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      const deadline = Date.now() + (opts.timeoutMs ?? 6 * 3600_000);
      for (;;) {
        const imp = await self.get(id);
        opts.onProgress?.(imp);
        if (TERMINAL.includes(imp.status) || imp.status === 'uploading') return imp;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for Better Auth import ${id} (status ${imp.status}).`);
        await sleep(opts.intervalMs ?? 2000);
      }
    },
  };
  return self;
}
