import { AtlasApiError } from '@atlasauth/backend';
import { parse, type ParsedArgs } from './args';
import { actions } from './commands/actions';
import { pages } from './commands/pages';
import { apiKeys } from './commands/api-keys';
import { login, logout, whoami } from './commands/auth';
import { keys, token } from './commands/operator';
import { config } from './commands/config';
import { init } from './commands/init';
import { importUsers } from './commands/import';
import { info } from './commands/info';
import { csp } from './commands/csp';
import { fga } from './commands/fga';
import { dev } from './commands/dev';
import { listen } from './commands/listen';
import { migrate } from './commands/migrate';
import { moveOrigin } from './commands/move-origin';
import { mcp } from './commands/mcp';
import { client, doctor, envCommand, preflight } from './commands/project-commands';
import { orgs } from './commands/orgs';
import { referrals } from './commands/referrals';
import { sessions } from './commands/sessions';
import { status } from './commands/status';
import { users } from './commands/users';
import { webhooks } from './commands/webhooks';
import { integrations } from './commands/integrations';
import { idAccounts } from './commands/id-accounts';
import { admin } from './commands/admin';
import { partnerPlatforms } from './commands/partner-platforms';
import {
  AGENTS, AUDIT, BILLING, CATALOG, CHAT, CLOUD, PROVISIONING, SAML_IDP, CONNECTION_ACTIONS, DEVICE_SSO, FEDERATION, PDP, TELEMETRY, TRIGGERS, VC, WORKFLOWS,
  resourceCommand,
} from './commands/resources';
import type { RunContext } from './context';
import { CliError } from './errors';
import { COMMAND_HELP, TOP_HELP } from './help';
import { getVersion } from './version';

/** A command handler: given the context and parsed args, do the work; return an exit code. */
export type Handler = (ctx: RunContext, args: ParsedArgs) => Promise<number>;

/** The command table — the single place every top-level command is registered. */
const COMMANDS: Record<string, Handler> = {
  login,
  logout,
  whoami,
  token,
  keys,
  users,
  orgs,
  'api-keys': apiKeys,
  webhooks,
  integrations,
  'partner-platforms': partnerPlatforms,
  'id-accounts': idAccounts,
  admin,
  sessions,
  config,
  actions,
  pages,
  init,
  preflight,
  doctor,
  env: envCommand,
  client,
  referrals,
  status,
  import: importUsers,
  migrate,
  info,
  mcp,
  listen,
  dev,
  'move-origin': moveOrigin,
  csp,
  fga,
  workflows: resourceCommand('workflows', WORKFLOWS),
  chat: resourceCommand('chat', CHAT),
  cloud: resourceCommand('cloud', CLOUD),
  'saml-idp': resourceCommand('saml-idp', SAML_IDP),
  provisioning: resourceCommand('provisioning', PROVISIONING),
  catalog: resourceCommand('catalog', CATALOG),
  'device-sso': resourceCommand('device-sso', DEVICE_SSO),
  'connection-actions': resourceCommand('connection-actions', CONNECTION_ACTIONS),
  triggers: resourceCommand('triggers', TRIGGERS),
  agents: resourceCommand('agents', AGENTS),
  telemetry: resourceCommand('telemetry', TELEMETRY),
  pdp: resourceCommand('pdp', PDP),
  billing: resourceCommand('billing', BILLING),
  audit: resourceCommand('audit', AUDIT),
  federation: resourceCommand('federation', FEDERATION),
  vc: resourceCommand('vc', VC),
};

/**
 * The CLI's whole control flow, as a pure function of (argv, context) → exit
 * code. It NEVER calls `process.exit` and NEVER throws: the bin calls it and
 * exits with what it returns, and every test drives this same path with a
 * captured IO. All error reporting funnels through the one try/catch so a user
 * sees a clean message and a non-zero code — never a stack trace.
 */
export async function run(argv: string[], ctx: RunContext): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parse(argv);
  } catch (err) {
    return report(ctx, err);
  }

  // --version wins over everything, like most CLIs.
  if (args.values.version) {
    ctx.io.out(getVersion());
    return 0;
  }

  const command = args.positionals[0];

  // Bare `atlas` or `atlas --help`: top-level help on stdout, success.
  if (!command) {
    ctx.io.out(TOP_HELP);
    return 0;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    ctx.io.err(`Unknown command '${command}'.`);
    ctx.io.err("Run 'atlas --help' to see available commands.");
    return 1;
  }

  // `atlas <command> --help`: command-specific help on stdout, success.
  if (args.values.help) {
    ctx.io.out(COMMAND_HELP[command] ?? TOP_HELP);
    return 0;
  }

  try {
    return await handler(ctx, args);
  } catch (err) {
    return report(ctx, err);
  }
}

/**
 * Turn any thrown error into a clean stderr message + exit code. An
 * {@link AtlasApiError} keeps its HTTP status and stable `code` so the user can
 * act on it; a {@link CliError} carries its own code; anything else is an
 * unexpected bug reported as its message (still no stack).
 */
function report(ctx: RunContext, err: unknown): number {
  if (err instanceof AtlasApiError) {
    const code = err.code ? ` [${err.code}]` : '';
    ctx.io.err(`atlas: API error (HTTP ${err.status})${code}: ${err.message}`);
    return 1;
  }
  if (err instanceof CliError) {
    ctx.io.err(`atlas: ${err.message}`);
    return err.exitCode;
  }
  const message = err instanceof Error ? err.message : String(err);
  ctx.io.err(`atlas: ${message}`);
  return 1;
}
