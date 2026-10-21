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
atlas config   import [--dir <path>] [--format json|yaml] [--dry-run] [--prune]
atlas init     --product <name> [--domain <d>] [--instance-env development|production] ...
atlas preflight [--instance <id> | --product <name>] [--fail-on error|warning]
atlas env      --product <name> --format dotenv|coolify|vercel
atlas client   rotate <client-id> [--now | --overlap <seconds>]
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
`instance` (auth config + allowed origins), `oauth_clients`, `oauth_providers`,
`sso_connections`, `resource_servers`, `jwt_templates`, `roles`,
`webhook_endpoints`, `billing_plans`, `redirect_urls`, `org_settings_schema`,
`notification_templates`, `email_templates`, `organization_policies`.

Rules that make it safe and repeatable:

- **Deterministic.** Keys are sorted, so re-exporting an unchanged instance is a
  byte-for-byte no-op and a round-trip (`export` then `import`) is an empty diff.
- **No secrets on disk.** The management API never returns a secret on a read,
  so none is ever written. To (re)write a credential at import, put a
  `${ENV_VAR}` placeholder in the file; it is resolved from the environment.
- **Non-destructive.** `import` never deletes without `--prune`, and a resource
  type with no file is left untouched (only committed types are managed).

Ship it on push with the [`atlas-deploy` GitHub Action](../../actions/atlas-deploy).
