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
} as const;

export type Values = {
  [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K]['type'] extends 'boolean' ? boolean : string;
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
