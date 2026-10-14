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
  webhooks list
  sessions revoke
  config export|import       Config-as-code: round-trip the instance's config
  actions list|deploy|test|logs

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

Run 'atlas <command> --help' for command-specific help.`;

/** Per-command help, keyed by the resource word. */
export const COMMAND_HELP: Record<string, string> = {
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
  atlas api-keys create --subject-type <user|organization> --subject-id <id> [--name <n>] [--json]
  atlas api-keys revoke <api-key-id> [--json]`,

  webhooks: `atlas webhooks — inspect webhook endpoints

Usage:
  atlas webhooks list [--json]`,

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
