/**
 * All help text lives here as plain strings — the CLI's "docs" surface. Kept
 * out of the handlers so the dispatch code stays about control flow and the
 * copy can be read (and kept consistent) in one place.
 */

export const TOP_HELP = `atlas — manage an Atlas instance from the terminal

Usage: atlas <command> [subcommand] [arguments] [options]

Commands:
  login                      Authenticate and store a profile credential
  logout                     Remove a stored profile credential
  whoami                     Show the active profile and instance
  users list|get|create|delete
  orgs list|get|members
  api-keys list|create|revoke
  webhooks list|create
  sessions revoke
  config export|import       Config-as-code: round-trip the instance's config
  actions list|deploy|test|logs
  init                       Create or complete an app's setup (idempotent); secrets to 0600 files
  preflight                  Check an instance's setup; non-zero exit on errors (for CI)
  env                        Print deploy variables: public values + secret file paths
  client rotate              Rotate an OAuth client secret straight into its file
  referrals connect|backfill|status
                             Connect a referral platform, backfill, check the connection

Global options:
  --profile <name>           Use a named profile (default: active, else "default")
  --json                     Emit raw JSON instead of a human table
  --limit <n>                Page size for list commands that paginate
  --starting-after <cursor>  Pagination cursor (from a prior page's hint)
  -h, --help                 Show this help, or help for a command
  -v, --version              Print the version

Environment overrides:
  ATLAS_SECRET_KEY           Secret key to use instead of the stored one
  ATLAS_API_URL              API URL to use instead of the stored one
  ATLAS_PLATFORM_KEY         Platform key (psk_) for atlas init
  REFERALLY_BASE_URL         Referally base URL for atlas referrals connect
  REFERALLY_API_KEY          Referally merchant key for atlas referrals connect (never stored)

Secrets: a command that receives a secret writes it to a 0600 file under
~/.config/<product>/ and prints only the path. --print-secret prints it instead.

Run 'atlas <command> --help' for command-specific help.`;

