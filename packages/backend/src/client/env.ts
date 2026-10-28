import { createAtlasClient, type AtlasClient } from './index';
import { DEFAULT_API_URL, type AtlasClientConfig } from './request';

/** The environment names the SDK, the CLI and the generated env files all accept for the API base URL. */
export const API_BASE_ENV_NAMES = ['ATLAS_API_BASE', 'ATLAS_API_URL'] as const;

type Env = Record<string, string | undefined>;

function processEnv(): Env {
  return (globalThis as { process?: { env?: Env } }).process?.env ?? {};
}

/**
 * The Backend API base URL from the environment. `ATLAS_API_BASE` and
 * `ATLAS_API_URL` are both accepted (the first one set wins; blank values are
 * ignored), so code written against either name keeps working.
 */
export function apiBaseFromEnv(env: Env = processEnv()): string | undefined {
  for (const name of API_BASE_ENV_NAMES) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** A client config from `ATLAS_SECRET_KEY` plus the optional API base (`ATLAS_API_BASE` or `ATLAS_API_URL`). */
export function atlasConfigFromEnv(env: Env = processEnv(), overrides: Partial<AtlasClientConfig> = {}): AtlasClientConfig {
  const secretKey = overrides.secretKey ?? env.ATLAS_SECRET_KEY?.trim();
  if (!secretKey) throw new Error('@atlasauth/backend: missing ATLAS_SECRET_KEY.');
  return { ...overrides, secretKey, apiUrl: overrides.apiUrl ?? apiBaseFromEnv(env) ?? DEFAULT_API_URL };
}

/** `createAtlasClient(atlasConfigFromEnv(env))`: the one-liner for server code that configures itself from the environment. */
export function createAtlasClientFromEnv(env: Env = processEnv(), overrides: Partial<AtlasClientConfig> = {}): AtlasClient {
  return createAtlasClient(atlasConfigFromEnv(env, overrides));
}
