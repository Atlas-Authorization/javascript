# @atlasauth/cli

`atlas` — manage an Atlas instance from the terminal, over the secret-key
Backend API. The peer of `auth0-cli` and Clerk's `cli`, built directly on
[`@atlasauth/backend`](../backend).

## Install

```sh
npm i -g @atlasauth/cli
# or run without installing:
npx @atlasauth/cli --help
```

## Authentication

The CLI is config-file + secret-key based, like `auth0-cli`'s token model — no
dashboard OAuth app to register against.

```sh
atlas login                 # prompts for an API URL + an sk_ key, validates it
atlas login --profile prod  # store a second, named credential
atlas whoami                # show the active profile + instance (key masked)
atlas logout                # forget a stored credential
```

`login` validates the key with one cheap Backend call before saving it to
`~/.config/atlasauth/config.json` (mode `0600`). `--url` / `--secret-key` skip
the prompts for CI.

Env overrides (win over the stored profile, like most cloud CLIs):

```sh
ATLAS_SECRET_KEY=sk_live_... ATLAS_API_URL=https://api.atlasauth.net atlas users list
```

## Commands

```
atlas users    list | get <id> | create --email <e> | delete <id>
atlas orgs     list | get <id> | members <id>
atlas api-keys list | create --subject-type <t> --subject-id <id> | revoke <id>
atlas webhooks list | create --url <url> [--events a,b]
atlas sessions revoke <id>
atlas config   export [--dir <path>] [--format json|yaml]
atlas config   import [--dir <path>] [--format json|yaml] [--dry-run] [--prune] [--force-hook]
atlas plan     [<file|dir>] [--check] [--json] [--secrets-file <dotenv>]
atlas apply    [<file|dir>] [--yes] [--check] [--prune] [--secrets-file <dotenv>] [--out <dir>]
atlas init     --product <name> [--domain <d>] [--instance-env development|production] [--with-dev] [--no-env-files --json] ...
atlas init     --next [--mount /atlas] [--dir <app-root>]
atlas init     nextjs-local-users [--dir <app-root>]
atlas setup-guide [--json]
atlas preflight [--instance <id> | --product <name>] [--fail-on error|warning] [--fix [--yes]]
atlas doctor   [--origin <url>] [--only <sources>] [--no-probe]
atlas doctor   --scan-dir <path> [--scan-image <ref>]
atlas golive   --origin <url> [--dry-run] [--yes] [--connect cookiemunch,forumulate,chatly,referalli] [--keys-file <f>] [--config <file>] [--revoke-unused-platform-keys]
atlas keys     rotate <id> [--preset app-runtime] [--overlap 72h] [--out <file>]   # new secret goes to a 0600 file, the old key works for the overlap
atlas keys     create (--scopes "<scopes>" | --preset app-runtime) [--name n]
atlas dev      proxy --app <url> --api <fapi url> [--base-path /atlas]
atlas referrals connect ... [--dry-run]
atlas env      --product <name> --format dotenv|coolify|vercel
atlas client   rotate <client-id> [--now | --overlap <seconds>]
atlas import   <users.jsonl> [--dry-run] [--since <ts>] [--on-conflict skip|update] [--password-policy active|until_email_verified]
atlas import   --from <vendor> <export-file> [--dry-run] [--since <ts>] [--on-conflict skip|update] [--password-policy ...]
atlas users    clear-password <user-id>
atlas migrate  code --from <clerk|authjs|supabase|auth0|better-auth> [path] [--yes]
atlas info     [path]
atlas actions  list | deploy <file> | test <file> | gallery [query] | show <slug>
               | install <slug> [--secrets-file f] | installs | update <id> | publish <template.json>
```

Every command takes `--json` for raw JSON (otherwise a human table). Paginated
lists (`users list`, `orgs list`) take `--limit <n>` and `--starting-after
<cursor>`; the table footer prints the exact cursor flag for the next page.

```sh
atlas users list --limit 20
atlas users list --json | jq '.data[].id'
atlas api-keys create --subject-type user --subject-id user_123 --name ci
```

