import { readFile } from 'node:fs/promises';
import type { ImportPublicKey } from './transport';

/**
 * A minimal Atlas Backend API client for the two calls an export script needs:
 * fetch the instance's import public key, and upload a sealed bundle. It is
 * deliberately tiny (plain fetch) so the exporter has no dependencies; the
 * full surface lives in `@atlasauth/backend` (`betterAuthImports`) and the
 * `atlas import --from better-auth --bundle` command.
 */

export const DEFAULT_ATLAS_API_URL = 'https://api.atlasauth.net';

/** Bytes per uploaded part. Parts always end on a line boundary. */
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

async function call<T>(opts: AtlasApiOptions, method: string, path: string, body?: unknown): Promise<T> {
  const f = opts.fetch ?? fetch;
  const base = (opts.apiUrl ?? (process.env.ATLAS_API_BASE?.trim() || process.env.ATLAS_API_URL?.trim() || DEFAULT_ATLAS_API_URL)).replace(/\/+$/, '');
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

/** The instance's import public key (created on first request). */
export async function fetchImportKey(opts: AtlasApiOptions): Promise<ImportPublicKey & { alg: string }> {
  const r = await call<{ kid: string; public_key: string; alg: string }>(opts, 'GET', '/v1/better_auth_imports/public_key');
  return { kid: r.kid, publicKey: r.public_key, alg: r.alg };
}

/** An Atlas Better Auth import, as the API returns it. */
export interface BetterAuthImportObject {
  object: 'better_auth_import';
  id: string;
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
      parts.push(current.join('\n') + '\n');
      current = [];
      size = 0;
    }
    current.push(line);
    size += n;
  }
  if (current.length) parts.push(current.join('\n') + '\n');
  return parts;
}

/**
 * Upload a sealed bundle file and finalize it: Atlas decrypts and checks it and
 * prepares the dry-run report. Nothing is imported until you apply the import.
 */
export async function uploadBundle(
  opts: AtlasApiOptions & { path: string; onPart?: (n: number, of: number) => void },
): Promise<BetterAuthImportObject> {
  const text = await readFile(opts.path, 'utf8');
  const parts = splitIntoParts(text);
  const created = await call<BetterAuthImportObject>(opts, 'POST', '/v1/better_auth_imports', {});
  for (let i = 0; i < parts.length; i++) {
    await call(opts, 'PUT', `/v1/better_auth_imports/${encodeURIComponent(created.id)}/parts/${i + 1}`, { data: parts[i] });
    opts.onPart?.(i + 1, parts.length);
  }
  return call<BetterAuthImportObject>(opts, 'POST', `/v1/better_auth_imports/${encodeURIComponent(created.id)}/finalize`, {});
}
