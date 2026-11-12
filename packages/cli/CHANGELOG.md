# @atlasauth/cli changelog

## 0.35.0 — 2026-11-11

- `${instance.fapi_host}`, `${instance.frontend_api_url}` and `${instance.id}` in atlas.yaml, filled in from the instance the key targets, so a config can name the instance's own sign-in host before it is known.
- `atlas apply --secrets-out <file>`: every secret apply generates goes into one 0600 dotenv file, merged with what is there. An existing webhook endpoint's secret is read back once if the file lacks it (never rotated).
- `atlas suite plan|apply <suite.yaml>`: run several config-as-code tools in dependency order, with one exit code (2 on drift).
- `hooks.before_user_create.enabled: pending`: declare the hook before the app is deployed; Atlas turns it on when its test passes, and `plan --check` stays clean after.
- `cookie_consent.site: { provider, host }` instead of a copied `site_id`.
- `atlas apply --help` lists every section in apply order, including `sign_in_with_atlas`.

## 0.34.0 — 2026-11-11

- `atlas login --device` opens the sign-in page in your browser (not in CI or without a terminal). `--no-browser` only prints the link.

## 0.33.1 — 2026-11-11

- `atlas connection-limits get|set|relay-get|relay-set`: read and set the connection-token rate limits (per key, per connection, per provider, with current usage) and the relay size limits.
- `appApproval` in the instance `auth_config` plans and applies like any other setting.

## 0.33.0 — 2026-11-11

- `scopes` in config files (the instance scope catalogue: labels per locale, `sensitive`, `requires_verified_client`).
- `atlas migrate` takes `--password-policy` to hold imported passwords.

## 0.32.0 — 2026-11-11

- New `atlas keys rotate <id> --preset app-runtime --overlap 72h`: writes the new key to a 0600 file and says when the old one stops. `golive` prints that command for every in-use all-scope key.
- `plan` compares integration `spaces` by id: bare ids match the stored spaces, so they plan as unchanged.

## 0.31.0 — 2026-11-11

### Added
- `atlas plan` compares webhook `enabled_events` preset-aware: a file using `preset:user_mirror` or `preset:org_mirror` matches an endpoint that stores the expanded list, so `plan --check` exits 0 after one apply.
- `integrations` in config files accepts every field the integrations API takes (`org_id`, `spaces`, `channel`, `claims`, `principal_claim`, `ext_claim`, `per_call_audience`, `audience_format` and the rest), diffed by `plan`; it can also be a map keyed by integration id.
- `atlas golive --connect … --config <file>` sends the file's `integrations`, `referrals` and `privacy_orchestrator` settings; keys files also take `<PARTNER>_ORG_ID`, `<PARTNER>_SPACES` and `<PARTNER>_CHANNEL`. `--connect cookiemunch` also registers the Atlas executor and the rights identity on your Cookie Munch site with your `COOKIEMUNCH_API_KEY`.
- `atlas golive` lists platform-provisioned secret keys unused for 14 days and offers to revoke them (`--revoke-unused-platform-keys` without a prompt).
- `atlas init nextjs-local-users [--dir <dir>]` creates the Next.js local users and organizations template.

## 0.30.0 — 2026-11-11

### Added

- `atlas plan` / `apply` manage `domains`, `integrations`, `referrals`, `privacy_orchestrator` and `proxy_secret`, with a field diff and `--check` exit 2 on drift. A new proxy secret goes to a 0600 file, never the terminal.
- `webhook_endpoints` take `signature_versions` and `external_ref`; a `secret: ${ENV}` is used as written.
- `atlas golive --connect cookiemunch,forumulate,chatly,referalli --keys-file <0600 file>` connects the partners and prints events receiver, minted token and redeem host per integration.
- `atlas keys create --preset app-runtime`.
- `atlas dev proxy --base-path /atlas` mounts the API under a path.

### Fixed

- The README no longer says the email provider and the `before_user_create` hook are outside config files; they are managed types.

## 0.29.0 — 2026-11-05

- `atlas users protect <id>`; `atlas init` writes each environment to its own folder; import names rows it refused.

## 0.28.0 — 2026-11-05