Run `atlas --help` or `atlas <command> --help` for details, `atlas --version`
for the version.

## Secrets go to files

Any command that receives a secret (an instance secret key, an OAuth client
secret, a webhook signing secret, an end-user API key) writes it to a `0600`
dotenv file under `~/.config/<product>/` (directory `0700`;
`~/.config/atlasauth/` without `--product`) and prints only the path. An
existing different file is never overwritten without `--force`.
`--print-secret` prints it instead, with a warning.

`atlas init` keeps each environment in its own folder (`production/atlas.env`,
`development/atlas.env`), so `atlas doctor --scan-dir` stays clean whichever you set up first.
An existing `<env>.env` stays where it is. `atlas init --with-dev` also creates the development sibling. `atlas init --no-env-files --json` writes no secret file and hands
each secret over once in the JSON on stdout.

`atlas plan`, `apply`, `preflight` and `golive` never print a secret, in text or `--json`, and
API errors are masked too. A changed secret shows as `client_secret: <redacted> (changed)`.
Atlas never returns a stored secret, so when it cannot tell whether yours changed the plan says
so instead of showing drift, and `--rotate-secret` sends it again. `--show-secrets` prints values
in a terminal only: it is refused when stdout is not a TTY or `CI` is set.

## Set up an app (`atlas init`)

```sh
export ATLAS_PLATFORM_KEY=psk_...      # or: atlas login --secret-key psk_...
atlas init --product acme --domain acme.com \
  --email-provider resend --email-key-file ~/.secrets/resend.key \
  --strategies password,email_code,passkey \
  --client-redirect https://app.acme.com/auth/callback \
  --webhook-url https://app.acme.com/hooks/atlas --yes
```

Finds or creates the app + instance, sets the strategies, the email sender
(`--email managed|development|none`, always on your own provider account; the
key comes from `--email-key-file`, or stdin with `-`, never argv; managed
prints the DNS records), the custom
domain (`auth.<domain>`, prints the CNAME), a first-party OAuth client and a
webhook endpoint. Re-running only fills gaps. Secrets land in
`~/.config/acme/production*.env`; public values and file paths in
`~/.config/acme/atlas.json`.

```sh
atlas preflight --product acme --fail-on warning   # CI gate: exit 1 on findings
atlas env --product acme --format dotenv           # public values + *_FILE paths
atlas client rotate oc_123 --product acme --overlap 3600
```

`atlas setup-guide` prints the order of the setup calls with the read-back for each, and
`atlas init --next --mount /atlas` writes `atlas.yaml`, the Next.js mount and verify routes and a
`.env.example` that says which variables are build args (the publishable key only). `atlas doctor
--scan-dir .` and `--scan-image <ref>` flag secrets in build metadata, printing the file and line and
never the value. `atlas preflight --fix` applies the fixes the server marks safe, asking first.

## Go live (`atlas golive`)

```sh
atlas golive --origin https://app.acme.com --dry-run   # validate every write, change nothing
atlas golive --origin https://app.acme.com
```

Runs these steps in order and stops at the first failure, with its fix:

1. **domains**: verifies the custom domain for the origin's host if it is not verified yet. If that would move the issuer, it prints both issuers and the `previousIssuers` value to add to your verifiers, and stops unless `--yes`.
2. **issuer**: the discovery document at that domain (or the path mount on your app) must serve the instance's issuer.
3. **sign_in_with_atlas**: turned on when the instance declares it.
4. **webhooks**: each inactive endpoint gets a test delivery, and is activated only if it succeeds.
5. **hooks**: a configured but disabled `before_user_create` hook gets a test call, and is enabled only if it succeeds.
6. **preflight** (no error findings) and **login_readiness** for the origin, with a live JWKS round-trip.
7. **integrations**: the referral connection, privacy integration and identity integrations the instance declares; a declared but untested referral connection is tested.
8. **unscoped_keys**: an all-scope (`*`) secret key still in use is named with the exact `atlas keys rotate <id> --preset app-runtime --overlap 72h --out <file>` command that replaces it without downtime.

