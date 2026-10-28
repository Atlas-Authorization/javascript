# @atlasauth/cli changelog

## 0.15.0 — 2026-10-28

- New commands: `workflows`, `chat`, `cloud` (`cloud login <target>` prints the https launch URL), `device-sso`, `connection-actions`, `triggers`, `agents`, `telemetry`, `pdp`, `billing`, `audit`, `federation`, `vc`
- `mcp` gains gateway, upstream, pack, pin and registry commands; `keys` gains `data` and `op`; `users merge` (preview with `--dry-run`); `fga` gains `export`, `import`, `watch`, `materialize`
- Request bodies come from `--data '<json>'` or `--file`; anything that changes or removes data needs `--yes`

## 0.14.0 — 2026-10-28

- `atlas fga test`, `validate` and `transform`

## 0.13.0 — 2026-10-26

### Changed

- Many more `atlas migrate export` vendors and config exporters (Authentik, Azure, Cognito, Corbado, Firebase, Frontegg, FusionAuth, Hanko, Keycloak, Appwrite and more), with the Entra External ID plugin extended. Depends on `@atlasauth/emulator` for local development.

## 0.12.0 — 2026-10-25

### Added

- `atlas migrate clerk | auth0 | okta | kinde | descope`: config translation (1:1 / differs / manual report), exports through the sealed bundle (Clerk Backend API + dashboard CSV with password digests and TOTP secrets; Auth0 users-export job + the support hash/MFA export; Okta users, groups, IdP links and factors; Kinde's encrypted data export with bcrypt hashes + Management API; Descope users, tenants and roles + the support hash export), the bridge and lazy-migration presets, and the codemod hand-off. Vendor credentials come from flags (`--auth0-domain`, `--okta-api-token`, …) or env vars on your machine.
- `atlas migrate <vendor> [config|export|import|bridge|lazy]` and `atlas migrate export <vendor>`: the vendor-neutral migration program. With no step it runs every step in order with checkpoints (`--resume`, `--force`, `--dry-run`, `--yes`, `--skip`, `--json`); exports are sealed to your instance's import key on your machine, vendor credentials never leave it. `atlas migrate custom export --file records.ndjson` imports a homegrown user store through the same pipeline.

## 0.11.0 — 2026-10-25

- `atlas id-accounts provision|list|rotate|remove`: test and review accounts for a Sign in with Atlas app (reviewer logins, CI, demos), with a platform key or a per-app key scoped `atlas_id_apps:<app id>:provision`. Passwords go to 0600 files and are never printed (`--print-secret` is the opt-out).
- `atlas admin id-accounts list|provision|extend|rotate|revoke` and `atlas admin developer-accounts provision|revoke`: for Atlas staff, accounts for other platforms' integration teams. Uses the operator sign-in (`atlas login --device`) exchanged for Atlas's own account, signs in again once when a recent second factor is needed (`--no-step-up` to just fail), and writes passwords (delivered sealed) to 0600 files.

## 0.10.0 — 2026-10-24

- Per-call integration audiences (`getToken({ for, cbid })`), partner platforms, operator tokens for partner products.

## 0.9.0 — 2026-10-24

### Added

- `atlas webhooks` gains `upsert`, `update`, `test`, `deliveries`, `redeliver`, `replay`, `rotate` and `reveal`. Secrets go to 0600 files.
- `atlas listen --forward-to <url> [--events user.*]`: signed local webhook forwarding with no tunnel.
- `atlas move-origin --from --to [--dry-run]`: one-step domain move with a diff, a confirmation and a test delivery per moved webhook.
- `atlas csp --framework next|express|nginx`: the CSP sources for your integration shape; `--manifest` merges any provider's embed manifest.
- `atlas config plan`: field-level drift diff with `--exit-code` and `--json`. New `atlas-plan` GitHub Action.
- `atlas env --format k8s`, and `atlas env` without `--product` reads the live instance.
- `atlas migrate code --from openid-client|jose|generic-oidc`.
- `ATLAS_API_BASE` is accepted everywhere `ATLAS_API_URL` is (BASE wins when both are set); `atlas env` prints both.
- `atlas referrals conformance`: runs `@atlasauth/referral-conformance` against any referral platform (`--protocol webhook` for the generic Atlas referral protocol, `connection` for the Referalli dialect; defaults to the connected one), with `--secret-file`, `--only` and `--simulate`. Exits 1 on a failed case.
- `atlas referrals connect --oauth [--preset <id>]`: one-click connect. Prints the platform's link, waits for the connection to appear, pings it. No key or secret is copied.

### Changed

- Referalli is `--provider referalli`; `--provider referally`, `--referally-key`, `--referally-key-file`, `REFERALLY_BASE_URL` and `REFERALLY_API_KEY` still work and print a notice.

- `atlas status`: Atlas's components and regions, the open Atlas incidents that concern the instance, its status subscription, and the state of every upstream status page it declared. Exits 1 on an Atlas major outage or a major / critical incident that concerns the instance, or an upstream partial / major outage; `--json` for scripts.
- `atlas doctor` (the integration-health report, exit 1 on a failing check) and `atlas csp` (the Content-Security-Policy sources for your pages, from the embed manifest).
- `atlas init --backchannel <url>`: sets the first-party OAuth client's back-channel logout URI (on create, or on a re-run) and points at the ready-made receivers in `@atlasauth/backend`.

## 0.8.0 — 2026-10-24

### Added

- `atlas migrate better-auth [path]`: moves a Better Auth app to Atlas end to end in resumable steps (preflight, translate, apply, export, import, bridge, code, verify), saved in `atlas-migrate/state.json`. Supports `--dry-run`, `--yes`, `--resume`, `--force`, `--skip <step,...>`, `--json`, `--entry`, `--bundle`, `--run-export` and `--bridge-days`. Placeholders are filled from the environment and the app's `.env` files, and the values are only sent to Atlas.
- `atlas migrate better-auth config [path]`: reads the app's `betterAuth({...})` options without running it and writes `atlas config import` files plus `better-auth-report.md` / `.json`. The report sorts every option into maps 1:1, maps with a difference, and needs a manual step, each with its file and line. Secrets become `${ENV}` placeholders; a secret hard-coded in source is flagged and never copied.
- `atlas config import` / `export`: new `permissions` (applied before `roles`) and `custom_oauth_providers` resource files. Provider settings (Microsoft tenant, Okta domain, Apple team and key ids, SIWE domain) are passed through.
- `atlas import --from better-auth --bundle <file>`: uploads the encrypted bundle from `npx atlas-better-auth-export`, prints the dry-run report (per-model counts, conflicts, action items), asks, then imports with live progress. `--import <id>` applies an uploaded import or resumes one that stopped; `--dry-run`, `--confirm-conflicts`, `--options <json|@file>`, `--yes`, `--json`. With no bundle it prints the instance import key and the export command.

### Changed

- `atlas config import`: an `instance` file without `allowed_origins` now leaves the live origins as they are, instead of clearing them.

## 0.7.0 — 2026-10-24

### Added

- `atlas migrate code --from <clerk|authjs|supabase|auth0|better-auth> [path]`: rewrites an app's auth code onto Atlas. A dry run with a diff unless `--yes`; prints what needs a manual look with file and line, the packages to add and remove, and the env vars to set; `--json`.
- `atlas info [path]`: CLI, Node and OS versions, the framework and Atlas SDK packages with update-available from npm, the configured instance (key prefixes only) and whether the app's publishable key belongs to it, API reachability and latency, and the preflight summary; `--json`; secrets redacted.
- `atlas actions gallery | show | install | installs | update | publish`: the Actions gallery. Secret values come from `--secrets-file` (dotenv), never argv.

## 0.6.0 — 2026-10-23

### Added

- `atlas import --from <auth0|clerk|supabase|firebase|cognito|authjs|workos|better-auth> <file>`: maps each provider's export onto the bulk import, with `--dry-run`, resumable upsert batches (`--state-file`), `--hashes`, `--hash-config` and `--create-orgs`.
- `atlas mcp install --cursor | --claude-code | --codex | --vscode`: adds the Atlas MCP server (docs search) to the agent's config.

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
