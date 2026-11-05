/**
 * The CLI's one output-side secret filter. Every change a plan prints, every
 * `--json` report of plan / preflight / golive and every API error passes through
 * here, so a resource added later cannot leak by forgetting to mask a field.
 *
 *  - {@link isSecretKey}: a field name that holds a secret. Names that only mention
 *    the word (`token_endpoint`, `password_policy`, `secret_key_prefix`) are not.
 *  - {@link redactDeep}: masks secret-named strings at any depth, and scrubs the rest.
 *  - {@link scrubText}: removes known values, Atlas-key-shaped values and
 *    `name=value` pairs from free text.
 *  - {@link rememberResolved}: records what a `${VAR}` placeholder resolved to, so a
 *    secret under an unexpected key still cannot print. {@link scrubbingIO} applies
 *    those values to everything the command writes.
 *
 * The state is per `run()`; {@link resetRedaction} clears it.
 */
import type { IO } from './io';

export const REDACTED = '<redacted>';

const SECRET_WORD = /secret|token|password|passwd|api_?key|private_?key|signing_?key|encryption_?key|access_?key|credential|authorization/;
/** The name describes the secret rather than holding it. */
const DESCRIBES_IT = /_(endpoint|url|uri|method|policy|prefix|format|ttl|seconds|lifetimes?|params|set|file|files|at|type|name|id|ref|hint|hasher|alg|algorithm|enabled|required|source|length|mode|count|version)$/;

/** True for a field name whose string value is a secret. */
export function isSecretKey(key: string): boolean {
  const snake = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  // `has_secret`, `is_token`: a flag about the secret, never the secret.
  return SECRET_WORD.test(snake) && !DESCRIBES_IT.test(snake) && !/^(has|is)_/.test(snake);
}

const PLACEHOLDER = /^\$\{[A-Z0-9_]+\}$/;
/** An unresolved `${VAR}` is a name, not a value: it stays visible (apply refuses it). */
export const isPlaceholder = (v: unknown): boolean => typeof v === 'string' && PLACEHOLDER.test(v);

/** The secret formats Atlas mints: `atlas_<env>_<kind>_…`, and the legacy `sk_<env>_`, `psk_`, `dsk_`, `whsec_`. */
export const SECRET_VALUE_SOURCE =
  '\\b(?:atlas_(?:live|test)_(?:sk|psk|dsk|whsec|pl|at)_[A-Za-z0-9]+|(?:sk_(?:live|test)|psk|dsk|whsec)_[A-Za-z0-9_\\-+/=]+)';
const SECRET_VALUE = new RegExp(SECRET_VALUE_SOURCE, 'g');
const KEY_VALUE = /(["']?)([A-Za-z][\w-]*)\1(\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s,&;}"']+)/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g;

const known = new Set<string>();
let reveal = false;

/** Forget the remembered values and leave `--show-secrets` off. */
export function resetRedaction(): void {
  known.clear();
  reveal = false;
}

/** `--show-secrets`: the caller has checked it is allowed here. */
export function setRevealSecrets(on: boolean): void {
  reveal = on;
}
export const revealingSecrets = (): boolean => reveal;

/** Below this a value is too short to scrub without mangling ordinary words; a secret-named key is masked anyway. */
const MIN_SCRUB_LENGTH = 6;
const PUBLIC_KEY = /(^|_)client_id$|^provider$|^from_address$/i;

function isPlainUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && !u.search;
  } catch {
    return false;
  }
}

/** Remember what a `${VAR}` under `key` resolved to. Public values (a client id, a plain URL) stay printable. */
export function rememberResolved(key: string | undefined, value: string): void {
  if (value.length < MIN_SCRUB_LENGTH) return;
  if (!(key && isSecretKey(key)) && ((key && PUBLIC_KEY.test(key)) || isPlainUrl(value))) return;
  known.add(value);
  known.add(JSON.stringify(value).slice(1, -1));
}

function scrubKnown(text: string): string {
  if (reveal || known.size === 0) return text;
  let out = text;
  for (const v of [...known].sort((a, b) => b.length - a.length)) out = out.split(v).join(REDACTED);
  return out;
}

/** Remove known values, key-shaped values and secret `name=value` pairs from free text. */
export function scrubText(text: string): string {
  if (reveal) return text;
  return scrubKnown(text)
    .replace(SECRET_VALUE, REDACTED)
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(KEY_VALUE, (match, _q: string, name: string, sep: string, value: string) => {
      // `<value>` in a help line is a placeholder too.
      if (!isSecretKey(name) || isPlaceholder(value) || /^<[\w-]+>$/.test(value)) return match;
      const quoted = value.startsWith('"') || value.startsWith("'");
      // `client_secret: missing` is prose; `client_secret: 8f3a91c2…` and `token=abc` are not.
      if (!quoted && sep.includes(':') && value.length < 8) return match;
      const q = quoted ? value[0] : '';
      return `${match.slice(0, match.length - value.length)}${q}${REDACTED}${q}`;
    });
}

/** A copy with every secret-named string masked and every other string scrubbed. */
export function redactDeep<T>(value: T, key?: string): T {
  if (reveal) return value;
  if (typeof value === 'string') {
    if (key && isSecretKey(key) && value !== '' && !isPlaceholder(value)) return REDACTED as T;
    return scrubText(value) as T;
  }
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, key)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, k)])) as T;
  }
  return value;
}

/**
 * The sinks every command writes through, without any value `${VAR}` resolved to.
 * Only remembered values: a secret a command prints on purpose (`--print-secret`)
 * was never remembered, so it still prints.
 */
export function scrubbingIO(io: IO): IO {
  return { out: (t) => io.out(scrubKnown(t)), err: (t) => io.err(scrubKnown(t)) };
}
