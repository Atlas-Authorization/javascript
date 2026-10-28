import { splitBundleParts, type BetterAuthImport, type BetterAuthImportKey, type BetterAuthImportOptions } from '@atlasauth/backend';
import type { ConfigHttp } from '../../config-http';

/**
 * Every call the Better Auth migration makes into the import and session-bridge
 * APIs lives in this one module:
 *
 *  - the export/import pair: the `@atlasauth/better-auth-migrate` exporter seals
 *    a bundle to the instance's import key (`GET /v1/better_auth_imports/public_key`),
 *    which is uploaded in line-split parts, finalized (which runs the dry run)
 *    and applied under `/v1/better_auth_imports`, and
 *  - the session bridge (`/v1/migrations/better_auth/bridge`), which lets a live
 *    Better Auth session become an Atlas session during the cutover window.
 */

/** The exporter's documented command line. */
export const EXPORTER_BIN = 'atlas-better-auth-export';
export const EXPORTER_PACKAGE = '@atlasauth/better-auth-migrate';

/** `publicKey` is the key's compact `kid:public_key` form. */
export function exporterCommand(opts: { out: string; publicKey: string }): { cmd: string; args: string[]; display: string } {
  const args = ['--yes', EXPORTER_BIN, '--out', opts.out, '--public-key', opts.publicKey];
  return { cmd: 'npx', args, display: `npx ${EXPORTER_BIN} --out ${opts.out} --public-key ${opts.publicKey}` };
}

/** The import key the exporter seals the bundle to (the private half stays with Atlas), as `kid:public_key`. */
export async function getImportPublicKey(http: ConfigHttp): Promise<string> {
  const key = await http.get<BetterAuthImportKey>('/v1/better_auth_imports/public_key');
  if (!key?.compact) throw new Error('The instance did not return an import key.');
  return key.compact;
}

export type ImportJob = BetterAuthImport;

/** Statuses an import rests in; anything else is still being worked on. */
export const RESTING_STATUSES: readonly string[] = ['uploading', 'ready', 'invalid', 'completed', 'failed'];

const importPath = (id: string, sub = '') => `/v1/better_auth_imports/${encodeURIComponent(id)}${sub}`;

/**
 * Upload a sealed bundle: create the import, send it in line-split parts of at
 * most 8 MiB, then finalize (which checks the parts and the key and runs the
 * dry run; a large bundle comes back `analyzing` and finishes in the background).
 */
export async function uploadBundle(
  http: ConfigHttp,
  opts: { bundle: string; options?: BetterAuthImportOptions; onPart?: (n: number, of: number) => void },
): Promise<ImportJob> {
  const parts = splitBundleParts(opts.bundle);
  if (parts.length === 0) throw new Error('The bundle is empty.');
  const created = await http.post<ImportJob>('/v1/better_auth_imports', opts.options ? { options: opts.options } : {});
  for (let i = 0; i < parts.length; i++) {
    await http.put(importPath(created.id, `/parts/${i + 1}`), { data: parts[i] });
    opts.onPart?.(i + 1, parts.length);
  }
  return http.post<ImportJob>(importPath(created.id, '/finalize'), {});
}

export async function getImport(http: ConfigHttp, id: string): Promise<ImportJob> {
  return http.get<ImportJob>(importPath(id));
}

/** Finalize an import whose upload finished but was never finalized. */
export async function finalizeImport(http: ConfigHttp, id: string): Promise<ImportJob> {
  return http.post<ImportJob>(importPath(id, '/finalize'), {});
}

/** Apply a dry-run-ready import, or resume a failed one from where it stopped. */
export async function applyImport(http: ConfigHttp, id: string, opts: { confirmConflicts: boolean }): Promise<ImportJob> {
  return http.post<ImportJob>(importPath(id, '/apply'), opts.confirmConflicts ? { confirm_conflicts: true } : {});
}

export interface BridgeSettings {
  /** Better Auth's `advanced.cookiePrefix` (default `better-auth`). */
  cookiePrefix: string;
  /** When the bridge stops accepting Better Auth sessions (epoch ms). */
  endsAt: number;
}

/**
 * Turn the Better Auth session bridge on for a window. The old app's Better
 * Auth secret is stored write-only so Atlas can check the cookie signature
 * (the live fallback to the old app stays off unless set up separately).
 */
export async function enableSessionBridge(http: ConfigHttp, settings: BridgeSettings, secret: string): Promise<void> {
  await http.put('/v1/migrations/better_auth/bridge', {
    enabled: true,
    ends_at: settings.endsAt,
    cookie_prefix: settings.cookiePrefix,
    live_fallback: { secret },
  });
}