### Changed

- `--password-policy until_email_verified --on-conflict update` holds existing unverified rows that have a password.
- The import warns by name about `unverified_without_hold` and `password_policy_not_applied` rows.
- Unknown keys inside `password_hash_params` exit 1 before anything is sent.
- The headline reads `Imported X of N row(s)`.
- `doctor --scan-dir` catches mixed keys across a folder and its subfolder.

## 0.27.0 — 2026-11-05

### Changed

- **`atlas import users.jsonl` refuses unknown row keys** before sending anything, exit 1, naming the line, each key and its nearest match. A file with an extra column stops working until it's fixed.
- **`plan` and `apply` refuse a provider `mode` other than `native` or `redirect`**, exit 1. It used to be dropped silently and then show as drift on every run. `mode: null` is refused too: leave the key out.
- **`plan` and `apply` check a webhook `secret`'s format locally**, whether or not it can be compared: `whsec_` (or `atlas_live_whsec_` / `atlas_test_whsec_`) and 32 to 256 characters. Exit 1, and the value is never printed. A malformed secret on an existing endpoint used to be a silent no-op.
- **`atlas init` keeps environments apart.** When the folder already holds another environment's key, the new one goes in `<env>/`, and a line says so. An existing `<env>.env` for the same environment stays where it is. Readers go through the manifest, so `atlas env` and `atlas preflight` find it.

### Added

- `password_hash_params` on an import row. It's sent with the row's `algorithm` as `password_hash_algorithm`, so a hash whose salt was hex-decoded (`"password_hash_params":{"salt_encoding":"hex"}`) signs in. With no `algorithm`, a `scrypt$N$r$p$salt$key` string is named `scrypt_node`.
- `warnings` in the import report (`warnings` array in `--json`), each with a code, count and external ids, never a hash: `ambiguous_scrypt_salt` for a hex-looking scrypt salt with no `salt_encoding`, which may never sign in, and `unsupported_password_hash` for a row the API refused, with its reason.

### Fixed

- `algorithm: scrypt_node` or `scrypt_django` on an import row now settles a scrypt hash with an all-digit salt, which used to be refused.

## 0.26.0 — 2026-11-05

### Security

- `atlas plan`, `apply`, `preflight`, `golive` and their `--json` forms no longer print secrets, and API error messages are masked. **If you ran `atlas plan` on 0.25.1 or older with a provider `client_secret` in the file, the value was printed: rotate every provider secret that was ever planned, and treat terminal and CI logs from those runs as exposed.**
- Masking happens where output is written: secret-named fields at any depth, Atlas-key-shaped values, and values a `${VAR}` resolved to, except under `client_id`, `provider`, `from_address` and plain URLs. A changed secret prints `client_secret: <redacted> (changed)`.
- `--show-secrets` prints values in a terminal only: it is refused when stdout is not a TTY or `CI` is set.

### Added

- `webhook_endpoints` in a config file take `secret` (`${VAR}`). A changed secret on an existing endpoint is rotated, with no overlap: the old secret stops signing at once.
- `atlas import users.jsonl`: Atlas's own JSONL shape, idempotent by `external_id`, with `--dry-run`, `--since`, `--on-conflict skip|update` and `--password-policy active|until_email_verified`. Reports counts and no email addresses. Vendor imports take the same flags.
- `atlas users clear-password <id>`.
- `atlas golive` prints the issuer before and after, and the `previousIssuers` value to copy, before a step that moves the issuer, and stops unless `--yes`.
- `atlas preflight --fix [--yes]` applies the fixes the server marks safe, then runs the checks again. Normal output prints each finding's exact call when it has one.
- `atlas doctor --scan-dir <path>` and `--scan-image <ref>` flag secrets in build metadata and folders holding both a development and a production key. They print the file and line, never the value, and exit 1 on a finding.
- `atlas init --with-dev`, `--no-env-files` (with `--json`), and `--next --mount <path>`.
- `atlas setup-guide`: the setup calls in order, with the read-back for each.
- `--rotate-secret` on `plan` and `apply` sends again each secret Atlas cannot compare.

### Changed

