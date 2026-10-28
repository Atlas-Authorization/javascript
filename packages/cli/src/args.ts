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
  // login --device / token: the operator device flow and token exchange.
  device: { type: 'boolean' },
  resource: { type: 'string' },
  scope: { type: 'string' },
  // keys create / rotate.
  scopes: { type: 'string' },
  owner: { type: 'string' },
  'expires-at': { type: 'string' },
  'allowed-ips': { type: 'string' },
  out: { type: 'string' },
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
  // actions install / update: secret values from a dotenv file, never argv.
  'secrets-file': { type: 'string' },
  // actions publish: keep the new version a draft instead of submitting it.
  draft: { type: 'boolean' },
  // pages push / preview / promote / pull / discard.
  page: { type: 'string' },
  promote: { type: 'boolean' },
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
  backchannel: { type: 'string' },
  yes: { type: 'boolean', short: 'y' },
  force: { type: 'boolean' },
  'rotate-secret': { type: 'boolean' },
  instance: { type: 'string' },
  'fail-on': { type: 'string' },
  // doctor / csp.
  only: { type: 'string' },
  'no-probe': { type: 'boolean' },
  shape: { type: 'string' },
  origin: { type: 'string' },
  now: { type: 'boolean' },
  overlap: { type: 'string' },
  // Any command that receives a secret: print it instead of writing a 0600 file.
  'print-secret': { type: 'boolean' },
  // webhooks create / update / listen.
  events: { type: 'string' },
  // webhooks deliveries / redeliver / test / update.
  delivery: { type: 'string' },
  status: { type: 'string' },
  'event-type': { type: 'string' },
  until: { type: 'string' },
  active: { type: 'boolean' },
  inactive: { type: 'boolean' },
  timeout: { type: 'string' },
  'no-wait': { type: 'boolean' },
  // move-origin.
  to: { type: 'string' },
  // listen.
  'forward-to': { type: 'string' },
  count: { type: 'string' },
  'no-forward': { type: 'boolean' },
  // dev.
  port: { type: 'string' },
  seed: { type: 'string' },
  api: { type: 'string' },
  // fga test.
  store: { type: 'string' },
  // resource commands: a JSON request body (or --file).
  data: { type: 'string' },
  // csp.
  framework: { type: 'string' },
  manifest: { type: 'string', multiple: true },
  'no-atlas': { type: 'boolean' },
  // config plan.
  'exit-code': { type: 'boolean' },
  // referrals connect / backfill.
  provider: { type: 'string' },
  program: { type: 'string' },
  'base-url': { type: 'string' },
  'referalli-key': { type: 'string' },
  'referalli-key-file': { type: 'string' },
  // The old spellings (Referalli was first published as "Referally"): still accepted, with a notice.
  'referally-key': { type: 'string' },
  'referally-key-file': { type: 'string' },
  // referrals connect --oauth: one-click connect (no key to paste).
  oauth: { type: 'boolean' },
  preset: { type: 'string' },
  // referrals conformance: the platform under test.
  'connection-id': { type: 'string' },
  // referrals conformance: webhook (generic protocol) or connection (Referalli dialect).
  protocol: { type: 'string' },
  simulate: { type: 'boolean' },
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
  // import --from <vendor>.
  from: { type: 'string' },
  'batch-size': { type: 'string' },
  'state-file': { type: 'string' },
  'hash-config': { type: 'string' },
  hashes: { type: 'string' },
  'create-orgs': { type: 'boolean' },
  // import --from better-auth --bundle <file> | --import <id>; migrate better-auth.
  bundle: { type: 'string' },
  import: { type: 'string' },
  'confirm-conflicts': { type: 'boolean' },
  // keys data shred --confirm <instance id>.
  confirm: { type: 'string' },
  options: { type: 'string' },
  entry: { type: 'string' },
  'run-export': { type: 'boolean' },
  'bridge-days': { type: 'string' },
  // atlas migrate <vendor> …: a local input file, and vendor settings / credentials
  // as repeatable `--set name=value` (vendor flags cannot all live in this schema).
  file: { type: 'string' },
  set: { type: 'string', multiple: true },
  resume: { type: 'boolean' },
  skip: { type: 'string', multiple: true },
  // integrations set / deliveries.
  audience: { type: 'string' },
  'events-url': { type: 'string' },
  'backchannel-logout-url': { type: 'string' },
  'oauth-client-id': { type: 'string' },
  trace: { type: 'string' },
  disable: { type: 'boolean' },
  // partner-platforms.
  'platform-id': { type: 'string' },
  'jwks-url': { type: 'string' },
  'signature-header': { type: 'string' },
  'allowed-source': { type: 'string', multiple: true },
  'token-file': { type: 'string' },
  rotate: { type: 'boolean' },
  // id-accounts provision / list / rotate / remove.
  app: { type: 'string' },
  label: { type: 'string' },
  'password-file': { type: 'string' },
  'two-factor-exempt': { type: 'boolean' },
  unverified: { type: 'boolean' },
  // admin id-accounts / developer-accounts (Atlas staff).
  team: { type: 'string' },
  kind: { type: 'string' },
  days: { type: 'string' },
  'any-app': { type: 'boolean' },
  'staff-account': { type: 'string' },
  'account-name': { type: 'string' },
  'application-name': { type: 'string' },
  'no-step-up': { type: 'boolean' },
  // atlas migrate clerk / auth0 / okta / kinde / descope (vendor credentials stay on this machine).
  'clerk-secret-key': { type: 'string' },
  'clerk-publishable-key': { type: 'string' },
  'clerk-csv': { type: 'string' },
  'skip-api-keys': { type: 'boolean' },
  'auth0-domain': { type: 'string' },
  'auth0-client-id': { type: 'string' },
  'auth0-client-secret': { type: 'string' },
  'auth0-mgmt-client-id': { type: 'string' },
  'auth0-mgmt-client-secret': { type: 'string' },
  'auth0-mgmt-token': { type: 'string' },
  'auth0-connection': { type: 'string' },
  'auth0-users-file': { type: 'string' },
  'auth0-hashes-file': { type: 'string' },
  'authentication-methods': { type: 'boolean' },
  'rp-id': { type: 'string' },
  'okta-domain': { type: 'string' },
  'okta-api-token': { type: 'string' },
  'okta-auth-server': { type: 'string' },
  'okta-client-id': { type: 'string' },
  'okta-client-secret': { type: 'string' },
  'groups-as': { type: 'string' },
  factors: { type: 'boolean' },
  'kinde-domain': { type: 'string' },
  'kinde-client-id': { type: 'string' },
  'kinde-client-secret': { type: 'string' },
  'kinde-export': { type: 'string' },
  'kinde-export-key': { type: 'string' },
  'kinde-export-iv': { type: 'string' },
  'kinde-include-default-org': { type: 'boolean' },
  'descope-project-id': { type: 'string' },
  'descope-management-key': { type: 'string' },
  'descope-base-url': { type: 'string' },
  'descope-hashes-file': { type: 'string' },
  // mcp install.
  cursor: { type: 'boolean' },
  'claude-code': { type: 'boolean' },
  codex: { type: 'boolean' },
  vscode: { type: 'boolean' },
  global: { type: 'boolean' },
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