`--connect` (any subset of the four partners) connects them before the integrations step, with the
keys from `--keys-file` (default `~/.config/atlas/partner-keys.env`; refused unless only you can read
it): `FORUMULATE_API_KEY`, `COOKIEMUNCH_API_KEY`, `REFERALLI_API_KEY`, and `<PARTNER>_AUDIENCE` for a
first connect. It prints a table per integration: events receiver, minted token, redeem host.

Each step prints `✓ step — detail` or `✗ step — problem` followed by `fix: …`. Exit 0 when
all pass, 1 on the first failure. `--dry-run` sends every write with `?dry_run=true`, so
nothing changes. `--json` prints `{ ok, dry_run, origin, steps: [{ id, ok, detail, fix? }] }`.

`atlas doctor --origin <url>` adds the read-only checks to the integration-health report:
preflight errors, login readiness, the path-mount verification state on that host, and
whether the consent declaration lists every cookie the SDKs read (`__session`,
`__atlas_uat`, `__atlas_rt`, `__client`).

`atlas referrals connect --dry-run` lists the calls it would make to the referral platform
and validates the Atlas settings write with `?dry_run=true`. No secret is saved or printed
and no connection test runs.

## Config-as-code (`atlas config`)

The Auth0 `deploy-cli` equivalent: round-trip an instance's configuration to a
deterministic directory tree you keep in Git. `export` writes one file per
resource type with sorted keys and **secrets omitted**; `import` diffs the
directory against the live instance and applies creates/updates idempotently.

```sh
atlas config export --dir ./atlas-config          # snapshot the instance
atlas config import --dir ./atlas-config --dry-run # preview the plan
atlas config import --dir ./atlas-config           # apply creates/updates
atlas config import --dir ./atlas-config --prune   # also delete removed resources
```

Managed resource types (the same set the Terraform provider manages):
`instance` (auth config + allowed origins), `email_provider`, `hooks` (`before_user_create`), `branding`, `oauth_clients`, `oauth_providers`,
`sso_connections`, `sso_onboarding_profiles`, `cookie_consent`, `resource_servers`, `jwt_templates`, `roles`,
`webhook_endpoints`, `billing_plans`, `redirect_urls`, `org_settings_schema`,
`notification_templates`, `email_templates`, `organization_policies`, plus `domains`,
`integrations`, `referrals`, `privacy_orchestrator` and `proxy_secret` (below).

Rules that make it safe and repeatable:

- **Deterministic.** Keys are sorted, so re-exporting an unchanged instance is a
  byte-for-byte no-op and a round-trip (`export` then `import`) is an empty diff.
- **No secrets on disk.** The management API never returns a secret on a read,
  so none is ever written. To (re)write a credential at import, put a
  `${ENV_VAR}` placeholder in the file; it is resolved from the environment.
- **Non-destructive.** `import` never deletes without `--prune`, and a resource
  type with no file is left untouched (only committed types are managed).

### One file: `atlas apply` and `atlas plan`

`atlas apply atlas.yaml` takes one JSON or YAML file whose top-level keys are
the resource types above (or a directory from `config export`), shows the plan,
asks before applying (`--yes` skips the question; needed without a terminal),
and applies. Re-running it is a no-op. `atlas plan atlas.yaml` shows the
field-level diff without writing; without `--prune` it compares only the keys
the file sets. `--force-hook` applies a `before_user_create` change (enabling it, or
re-pointing / re-keying an enabled fail-closed hook) whose test call fails (otherwise the server refuses with 409 `HOOK_TEST_FAILED`).

```yaml
# atlas.yaml
instance:
  allowed_origins: [https://app.example.com]
  auth_config:
    signUpMode: restricted
redirect_urls:
  - url: https://app.example.com/auth/callback
webhook_endpoints:
  - url: https://app.example.com/webhooks/atlas
    enabled_events: [user.created, user.updated, session.revoked]
```