- **`plan` and `apply` now refuse unknown keys in a config file**, resource by resource, naming the nearest real key.
- A secret set both in the file and on the instance is no longer permanent drift. Atlas never returns it, so a changed value is not detected: the plan says so, and `--rotate-secret` sends it. Provider `values` work the same way.
- `atlas apply` prints field-level changes, and `Atlas-Unknown-Fields` as a warning on a lenient instance.
- `atlas init` turns on strict request bodies unless the instance has them or has explicitly opted out.

### Fixed

- A provider's `mode` is sent and compared, so a plan after apply is clean. A provider that leaves `mode` out shows no drift. `plan` warns on `mode: redirect` with no `client_secret`, and on a secret in native mode.

## 0.25.1 — 2026-11-03

### Fixed

- 0.25.0 was published without its build output and does not run; 0.25.1 is the same change, built.

## 0.25.0 — 2026-11-03

### Added

- `signing_key_policy` config section: `prepublish_days` (1..90, or `null` / `0` for off) is planned, applied and exported like any other setting.

## 0.24.0 — 2026-11-03

### Added

- `atlas.config.ts` (also `.mts`, `.mjs`, `.js`): `atlas plan` / `atlas apply` load its default export (an object, or a sync or async function returning one) the same way they read `atlas.yaml`. `defineConfig` is exported for typing. `.ts` needs Node 22.18+ / 23.6+ (built-in type stripping).
- With no path, `atlas plan` and `atlas apply` pick up `atlas.config.ts`, `atlas.config.mts`, `atlas.config.mjs`, `atlas.config.js`, `atlas.yaml`, `atlas.yml` or `atlas.json` from the current directory before falling back to `./atlas-config`.

## 0.23.0 — 2026-11-03

### Added

- `atlas golive --origin <url> [--dry-run] [--json]`: domains, issuer, Sign in with Atlas, webhooks (test, then activate), hooks (test, then enable), preflight, login readiness and declared integrations, in order, stopping at the first failure with its fix. `--dry-run` sends every write with `?dry_run=true`.
- `atlas doctor --origin <url>`: adds preflight errors, login readiness, the path-mount verification state and the SDK cookie declaration check (`__session`, `__atlas_uat`, `__atlas_rt`, `__client`) to the same report.
- `atlas referrals connect --dry-run`: lists the platform calls it would make and validates the Atlas settings write with `?dry_run=true`; nothing is saved, no secret is kept, no test runs.

### Changed

- The old `REFERALLY_BASE_URL` / `REFERALLY_API_KEY` environment names now produce one notice per run naming each variable to rename.

## 0.22.0 — 2026-11-02

### Added

- `sign_in_with_atlas` section: `{ enabled: true }` turns on the hosted pages' "Sign in with Atlas" button (`PATCH /v1/instance/sign_in_with_atlas`); optional `connection_id` links an SSO connection the instance already has. Plan compares and export writes only `enabled`.

## 0.21.0 — 2026-11-02

### Changed

- Webhook endpoints a connected platform created and holds (`managed_by` set) are no longer part of the managed set: `atlas plan` lists them under "Managed by a connected platform" (`managed_by_platform` in `--json`) instead of "Live but not in …", `--prune` never deletes them, and `config export` omits them.

## 0.20.0 — 2026-11-02

### Added

- New file sections `cookie_consent` (the `PUT /v1/instance/cookie_consent` body; the plan compares only the keys the file sets, e.g. `~ cookie_consent enabled: false -> true`) and `sso_onboarding_profiles` (matched by `name`; created with POST, updated with PATCH; `--prune` deletes live profiles the file lacks, otherwise they are listed as kept). Planned, applied and exported. Apply order: `sso_onboarding_profiles` right after `sso_connections`, `cookie_consent` last.

### Fixed

- `atlas plan` / `atlas apply` messages name the file you passed (`Live but not in deploy/atlas.yaml`), not the temporary directory a single file is split into.

## 0.19.0 — 2026-11-02

### Added

- `atlas referrals connect` sends the instance's app origins to the platform (`allowedOrigins` on the connection), and `--enable` makes Atlas read the referral code of existing users (10 per second at most); `--no-identity-backfill` skips that.

