import type { AtlasMcpServerOptions } from './server';

/**
 * Environment variable names this server reads. Kept as named constants so the
 * CLI, the docs, and any test reference the one source of truth.
 */
export const ENV = {
  /** Instance secret key (`sk_...`). Required unless a `backend` is embedded. */
  SECRET_KEY: 'ATLAS_SECRET_KEY',
  /** Atlas Backend-API base URL (optional; the client has a sensible default). */
  API_URL: 'ATLAS_API_URL',
  /** Comma-separated allowlist of tool NAMES; authoritative over scopes. */
  ALLOWED_TOOLS: 'ATLAS_MCP_ALLOWED_TOOLS',
  /** Comma-separated `resource:verb` scope grants. */
  SCOPES: 'ATLAS_MCP_SCOPES',
} as const;

/** Split a comma/whitespace list into trimmed, non-empty entries, or `undefined`. */
function parseList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // An empty/whitespace value yields `undefined`, not `[]`: an empty
  // `allowedTools` list would mean "expose nothing", which is almost never what
  // a blank env var intends — treat it as "unset" so scopes/defaults still apply.
  return items.length > 0 ? items : undefined;
}

/**
 * Pull one `--flag value` or `--flag=value` out of an argv slice. Returns the
 * value, or `undefined` when the flag is absent. CLI flags, when present, take
 * precedence over the corresponding environment variable.
 */
function parseFlag(argv: readonly string[], flag: string): string | undefined {
  const prefix = `${flag}=`;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === flag) return argv[i + 1];
    if (arg !== undefined && arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

/**
 * Resolve server options from the environment and CLI arguments — the entry the
 * stdio CLI uses. CLI flags (`--secret-key`, `--api-url`, `--allowed-tools`,
 * `--scopes`) override the matching env var ({@link ENV}). This does NOT throw on
 * a missing secret key; `createAtlasMcpServer`/`createAtlasToolkit` raise a clear
 * error at build time, keeping the "where do options come from" and "are they
 * valid" concerns separate.
 */
export function resolveOptions(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
): AtlasMcpServerOptions {
  const secretKey = parseFlag(argv, '--secret-key') ?? env[ENV.SECRET_KEY];
  const apiUrl = parseFlag(argv, '--api-url') ?? env[ENV.API_URL];
  const allowedTools = parseList(parseFlag(argv, '--allowed-tools') ?? env[ENV.ALLOWED_TOOLS]);
  const scopes = parseList(parseFlag(argv, '--scopes') ?? env[ENV.SCOPES]);

  return { secretKey, apiUrl, allowedTools, scopes };
}
