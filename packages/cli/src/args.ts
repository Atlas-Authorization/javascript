import { parseArgs } from 'node:util';
import { CliError } from './errors';

/**
 * The single option schema for the whole CLI. parseArgs in `strict` mode rejects
 * an unknown flag for us (turned into a clean {@link CliError} below), so every
 * flag any command accepts must appear here once. Per-command validation of
 * which flags actually apply happens in the handler.
 */
const OPTIONS = {
  // Global.
  json: { type: 'boolean' },
  profile: { type: 'string' },
  limit: { type: 'string' },
  'starting-after': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  // login (non-interactive overrides for the prompts).
  url: { type: 'string' },
  'secret-key': { type: 'string' },
  // users create.
  email: { type: 'string' },
  'first-name': { type: 'string' },
  'last-name': { type: 'string' },
  password: { type: 'string' },
  // api-keys.
  'subject-type': { type: 'string' },
  'subject-id': { type: 'string' },
  name: { type: 'string' },
  // config export / import.
  dir: { type: 'string' },
  format: { type: 'string' },
  'dry-run': { type: 'boolean' },
  prune: { type: 'boolean' },
  // actions.
  trigger: { type: 'string' },
  // init / preflight / env / client rotate.
  product: { type: 'string' },
  domain: { type: 'string' },
  'auth-host': { type: 'string' },
  'instance-env': { type: 'string' },
  strategies: { type: 'string' },
  'email-from': { type: 'string' },
  // The customer's own email provider key: from a file (or '-' for stdin), never argv.
  'email-provider': { type: 'string' },
  'email-key-file': { type: 'string' },
  'client-redirect': { type: 'string', multiple: true },
  'webhook-url': { type: 'string' },
  yes: { type: 'boolean', short: 'y' },
  force: { type: 'boolean' },
  'rotate-secret': { type: 'boolean' },
  instance: { type: 'string' },
  'fail-on': { type: 'string' },
  now: { type: 'boolean' },
  overlap: { type: 'string' },
  // Any command that receives a secret: print it instead of writing a 0600 file.
  'print-secret': { type: 'boolean' },
  // webhooks create.
  events: { type: 'string' },
  // referrals connect / backfill.
  provider: { type: 'string' },
  program: { type: 'string' },
  'base-url': { type: 'string' },
  'referally-key': { type: 'string' },
  'referally-key-file': { type: 'string' },
  'auto-enroll': { type: 'boolean' },
  destination: { type: 'string' },
  'tracking-token': { type: 'string' },
  'no-sync': { type: 'boolean' },
  'allow-mode-mismatch': { type: 'boolean' },
  endpoint: { type: 'string' },
  'secret-file': { type: 'string' },
  enable: { type: 'boolean' },
  since: { type: 'string' },
  map: { type: 'string' },
  'metadata-path': { type: 'string' },
  wait: { type: 'boolean' },
} as const;

type OptionValue<O> = O extends { type: 'boolean' }
  ? boolean
  : O extends { multiple: true }
    ? string[]
    : string;

export type Values = {
  [K in keyof typeof OPTIONS]?: OptionValue<(typeof OPTIONS)[K]>;
};

export interface ParsedArgs {
  positionals: string[];
  values: Values;
}

/** Parse argv, turning parseArgs' own errors (unknown/invalid flag) into clean CliErrors. */
export function parse(argv: string[]): ParsedArgs {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    return { values: values as Values, positionals };
  } catch (err) {
    // parseArgs throws a TypeError with an ERR_PARSE_ARGS_* code; surface its
    // message (e.g. "Unknown option '--frob'") without the stack.
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError(message);
  }
}

/** A string flag's value, or undefined. */
export function str(values: Values, key: keyof Values): string | undefined {
  const v = values[key];
  return typeof v === 'string' ? v : undefined;
}

/** A repeatable string flag's values (each may also be comma-separated), or []. */
export function list(values: Values, key: keyof Values): string[] {
  const v = values[key];
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  return raw
    .flatMap((x) => x.split(','))
    .map((x) => x.trim())
    .filter(Boolean);
}

/** `--limit` as a positive integer, or undefined. Rejects garbage with a clean error. */
export function limit(values: Values): number | undefined {
  const raw = str(values, 'limit');
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new CliError(`--limit must be a positive integer, got '${raw}'.`);
  }
  return n;
}