### Fixed

- An explicit `null` in a config file now clears a nullable field on update (`login_url`, `consent_url`, `logo_url`, `backchannel_logout_uri`, branding, hook `url`, ...); an absent key stays unmanaged. The plan shows `value -> null` and is clean afterwards.
- `atlas plan` / `atlas config plan` no longer report drift on a freshly applied instance. Without `--prune` they compare only the keys the file sets (singletons and collection rows, recursively); `--prune` keeps the full comparison and shows unset keys.
- OAuth clients round-trip every field the API returns and accepts: `post_logout_redirect_uris`, `claims_redirect_uris`, `backchannel_logout_uri`, `backchannel_logout_session_required`, `frontchannel_logout_*`, `skip_logout_confirmation`, `refresh_touches_session`, `require_verified_email`, `require_pkce`, `login_url`, `consent_url`, `subject_type`, `sector_identifier_uri`, `access_token_format`, `token_lifetimes`.
- `instance.allowed_origins` accepts strings and `{ origin, integration }` objects and compares them as the same thing; `auth_config.originIntegrations` is ignored in the comparison, and integration hints are kept when the file lists plain strings.
- `webhook_endpoints[].active` is sent on create, so a paused endpoint is never live, even briefly.

### Added

- New file sections `email_provider`, `hooks.before_user_create` and `branding`, applied, planned and exported (secrets only through `--secrets-file` / env, shown as `(secret set)`). Apply order: `email_provider` first, `hooks` after `oauth_clients`, `branding` last.
- `--force-hook` on `apply` / `config import`: enable a `before_user_create` hook although its test call fails. Without it, a 409 `HOOK_TEST_FAILED` is reported with the hook left unchanged.

## 0.18.1 — 2026-11-02

Depends on `@atlasauth/backend` 0.31.1 (0.18.0 pinned 0.31.0, which was never published). No code changes.

## 0.18.0 — 2026-11-02

### Fixed

- `atlas referrals connect --provider referalli` registers the two-way sync webhook limited to `--program` (`programIds: [<program>]`). It used to register it for every program, so a shared Referalli organization sent other products' referral events to the instance. A webhook an earlier run registered for every program is re-scoped in place.
- `connect` is idempotent: a second run reuses the instance's existing Referalli connection (one per instance) and sync webhook and updates them in place, never creating a duplicate. A secret the instance does not already hold is rotated on Referalli and saved (never printed). A connection for the instance in another program is refused with the program to use.
- `connect` sets `tracking_token` (from the Referalli organization) and `link_template` (`{link host}/go/{tracking token}/{code}`, on the active link domain when there is one); a link template set before is kept. What it cannot read is printed as the exact `PATCH /v1/instance/referrals` body left to send (`left_to_do` with `--json`).

### Added

- `connect --link-template <url>`.
- `atlas referrals status --json` prints a `status` object (connection id, program, webhook endpoint id, URL and program scope, `link_template_set`, `tracking_token_set`, last sync, last test) next to the raw `settings`. The webhook scope is read from Referalli when a merchant key is given (`--referalli-key-file` or `REFERALLI_API_KEY`); otherwise it is `unknown`. The text output shows the link template, tracking token and, when known, the webhook scope.

### Dependencies

- Pulls `@atlasauth/backend` 0.31.0, which depends on the published `@atlasauth/pca` ^0.4.3 instead of the deprecated 0.1.0, and `@atlasauth/upgrade` 0.7.0, which drops the deprecated `jscodeshift` 0.16 chain (`rimraf@2`, `glob@7`, `inflight`).

## 0.17.0 — 2026-10-30

### Added

- `atlas referrals backfill --own-map <file.csv>` and `--own-metadata-path <path>`: keep each user's own referral code (the one they share) through a backfill. The command reports how many were kept and names the customer refs whose code another user already holds.

## 0.16.0 — 2026-10-30

### Fixed

- `atlas info` now redacts suite-format keys (`atlas_live_sk_…`, `atlas_test_psk_…`, webhook secrets and the rest). It used to print them in full, and the key prefix line now recognises them.

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
