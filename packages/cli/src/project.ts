import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createConfigHttp, type ConfigHttp } from './config-http';
import type { RunContext } from './context';
import { CliError } from './errors';
import { productDir, readEnvFile } from './secrets';

/**
 * The project manifest `atlas init` keeps at `~/.config/<product>/atlas.json`:
 * PUBLIC values only (ids, publishable key, hosts, redirect URIs) plus the path
 * of each secret file. `atlas env`, `atlas preflight --instance` and
 * `atlas client rotate` read it, so they know where a secret lives without
 * ever holding it in the manifest.
 */

export type InstanceEnv = 'development' | 'production';

export interface ProjectInstance {
  instance_id: string;
  environment: InstanceEnv;
  publishable_key: string;
  frontend_api_host: string | null;
  issuer: string | null;
  discovery_url: string | null;
  jwks_uri: string | null;
  /** The file holding ATLAS_SECRET_KEY. */
  secret_file: string;
  oauth_client?: { id: string; client_id: string; redirect_uris: string[]; secret_file: string | null };
  webhook?: { id: string; url: string; secret_file: string | null };
  custom_domain?: { host: string; cname_target: string | null; status: string };
  email?: { mode: 'managed' | 'development' | 'none'; from_address?: string | null };
}

export interface ProjectManifest {
  product: string;
  api_url: string;
  instances: Partial<Record<InstanceEnv, ProjectInstance>>;
}

export const MANIFEST_FILE = 'atlas.json';

export function manifestPath(env: NodeJS.ProcessEnv, product: string): string {
  return join(productDir(env, product), MANIFEST_FILE);
}

export function readManifest(env: NodeJS.ProcessEnv, product: string): ProjectManifest | undefined {
  try {
    return JSON.parse(readFileSync(manifestPath(env, product), 'utf8')) as ProjectManifest;
  } catch {
    return undefined;
  }
}

export function writeManifest(env: NodeJS.ProcessEnv, manifest: ProjectManifest): string {
  const dir = productDir(env, manifest.product);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, MANIFEST_FILE);
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** Find the project + instance an instance id belongs to, scanning every product directory. */
export function findInstance(
  env: NodeJS.ProcessEnv,
  instanceId: string,
  product?: string,
): { manifest: ProjectManifest; instance: ProjectInstance } | undefined {
  const products = product ? [product] : listProducts(env);
  for (const p of products) {
    const m = readManifest(env, p);
    for (const inst of Object.values(m?.instances ?? {})) {
      if (inst && inst.instance_id === instanceId) return { manifest: m!, instance: inst };
    }
  }
  return undefined;
}

function listProducts(env: NodeJS.ProcessEnv): string[] {
  const base = env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.config');
  try {
    return readdirSync(base).filter((d) => {
      try {
        readFileSync(join(base, d, MANIFEST_FILE));
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

export function parseInstanceEnv(raw: string | undefined, fallback: InstanceEnv): InstanceEnv {
  if (raw === undefined) return fallback;
  if (raw !== 'development' && raw !== 'production') {
    throw new CliError(`--instance-env must be development or production, got '${raw}'.`);
  }
  return raw;
}

/** The raw HTTP client for a credential (the context's, or the real one). */
export function httpFor(ctx: RunContext, opts: { secretKey: string; apiUrl: string; headers?: Record<string, string> }): ConfigHttp {
  return (ctx.makeHttp ?? createConfigHttp)(opts);
}

/** Read the instance secret key from the project's secret file. */
export function instanceSecretFromFile(instance: ProjectInstance): string {
  const key = readEnvFile(instance.secret_file)?.ATLAS_SECRET_KEY;
  if (!key) {
    throw new CliError(
      `No ATLAS_SECRET_KEY in ${instance.secret_file}. Re-run 'atlas init' with --rotate-secret to mint a new one.`,
    );
  }
  return key;
}
