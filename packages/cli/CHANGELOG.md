# @atlasauth/cli changelog

## 0.5.0

### Added

- `atlas referrals connect --provider referally` registers a Referally webhook (the `referral.*` topics) that sends referral changes back to Atlas and saves its secret on the instance; `--no-sync` skips it.
- It requires request-line (v2) signatures on the new connection from the first call.
- It refuses a test Referally key for a production instance, and a live key for a development one; `--allow-mode-mismatch` goes ahead with a warning.
- `atlas referrals status` shows two-way sync, the inbound URL and the last event. `connect --provider webhook` prints the inbound URL.

## 0.4.0

### Added
- `atlas referrals connect --provider referally --program <prg_…> --base-url <url> [--referally-key-file <path|-> | --referally-key <key>] [--auto-enroll] [--destination <url>] [--tracking-token <token>] [--enable]`: creates the Atlas connection on Referally with your merchant key (bring your own key: used for one call, never stored or printed), saves `connection_id`, `signing_secret`, `endpoint_url`, `program_id` (and `tracking_token`, `auto_enroll_users`) on the instance, runs the connection test (ping) and prints the organization, program, auto-enroll and clock skew (warning over 60 s). `--enable` turns referrals on only when the test passes. If saving on the instance fails, the shown-once connection secret is written to a 0600 file. `REFERALLY_BASE_URL` and `REFERALLY_API_KEY` are read from the environment.
- `atlas referrals connect --provider webhook --endpoint <https-url> [--secret-file <path|->]`: the Atlas referral protocol; without `--secret-file` a signing secret is generated and written to a 0600 file.
- `atlas referrals backfill --since <YYYY-MM-DD> [--map <file.csv>] [--metadata-path <path>] [--wait]`: reports existing users with their real sign-up time; `--map` reads `customerRef,code` lines.
- `atlas referrals status [--json]`: the connection, its health and alert, and the `referrals_*` preflight findings; exits 1 on an error finding.
- New flags: `--provider`, `--program`, `--base-url`, `--referally-key`, `--referally-key-file`, `--auto-enroll`, `--destination`, `--tracking-token`, `--endpoint`, `--secret-file`, `--enable`, `--since`, `--map`, `--metadata-path`, `--wait`.

## 0.3.0

### Added
- `atlas init --product <name>`: creates or completes an app's setup in one idempotent command, through the platform API (needs a `psk_` platform key: `ATLAS_PLATFORM_KEY`, or a profile stored with `atlas login --secret-key psk_…`). Flags: `--domain`, `--auth-host`, `--instance-env development|production`, `--name`, `--strategies`, `--email managed|development|none`, `--email-from`, `--email-provider resend|brevo`, `--email-key-file <path|->`, `--client-redirect` (repeatable), `--webhook-url`, `--yes`, `--force`, `--rotate-secret`, `--json`. Email goes through your own provider account: the key is read from `--email-key-file` (or stdin with `-`), never from argv, and never printed. Prints the managed-email DNS records and the custom-domain CNAME, and a summary of public values (publishable key, Frontend API, issuer, discovery URL; `issuer` / `discovery_url` / `jwks_uri` from the API when it returns them).
- A project manifest at `~/.config/<product>/atlas.json` with public values and secret file paths only.
- `atlas preflight [--instance <id> | --product <name>] [--fail-on error|warning] [--json]`: prints findings and exits 1 on errors (or warnings).
- `atlas env --product <name> --format dotenv|coolify|vercel`: public values plus secret file references (`*_FILE=<path>`, `KEY=@<path>`, or `vercel env add` commands that read the file), never secret values.
- `atlas client rotate <client-id> [--now | --overlap <seconds>]`: sends `overlap_seconds`, writes the new secret straight to its file, and prints when the old one stops working (`previous_secret_expires_at`).
- `atlas webhooks create --url <url> [--events a,b]`.
- `atlas login` accepts a platform key (`psk_…`) and validates it against the platform API.
- New flags: `--product`, `--print-secret`, `--force` on secret-returning commands.

### Changed
- Secrets are written to files by default. Every command that receives a secret writes it to a `0600` dotenv file under `~/.config/<product>/` (directory `0700`; `~/.config/atlasauth/` without `--product`) and prints only the path. An existing different file is never overwritten without `--force`.
- `atlas api-keys create` no longer prints the secret. It writes `ATLAS_API_KEY` to `api-key-<id>.env` and prints the path; `--json` returns `secret_file` instead of `secret`. Pass `--print-secret` for the old behaviour (with a warning on stderr).

### Fixed
- `atlas config import` no longer sends `signing_alg` when creating or updating a resource server, or `type` when updating an SSO connection. Instances that refuse unknown fields (every new instance) answered those writes with `422 UNKNOWN_FIELD`.

## 0.2.0

### Added
- `atlas config export` / `atlas config import` for config-as-code: round-trips an instance's configuration (auth config and allowed origins, OAuth clients and providers, SSO connections, resource servers, JWT templates, roles, webhook endpoints, billing plans, redirect URLs, organization settings schema, notification and email templates, organization policies) to a directory in JSON or YAML.
  - Output is deterministic (sorted keys) and never contains secrets; `${ENV_VAR}` placeholders are resolved from the environment on import.
  - `import` supports `--dry-run` to preview the plan and `--prune` to delete resources removed from the directory; without `--prune` nothing is deleted.
- `atlas actions list | deploy | test | logs` for managing Atlas Actions, with `test` running an Action locally through the `@atlasauth/actions` harness.

## 0.1.0

First published release.

### Added
- `atlas` command-line tool for managing an Atlas instance over the Backend API, built on `@atlasauth/backend`.
- `atlas login`, `logout` and `whoami`, with named profiles (`--profile`) stored in a `0600` config file and `ATLAS_SECRET_KEY` / `ATLAS_API_URL` environment overrides.
- Commands: `users list | get | create | delete`, `orgs list | get | members`, `api-keys list | create | revoke`, `webhooks list` and `sessions revoke`.
- Human-readable tables by default, `--json` for raw output, and `--limit` / `--starting-after` pagination on list commands.