/** Per-command help, keyed by the resource word. */
export const COMMAND_HELP: Record<string, string> = {
  referrals: `atlas referrals — referral attribution

Usage:
  atlas referrals connect --provider referally --program <prg_…> --base-url <url>
        [--referally-key-file <path|-> | --referally-key <rk_…>]
        [--auto-enroll] [--destination <url>] [--tracking-token <token>] [--enable]
  atlas referrals connect --provider webhook --endpoint <https-url>
        [--secret-file <path|->] [--program <id>] [--auto-enroll] [--enable]
  atlas referrals backfill --since <YYYY-MM-DD> [--map <file.csv>]
        [--metadata-path public_metadata.referral_code] [--wait]
  atlas referrals status

connect --provider referally creates the Atlas connection on Referally with
your merchant key (bring your own key: used for this one call, never stored or
printed), saves the connection id and secret on the instance, and runs a ping.
--auto-enroll and --destination are passed to Referally. --enable turns
referrals on when the ping passes. Prefer --referally-key-file (or
REFERALLY_API_KEY) to --referally-key: a key on the command line can end up in
your shell history.

connect --provider webhook points the instance at a platform that speaks the
Atlas referral protocol. Without --secret-file, a signing secret is generated
and written to a 0600 file for you to configure on the platform.

backfill reports users who signed up since the date, with their real sign-up
time. --map reads customerRef,code lines; --metadata-path reads a stored code.

status prints the connection, its health and the referral preflight findings;
it exits 1 when one is an error.

All subcommands take --instance <id> or --product <name> like preflight.`,

  login: `atlas login — authenticate and store a profile credential

Usage: atlas login [--profile <name>] [--url <api-url>] [--secret-key <sk_...>]

Prompts for an API URL and a secret key, validates the key with one Backend
call, then stores it (0600) under the profile. --url / --secret-key skip the
prompts for non-interactive setup.`,

  logout: `atlas logout — remove a stored profile credential

Usage: atlas logout [--profile <name>]`,

  whoami: `atlas whoami — show the active profile and instance

Usage: atlas whoami [--profile <name>] [--json]`,

  users: `atlas users — manage users

Usage:
  atlas users list [--limit <n>] [--starting-after <cursor>] [--json]
  atlas users get <user-id> [--json]
  atlas users create --email <address> [--first-name <n>] [--last-name <n>] [--password <p>] [--json]
  atlas users delete <user-id> [--json]`,

  orgs: `atlas orgs — manage organizations

Usage:
  atlas orgs list [--limit <n>] [--starting-after <cursor>] [--json]
  atlas orgs get <org-id> [--json]
  atlas orgs members <org-id> [--json]`,

  'api-keys': `atlas api-keys — manage end-user API keys

Usage:
  atlas api-keys list [--subject-type <user|organization>] [--subject-id <id>] [--json]
  atlas api-keys create --subject-type <user|organization> --subject-id <id> [--name <n>]
                        [--product <name>] [--force] [--print-secret] [--json]
  atlas api-keys revoke <api-key-id> [--json]`,

  webhooks: `atlas webhooks — manage webhook endpoints

Usage:
  atlas webhooks list [--json]
  atlas webhooks create --url <https-url> [--events a,b] [--product <name>] [--print-secret] [--json]

create writes the signing secret to a 0600 file and prints only its path.`,

  init: `atlas init — create or complete an app's setup, idempotently

Usage:
  atlas init --product <name> [--domain <domain>] [--auth-host <host>]
             [--instance-env development|production] [--name <app-name>]
             [--strategies password,email_code,...]
             [--email managed|development|none] [--email-from <address>]
             [--email-provider resend|brevo --email-key-file <path|->]
             [--client-redirect <url>]... [--webhook-url <url>]
             [--yes] [--force] [--rotate-secret] [--json]

Needs a platform key (ATLAS_PLATFORM_KEY, or a psk_ profile from atlas login).
Finds the app by name and environment, or creates it, then sets strategies, the
email sender, the custom domain (auth.<domain> unless --auth-host; prints the
CNAME), a first-party OAuth client and a webhook. Re-running only fills what is
missing.

Email always goes through YOUR provider account (Atlas lends none):
  managed      Atlas sets your domain up on your Resend or Brevo account and
               prints the DNS records.
  development  development instances only: your provider without a verified
               domain (Resend's onboarding@resend.dev by default), capped.
The key is read from --email-key-file (a file holding the key or KEY=value; '-'
reads stdin). It is never taken from argv and never printed.

Every secret goes to ~/.config/<product>/<env>*.env (dir 0700, files 0600) and
is never printed. An existing file is never overwritten without --force.
--rotate-secret mints a new secret key when the app exists but its file is gone.
Public values and file paths are kept in ~/.config/<product>/atlas.json.`,

  preflight: `atlas preflight — check an instance's setup (a CI / deploy gate)

Usage: atlas preflight [--instance <id> | --product <name> [--instance-env <env>]]
                       [--fail-on error|warning] [--json]

Prints every finding (severity, code, message, fix). Exits 1 when there is an
error, or with --fail-on warning also on a warning.`,

  env: `atlas env — print deploy variables without secrets

Usage: atlas env --product <name> [--instance-env <env>] [--format dotenv|coolify|vercel] [--json]

Public values (publishable key, Frontend API, issuer, discovery and JWKS URLs,
OAuth client id) are printed as-is. Secrets are printed as references to their
0600 files: *_FILE=<path> (dotenv), KEY=@<path> (coolify), or a vercel env add
command that pipes the value from the file (vercel).`,

  client: `atlas client — OAuth clients

Usage: atlas client rotate <client-id> [--now | --overlap <seconds>]
                           [--instance <id> | --product <name> [--instance-env <env>]]
                           [--print-secret]

Rotates the client secret and writes the new one straight to its 0600 file.
--now revokes the old secret immediately; --overlap keeps it working for that
many seconds. Prints when the old secret stops working.`,

  sessions: `atlas sessions — manage sessions

Usage:
  atlas sessions revoke <session-id> [--json]`,

  config: `atlas config — config-as-code for an Atlas instance (the Auth0 deploy-cli peer)

Usage:
  atlas config export [--dir <path>] [--format json|yaml]
  atlas config import [--dir <path>] [--format json|yaml] [--dry-run] [--prune]

export  Read the instance's current config (instance/auth config, OAuth clients
        and providers, SSO connections, resource servers, JWT templates, roles,
        webhook endpoints, billing plans, redirect URLs, org settings schema,
        notification and email templates, org policies) and write a deterministic
        directory tree — one file per resource type, keys sorted, SECRETS OMITTED.

import  Diff the directory against live config and apply creates/updates
        idempotently. A resource type with no file is left untouched.
          --dry-run   print the plan and apply nothing
          --prune     also delete live resources absent from the config
          --dir       config directory (default: ./atlas-config)
          --format    json (default) or yaml

Secrets never live on disk. Inject a credential at import with a \${ENV_VAR}
placeholder in a file (e.g. a provider "client_secret": "\${GOOGLE_SECRET}").`,
  actions: `atlas actions — manage Actions (tenant code run in the auth pipeline)

Usage:
  atlas actions list [--json]
  atlas actions deploy <file> --trigger <post_login|pre_user_registration|post_user_registration> [--name <n>] [--json]
  atlas actions test <file> [--trigger <t>] [--json]
  atlas actions logs <action-id> [--json]

deploy uploads the file's code verbatim as a new action (created, not yet bound).
test runs the file OFFLINE through the @atlasauth/actions harness — no network,
no real users — and exits non-zero if the action throws. logs explains where an
action's execution history is recorded (Atlas has no live log-stream endpoint).`,
};
