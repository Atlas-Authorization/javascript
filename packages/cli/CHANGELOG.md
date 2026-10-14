# @atlasauth/cli changelog

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