```sh
atlas plan atlas.yaml --check     # CI: exit 2 when the instance differs
atlas apply atlas.yaml            # plan, confirm, apply
atlas apply atlas.yaml --yes --secrets-file .atlas.secrets   # non-interactive
```

- **CI gate.** `--check` (on `plan`, `apply` and `config plan`; alias `--exit-code`)
  exits 2 when there is drift and never writes.
- **Secrets.** `${VAR}` placeholders resolve from the environment, then from
  `--secrets-file` (a dotenv file). The file must be readable only by you
  (`chmod 600`); anything looser is refused. `apply` stops before writing if a
  placeholder is still unresolved.
- **New secrets.** When `apply` creates an OAuth client or a webhook endpoint,
  the one-time `client_secret` / signing secret goes to a mode-0600 dotenv file
  (`~/.config/atlas`, or `--out <dir>`) and the CLI prints the path.
- **Order.** The CLI applies resource types in a fixed order: `instance`,
  `org_settings_schema`, `redirect_urls`, `oauth_clients`, `oauth_providers`,
  `custom_oauth_providers`, `resource_servers`, `scopes`, `jwt_templates`, `permissions`,
  `roles`, `webhook_endpoints`, `sso_connections`, `sso_onboarding_profiles`,
  `billing_plans`, `notification_templates`, `email_templates`,
  `organization_policies`, `cookie_consent`. The
  ordering is done by the CLI, not by the server. The email provider
  (`email_provider`, any transport: Resend, Brevo, SES, SMTP, Mailgun, SMTP2GO or
  `webhook`) and the `before_user_create` hook are config file sections; the email
  provider applies first, so sign-in methods that send email find a provider.

**Domains, integrations, referrals, privacy, proxy secret.**

```yaml
domains:
  - host: app.example.com          # a path mount on your own host
    method: path
    base_path: /atlas
integrations:
  - id: forumulate
    enabled: true
    audience: forumulate:acme
    events_url: https://app.example.com/hooks/forumulate
    org_id: acme-org-id                         # forumulate: the organization
    spaces: [space-1, { id: space-2, redeem_url: https://app.example.com/redeem }]   # bare ids are expanded like stored spaces and keep their redeem URLs; plan compares by id
    forumulate_api_key: ${FORUMULATE_API_KEY}   # used for the call only, never stored
    replace_existing: false                     # forumulate: remove the org's other reader sign-ins (needs the key)
  - id: chatly
    channel: support                            # same as audience: chatly:support
    chatly_api_key: ${CHATLY_API_KEY}           # used for the call only, never stored
    claims: { org: true, org_role: true, public_metadata: [plan] }
    ttl_seconds: 120
    backchannel_logout_url: https://app.example.com/logout
    oauth_client_id: my-sign-in-client
    # Also accepted: principal_claim, ext_claim, verify_error_report_url, cmp, atlas_id_users,
    # per_call_audience, external_ref, and for a custom id: name, role, audience_format.
    # `integrations:` may also be a map keyed by id instead of a list.
referrals:
  provider: referalli
  enabled: true
  api_key: ${REFERALLI_API_KEY}
privacy_orchestrator:
  provider: cookiemunch
  site_id: ${COOKIEMUNCH_SITE}
  api_key: ${COOKIEMUNCH_API_KEY}
proxy_secret:
  set: true                        # created once; the value goes to a 0600 file
```

Each has a plan diff, and `plan --check` exits 2 when someone changes it in the dashboard (for
example, turns an integration off). A domain is only claimed, never deleted, unless you pass
`--prune`; a changed domain is refused (recreate it). `webhook_endpoints` also take `secret: ${ENV}`
(Atlas then uses your secret and nothing is written to the dotenv file), `active: false`,
`signature_versions` and `external_ref` (create only), and `enabled_events: ["preset:user_mirror"]`
is stored as written (a row that stores the expanded list plans as equal). `atlas golive` activates a paused endpoint after a
successful test delivery.

Ship it on push with the [`atlas-deploy` GitHub Action](../../actions/atlas-deploy).
