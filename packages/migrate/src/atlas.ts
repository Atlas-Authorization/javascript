import type { MigrationSource } from './schema';
import type { ImportPublicKey } from './transport';

/**
 * A minimal Atlas Backend API client for an exporter: fetch the instance's
 * import public key for a source, and upload + finalize a sealed bundle
 * through `/v1/migrations/{source}/imports`. Plain fetch, no dependencies; the
 * full surface lives in `@atlasauth/backend` (`migrations.imports`).
 *
 * Only the Atlas secret key travels to Atlas. Vendor credentials an exporter
 * uses to read the vendor's API never leave the machine it runs on.
 */

export const DEFAULT_ATLAS_API_URL = 'https://api.atlasauth.net';

/** Bytes per uploaded part (the API takes at most 10 MiB). Parts end on a line boundary. */
export const UPLOAD_PART_BYTES = 8 * 1024 * 1024;

export interface AtlasApiOptions {
  /** A secret key (`sk_test_…` / `sk_live_…`) with the `jobs:write` scope. */
  secretKey: string;
  /** Default https://api.atlasauth.net (or ATLAS_API_BASE / ATLAS_API_URL). */
  apiUrl?: string;
  fetch?: typeof fetch;
}

export class AtlasApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'AtlasApiError';
  }
}

/** The import path for a source: `/v1/migrations/{source}/imports`. */
export function importsPath(source: MigrationSource): string {
  return `/v1/migrations/${encodeURIComponent(source)}/imports`;
}

async function call<T>(opts: AtlasApiOptions, method: string, path: string, body?: unknown): Promise<T> {
  const f = opts.fetch ?? fetch;
  const env = typeof process !== 'undefined' ? process.env : {};
  const base = (opts.apiUrl ?? (env.ATLAS_API_BASE?.trim() || env.ATLAS_API_URL?.trim() || DEFAULT_ATLAS_API_URL)).replace(/\/+$/, '');
  const res = await f(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${opts.secretKey}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = (json as { errors?: Array<{ code?: string; message?: string }> } | null)?.errors?.[0];
    throw new AtlasApiError(res.status, err?.code ?? null, err?.message ?? `Atlas answered ${res.status}.`);
  }
  return json as T;
}

/** The instance's import public key (created on first request). One key serves every source. */
export async function fetchMigrationImportKey(
  opts: AtlasApiOptions & { source: MigrationSource },
): Promise<ImportPublicKey & { alg: string; fingerprint: string }> {
  const r = await call<{ kid: string; public_key: string; alg: string; fingerprint: string }>(opts, 'GET', `${importsPath(opts.source)}/public_key`);
  return { kid: r.kid, publicKey: r.public_key, alg: r.alg, fingerprint: r.fingerprint };
}

/** An Atlas migration import, as the API returns it (see `@atlasauth/backend` for the full type). */
export interface MigrationImportObject {
  object: 'migration_import';
  id: string;
  source: MigrationSource;
  status: string;
  [k: string]: unknown;
}

/** Split a sealed bundle into upload parts on line boundaries. */
export function splitIntoParts(text: string, maxBytes = UPLOAD_PART_BYTES): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    const n = Buffer.byteLength(line, 'utf8') + 1;
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

/**
 * Upload a sealed bundle (its text) and finalize it: Atlas opens and checks it
 * and prepares the dry-run report. Nothing is imported until the import is
 * applied. `resumeFrom` skips parts already uploaded to `importId`.
 */
export async function uploadMigrationBundle(
  opts: AtlasApiOptions & {
    source: MigrationSource;
    text: string;
    options?: Record<string, unknown>;
    importId?: string;
    resumeFrom?: number;
    onPart?: (n: number, of: number) => void;
  },
): Promise<MigrationImportObject> {
  const base = importsPath(opts.source);
  const parts = splitIntoParts(opts.text);
  const id =
    opts.importId ??
    (await call<MigrationImportObject>(opts, 'POST', base, opts.options ? { options: opts.options } : {})).id;
  for (let i = Math.max(0, (opts.resumeFrom ?? 1) - 1); i < parts.length; i++) {
    await call(opts, 'PUT', `${base}/${encodeURIComponent(id)}/parts/${i + 1}`, { data: parts[i] });
    opts.onPart?.(i + 1, parts.length);
  }
  return call<MigrationImportObject>(opts, 'POST', `${base}/${encodeURIComponent(id)}/finalize`, {});
}
