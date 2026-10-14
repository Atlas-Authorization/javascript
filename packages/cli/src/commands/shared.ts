import { DEFAULT_API_URL } from '@atlasauth/backend';
import { str, type Values } from '../args';
import type { ManagementClient, RunContext } from '../context';
import { CliError } from '../errors';

/**
 * A credential resolved for one invocation, plus where each half came from —
 * the source is what `whoami` reports so a user can tell a stored key from an
 * env override.
 */
export interface ResolvedAuth {
  profile: string;
  apiUrl: string;
  secretKey: string;
  keySource: 'env' | 'config';
  urlSource: 'env' | 'config' | 'default';
}

/**
 * Resolve which credential to use, with env overrides winning over the stored
 * profile — the same precedence `auth0-cli` and most cloud CLIs use, so a CI
 * job can set `ATLAS_SECRET_KEY` without a `login` step. Throws a clean error
 * (not a stack) when nothing supplies a key.
 */
export function resolveAuth(ctx: RunContext, values: Values): ResolvedAuth {
  const file = ctx.config.load();
  const profile = str(values, 'profile') || file.active_profile || 'default';
  const stored = file.profiles[profile];

  const envKey = ctx.env.ATLAS_SECRET_KEY?.trim();
  const secretKey = envKey || stored?.secret_key;
  if (!secretKey) {
    throw new CliError(
      `Not logged in (profile '${profile}'). Run 'atlas login'` +
        (str(values, 'profile') ? ` --profile ${profile}` : '') +
        ' or set ATLAS_SECRET_KEY.',
    );
  }

  const envUrl = ctx.env.ATLAS_API_URL?.trim();
  const apiUrl = envUrl || stored?.api_url || DEFAULT_API_URL;

  return {
    profile,
    apiUrl,
    secretKey,
    keySource: envKey ? 'env' : 'config',
    urlSource: envUrl ? 'env' : stored?.api_url ? 'config' : 'default',
  };
}

/** Resolve the credential and build the Backend API client bound to it. */
export function requireClient(ctx: RunContext, values: Values): {
  client: ManagementClient;
  auth: ResolvedAuth;
} {
  const auth = resolveAuth(ctx, values);
  return { client: ctx.makeClient({ secretKey: auth.secretKey, apiUrl: auth.apiUrl }), auth };
}

/** True when `--json` was passed. */
export function wantsJson(values: Values): boolean {
  return values.json === true;
}

/** The first positional after the resource word — e.g. an id for `users get <id>`. */
export function requireArg(positionals: string[], index: number, name: string): string {
  const value = positionals[index];
  if (!value) throw new CliError(`Missing required argument: <${name}>.`);
  return value;
}

/** Mask a secret for display: keep the `sk_live_`-style prefix and the last 4. */
export function maskSecret(key: string): string {
  if (key.length <= 12) return '****';
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}
