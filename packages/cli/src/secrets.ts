import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CliError } from './errors';
import type { IO } from './io';

/**
 * Secrets the CLI receives are written to disk, never printed.
 *
 * Every command that gets a secret back from the API (an instance secret key,
 * an OAuth client secret, a webhook signing secret, an end-user API key) writes
 * it to a dotenv file under `~/.config/<product>/` — directory 0700, file 0600 —
 * and prints only the file path. `--print-secret` is the one explicit opt-out,
 * and it prints a warning first. An existing file is never overwritten unless
 * the command was given `--force`, so a re-run cannot silently destroy the only
 * copy of a working secret.
 *
 * The product name doubles as the directory name, so it is restricted to a safe
 * slug (no path separators, no dot-dot).
 */

const PRODUCT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/i;

export function assertProductName(product: string): string {
  if (!PRODUCT_RE.test(product)) {
    throw new CliError(
      `--product must be letters, digits, '-' or '_' (up to 63 characters), got '${product}'.`,
    );
  }
  return product;
}

/** `$XDG_CONFIG_HOME/<product>` (default `~/.config/<product>`). */
export function productDir(env: NodeJS.ProcessEnv, product: string): string {
  const base = env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.config');
  return join(base, assertProductName(product));
}

/** Quote a dotenv value when it needs it. Secrets are token-shaped, so this is rarely used. */
function dotenvValue(v: string): string {
  return /^[A-Za-z0-9_./:@+=,-]*$/.test(v) ? v : JSON.stringify(v);
}

export function renderDotenv(entries: Record<string, string>, comment?: string): string {
  const lines = comment ? comment.split('\n').map((l) => `# ${l}`) : [];
  for (const [k, v] of Object.entries(entries)) lines.push(`${k}=${dotenvValue(v)}`);
  return lines.join('\n') + '\n';
}

/** Parse a dotenv file this CLI wrote (KEY=value lines, `#` comments). */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        /* keep raw */
      }
    }
    out[key] = value;
  }
  return out;
}

/**
 * Write a 0600 dotenv file inside a 0700 directory. Refuses an existing file
 * unless `force` (the same content is not a conflict: a re-run is a no-op).
 * Returns the path.
 */
export function writeSecretFile(
  dir: string,
  fileName: string,
  entries: Record<string, string>,
  opts: { force?: boolean; comment?: string } = {},
): { path: string; written: boolean } {
  if (fileName.includes('/') || fileName.includes('\\') || fileName.startsWith('.')) {
    throw new CliError(`Refusing to write a secret file named '${fileName}'.`);
  }
  const path = join(dir, fileName);
  const content = renderDotenv(entries, opts.comment);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  if (existsSync(path)) {
    const current = readFileSync(path, 'utf8');
    if (current === content) {
      chmodSync(path, 0o600);
      return { path, written: false };
    }
    if (!opts.force) {
      throw new CliError(
        `${path} already exists and holds a different secret. Nothing was overwritten. Move it aside, or re-run with --force to replace it.`,
      );
    }
  }
  // Write THEN chmod: `mode` is masked by umask and ignored for an existing file.
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { path, written: true };
}

/** Read one of the CLI's env files, or undefined when it does not exist. */
export function readEnvFile(path: string): Record<string, string> | undefined {
  try {
    return parseDotenv(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** The env files in a product directory (for `atlas env`). */
export function listEnvFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.env'))
      .sort();
  } catch {
    return [];
  }
}

/**
 * The common "a secret arrived" path for single-secret commands: write it to
 * `<dir>/<fileName>` (0600) and print the path, or — only with
 * `--print-secret` — print it after a warning on stderr.
 */
export function deliverSecret(input: {
  io: IO;
  env: NodeJS.ProcessEnv;
  product: string;
  fileName: string;
  entries: Record<string, string>;
  label: string;
  printSecret?: boolean;
  force?: boolean;
  comment?: string;
}): { path?: string } {
  if (input.printSecret) {
    input.io.err(
      `atlas: warning: printing ${input.label} because --print-secret was given. It may end up in your shell history, terminal scrollback or CI logs.`,
    );
    for (const [k, v] of Object.entries(input.entries)) input.io.out(`${k}=${v}`);
    return {};
  }
  const { path } = writeSecretFile(productDir(input.env, input.product), input.fileName, input.entries, {
    force: input.force,
    comment: input.comment,
  });
  input.io.out(`${input.label} written to ${path} (mode 0600).`);
  return { path };
}
