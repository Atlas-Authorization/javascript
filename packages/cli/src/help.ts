import { AGENTS, AUDIT, BILLING, CATALOG, CHAT, CLOUD, PROVISIONING, SAML_IDP, CONNECTION_ACTIONS, DEVICE_SSO, FEDERATION, PDP, TELEMETRY, TRIGGERS, VC, WORKFLOWS, type Ops } from './commands/resources';
/**
 * All help text lives here as plain strings — the CLI's "docs" surface. Kept
 * out of the handlers so the dispatch code stays about control flow and the
 * copy can be read (and kept consistent) in one place.
 */

export const TOP_HELP = `atlas — manage an Atlas instance from the terminal

Usage: atlas <command> [subcommand] [arguments] [options]

Commands:
  login                      Authenticate and store a profile credential
                             (--device: operator sign-in in the browser, no key stored)
  token --resource <id>      A one-hour token for one instance/app from your operator sign-in
  keys whoami|list|create|rotate|revoke|revoke-leaked|data|op
                             Scoped secret keys; new secrets go sealed into 0600 files
  logout                     Remove a stored profile credential
  whoami                     Show the active profile and instance
  users list|get|create|merge|delete
  orgs list|get|members
  api-keys list|create|revoke
  webhooks list|create|upsert|update|test|deliveries|redeliver|replay|rotate|reveal
  listen --forward-to <url>  Forward live events to your local server, signed (no tunnel)
  dev [proxy]                Local in-memory Atlas (emulator) / one-origin dev proxy
  move-origin --from --to    Move an app to a new domain in one step (--dry-run first)
  workflows list|run|resume|status|templates|approvals|decide
  chat list|test|links|interactions   Chat approval integrations
  cloud targets|setup|login <id>      Cloud access portal (AWS, Google Cloud, Azure)
  device-sso list|show|revoke|delete  Native OS single sign-on registrations
  connection-actions catalog|list|run|define|remove
  triggers list|get|create|set|delete Connection triggers
  agents list|lifecycle|renew|activity|reviews|review-decide ...
  telemetry show|set|test             OTLP export of gateway and relay calls
  pdp list|remove                     Local decision points
  billing coupons|credits ...         Discount codes and account credit
  audit retention|set-retention       Audit log retention
  federation show|resolve             OpenID federation
  vc deferred|approve|deny            Deferred credential issuance
  csp --framework next|express|nginx
                             Print the Content Security Policy sources Atlas needs
  fga test|validate|transform <file>
  fga export|import|watch|materialize <store>
                             Run .fga.yaml test suites, validate and convert authorization models
  integrations list|get|set|remove|deliveries   Identity integrations (chat, docs, consent, referrals, custom)
  partner-platforms list|get|set|registration|token|deliveries|remove
                             This instance as a partner platform (signed consent deliveries in)
  id-accounts provision|list|rotate|remove
                             Test and review accounts for a Sign in with Atlas app (passwords go to 0600 files)
  admin id-accounts list|provision|extend|rotate|revoke
  admin developer-accounts provision|revoke
                             Atlas staff: accounts for other platforms' integration teams
                             (operator sign-in with a recent second factor; passwords to 0600 files)
  sessions revoke
  config export|import|plan|promote
                             Config-as-code: round-trip the instance's config; plan = drift diff;
                             promote = copy one environment's config to another
  actions list|deploy|test|logs|gallery|show|install|installs|update|publish
  pages list|push|preview|promote|pull|discard
                             Code-defined hosted-page templates: draft, signed preview link, promote
  init                       Create or complete an app's setup (idempotent); secrets to 0600 files
  preflight                  Check an instance's setup; non-zero exit on errors (for CI)
  doctor                     Integration health: webhooks, logout, referrals, email, consent (exit 1 on a failure)
  env                        Print deploy variables: public values + secret file paths
  client rotate              Rotate an OAuth client secret straight into its file
  referrals connect|backfill|resync|status
                             Connect a referral platform, backfill, check the connection
  status                     Atlas status, incidents that concern the instance and its
                             upstream status pages; non-zero exit on an outage
  import --from <vendor> <file>
                             Move users from Auth0, Clerk, Supabase, Firebase, Cognito,
                             Auth.js, WorkOS or Better Auth (resumable; --dry-run first)
  migrate code --from <vendor> [path]
                             Rewrite an app's auth code onto Atlas (Clerk, Auth.js,
                             Supabase, Auth0, Better Auth); a dry run with a diff unless --yes
  migrate better-auth [path] Move a Better Auth app to Atlas end to end: config, users,
                             sessions and code, resumable (--dry-run, --resume, --yes)
  migrate better-auth config [path]
                             Translate the app's betterAuth({...}) options into Atlas
                             config files plus a report (offline)
  migrate <vendor> [step] [path]
                             Move from any vendor (config, export, import, bridge, lazy):
                             resumable; vendor credentials never leave this machine
  info [path]                Print the environment for a support ticket (versions, SDKs,
                             instance, API latency, preflight); secrets redacted
  mcp install                Add the Atlas MCP server (docs search) to Cursor, Claude Code,
                             Codex or VS Code

Global options:
  --profile <name>           Use a named profile (default: active, else "default")
  --json                     Emit raw JSON instead of a human table
  --limit <n>                Page size for list commands that paginate
  --starting-after <cursor>  Pagination cursor (from a prior page's hint)
  -h, --help                 Show this help, or help for a command
  -v, --version              Print the version

Environment overrides:
  ATLAS_SECRET_KEY           Secret key to use instead of the stored one
  ATLAS_API_BASE             API URL to use instead of the stored one
  ATLAS_API_URL              Same (the older name); ATLAS_API_BASE wins when both are set
  ATLAS_PLATFORM_KEY         Platform key (psk_) for atlas init
  REFERALLI_BASE_URL         Referalli base URL for atlas referrals connect
  REFERALLI_API_KEY          Referalli merchant key for atlas referrals connect (never stored)
                             (the old REFERALLY_BASE_URL / REFERALLY_API_KEY still work, with a notice)

Secrets: a command that receives a secret writes it to a 0600 file under
~/.config/<product>/ and prints only the path. --print-secret prints it instead.

Run 'atlas <command> --help' for command-specific help.`;

/** Per-command help, keyed by the resource word. */
export const COMMAND_HELP: Record<string, string> = {
  migrate: `atlas migrate — move an app's auth onto Atlas

Usage:
  atlas migrate code --from <vendor> [path] [--yes] [--json]
  atlas migrate better-auth config [path] [--dir <dir>] [--format json|yaml] [--entry <file>] [--json]
  atlas migrate better-auth [path] [--dry-run] [--yes] [--resume] [--force] [--json]
        [--dir <dir>] [--state-file <file>] [--entry <file>] [--bundle <file>] [--run-export]
        [--confirm-conflicts] [--bridge-days <n>] [--skip <step,...>]
  atlas migrate <vendor> [path] [--dry-run] [--yes] [--resume] [--force] [--json]
        [--set name=value ...] [--skip <step,...>] [--bridge-days <n>] [--confirm-conflicts]
  atlas migrate <vendor> config|export|import|bridge|lazy [path] [--set name=value ...]
  atlas migrate export <vendor> [path]      (same as: atlas migrate <vendor> export)
  atlas migrate custom export --file <records.ndjson|.json> [path]

migrate <vendor> is the program for every other vendor, one plugin each
(atlas migrate --help lists them). Steps, checkpointed in
atlas-migrate/<vendor>/state.json (--state-file):
  preflight  instance and key
  config     read the vendor's configuration, write Atlas config files and
             <vendor>-report.md (1:1 / differs / manual, with where each came from)
  export     read the vendor (its API with YOUR vendor credentials, an export
             file, or your database) and write atlas-migrate/<vendor>/bundle.atlas,
             sealed to this instance's import key; resumable from a checkpoint
  import     upload, dry-run report, confirm, import (resumes a stopped import)
  bridge     accept the vendor's sessions for --bridge-days (default 30)
  lazy       verify passwords against the vendor on first sign-in (vendors whose
             hashes never leave them)
  code       atlas migrate code --from <vendor>, after a confirmation
  verify     the import's counts and a checklist
Vendor settings and credentials are --set name=value (e.g. --set auth0-domain=…)
or the environment variable the plugin names; they are used here only.

Self-hosted frameworks (authjs, lucia, passport, iron-session, devise, django)
keep users in your own database, so nothing calls a vendor: config reads your
app's source, and export reads table dumps you make with your own tools
(--set dump=<dir>: one <table>.csv/.json/.ndjson per table) or, for devise and
django, the export script it writes on the first run, piped in with --file -.

migrate better-auth config reads your betterAuth({...}) setup statically (it
follows imports and resolves env vars by NAME, never their values) and writes
Atlas config-as-code files (the 'atlas config import' format) plus
better-auth-report.md: what maps 1:1, what maps with a difference, and what
needs a manual step, each with file:line. Default --dir: atlas-migrate/config.

migrate better-auth runs the whole program, checkpointing each step in
atlas-migrate/state.json (--state-file):
  preflight  instance and key, CLI version, the betterAuth() call
  translate  the config files and report (as above)
  apply      review the diff, confirm, push the config (env placeholders are
             filled from the environment and the app's .env files)
  export     run the exporter in the app (prints the command; --run-export runs it)
  import     upload the bundle, dry-run report, confirm, import (conflicts with
             existing Atlas users need --confirm-conflicts; a stopped import resumes)
  bridge     accept Better Auth sessions for --bridge-days (default 30): no forced logout
  code       atlas migrate code --from better-auth, after a confirmation
  verify     counts, preflight and a sign-in checklist
--dry-run walks every step without changing the instance or the code. --yes
answers every confirmation. --resume continues a stopped run. --json prints the
step summary (with --json and no --yes it stops at the first confirmation).

Code rewrite (migrate code):

Vendors:
  clerk        @clerk/* SDKs
  authjs       Auth.js / NextAuth (next-auth v4 and v5, @auth/*)
  supabase     Supabase Auth (supabase.auth.*, auth-helpers, auth-ui); the
               Supabase client itself stays for your database
  auth0        @auth0/auth0-react, @auth0/nextjs-auth0 (v3 and v4), @auth0/auth0-spa-js
  better-auth  better-auth (client, server, Next.js handler, cookies)
  lucia        lucia v2 / v3 (validateSession, cookies, invalidate…): TODO markers
               naming the Atlas call for each, since no call has the same shape
  passport     passport + express-session (initialize, session, authenticate('jwt'),
               req.isAuthenticated()); strategies and req.user are reported
  iron-session getIronSession() reads of the user id -> auth()
  keycloak     keycloak-js, @react-keycloak, keycloak-connect, the Keycloak Auth.js provider
  ory          @ory/client, @ory/nextjs, @ory/elements (Kratos and Hydra)
  zitadel      @zitadel/react, @zitadel/node, @zitadel/next
  logto        @logto/react, @logto/next, @logto/node and the other Logto SDKs
  supertokens  supertokens-node, supertokens-web-js, supertokens-auth-react
  authentik    react-oidc-context / oidc-client-ts pointed at authentik, @goauthentik/api
  fusionauth   @fusionauth/react-sdk, @fusionauth/typescript-client and the other FusionAuth SDKs
  hanko        @teamhanko/hanko-elements and hanko-frontend-sdk
  openid-client  openid-client (Issuer.discover, authorizationUrl, callback, endSessionUrl)
  jose         jose used to verify OIDC ID tokens (jwtVerify + createRemoteJWKSet)
  generic-oidc a hand-rolled relying party (discovery, PKCE, code exchange, JWKS) found
               by its code; replaced by oidc.start / oidc.callback / oidc.logoutUrl
  firebase     firebase/auth (modular and v8 compat), react-firebase-hooks, FirebaseUI,
               firebase-admin auth calls; Firebase itself stays for Firestore/Storage
  cognito      aws-amplify/auth (v6 and v5 Auth), Hub auth events, @aws-amplify/ui-react,
               amazon-cognito-identity-js, aws-jwt-verify
  azure-ad-b2c @azure/msal-browser, @azure/msal-react, @azure/msal-node, passport-azure-ad
  entra-external-id  the same MSAL rewrite, for Entra External ID tenants
  appwrite     the Appwrite Account API (new Account(client)), node-appwrite Users/Teams;
               Databases/Storage stay
  pocketbase   pb.authStore and collection auth calls; collections and files stay
  nhost        @nhost/react / @nhost/nextjs hooks and nhost.auth.*; GraphQL/Storage stay

What it rewrites: imports, providers, hooks, server session helpers, middleware,
sign-in/out calls and env var names, onto native Atlas APIs and the drop-in
compat helpers in @atlasauth/react/compat and @atlasauth/nextjs/compat that keep the
old shapes. Everything it cannot rewrite is listed with file:line and marked in
code with TODO(atlas-migrate).

Options:
  --yes                  Write the changes (without it: a dry run printing the diff)
  --dry-run              Force a dry run even with --yes
  --json                 Machine-readable result (diffs, report, packages, env)

Safe to re-run: migrated code is left as it is. Move your users with
'atlas migrate <vendor>' (Clerk, Auth0, Okta, Kinde, Descope, Better Auth) or
'atlas import --from <vendor> <export-file>'.`,
  info: `atlas info — the environment, for support tickets

Usage:
  atlas info [path] [--json] [--product <name> | --instance <id>]

Prints the CLI, Node and OS versions; the project's framework and Atlas SDK
packages with the installed version and whether npm has a newer one; the
configured instance (key prefixes only, never a key) and whether the app's
publishable key belongs to it; API reachability and latency; and the
instance's preflight summary. Network steps time out after 5 s and are
reported, not fatal. Anything shaped like a secret is redacted.`,
  import: `atlas import — move users from another auth provider

Usage:
  atlas import --from <vendor> <export-file> [--dry-run]
  atlas import --from better-auth --bundle <file> [--dry-run] [--yes]
  atlas import --from better-auth --import <id> [--confirm-conflicts]
  atlas import --from better-auth             (prints the import key and export command)

Vendors and the file each one reads:
  auth0        the user export job (NDJSON/JSON); --hashes <file> merges the password export
  clerk        the dashboard CSV export, or users JSON from the Backend API
  supabase     auth.users rows as CSV or JSON (with an identities array for social links)
  firebase     firebase auth:export --format=json; needs --hash-config <file>
  cognito      aws cognito-idp list-users JSON, or the user-pool CSV
  authjs       the adapter's users + accounts tables as JSON
  workos       User Management users JSON (+ organization_memberships)
  better-auth  JSON of the user, account, member and organization tables

Options:
  --dry-run              Map and summarise only; nothing is sent
  --batch-size <n>       Users per request, 1-100 (default 100)
  --state-file <file>    Progress file (default <export-file>.atlas-import.json); re-running resumes
  --hash-config <file>   Firebase hash parameters: {signer_key, salt_separator, rounds, mem_cost}
  --hashes <file>        Password hashes keyed by email, merged onto the users
  --create-orgs          Create organizations that memberships name but that do not exist yet
  --json                 Machine-readable summary

Better Auth bundle (npx atlas-better-auth-export --out <file> --public-key <key>):
  --bundle <file>        Upload the sealed bundle, show the dry run, then apply
  --import <id>          Continue an uploaded import (apply it, or resume a failed one)
  --confirm-conflicts    Apply although the dry run found conflicts with existing users
  --options <json|@file> Import options, e.g. '{"import_sessions":false}'
  --yes                  Apply without asking

Batches are sent with upsert, so a resumed or repeated run never duplicates a
user or a membership. Exit code 2 means some rows were reported as issues.`,
  mcp: `atlas mcp — connect AI coding agents to Atlas

Usage:
  atlas mcp install --cursor | --claude-code | --codex | --vscode [--dir <project>] [--global]
  atlas mcp gateways | upstreams <gw> | upstream-add|upstream-test|upstream-remove | packs|pack-add|pack-remove
  atlas mcp pins <gw> | pin-approve <gw> <tool> | pin-remove | registry|registry-add|registry-decide|registry-remove

Adds the Atlas MCP server (npx -y @atlasauth/mcp) to the client's config so the
agent can search and read the Atlas docs. Servers already in the file are kept.

  --cursor        .cursor/mcp.json in the project (~/.cursor/mcp.json with --global)
  --claude-code   .mcp.json in the project
  --codex         ~/.codex/config.toml (or $CODEX_HOME/config.toml)
  --vscode        .vscode/mcp.json in the project
  --dir <path>    The project directory (default: the current directory)

No key is written. To also manage your instance from the agent, add
ATLAS_SECRET_KEY to the server's env yourself.`,
  status: `atlas status — is it Atlas, a service you depend on, or you?

Usage:
  atlas status [--json]

Shows Atlas's components (with their regions), the open Atlas incidents that
concern this instance (its status subscription's regions, components and
minimum impact), the subscription itself, and the state of every upstream
status page the instance declared (POST /v1/instance/status_dependencies).

Exit code 1 when Atlas reports a major outage or an open major / critical
incident concerns the instance, or an enabled upstream status page reports a
partial or major outage; 0 otherwise.`,
  referrals: `atlas referrals — referral attribution

Usage:
  atlas referrals connect --provider referalli --program <prg_…> --base-url <url>
        [--referalli-key-file <path|-> | --referalli-key <rk_…>]
        [--auto-enroll] [--destination <url>] [--tracking-token <token>] [--enable]
        [--no-sync] [--allow-mode-mismatch]
  atlas referrals connect --oauth [--preset <id>] [--enable]   (default preset: referalli)
  atlas referrals connect --provider webhook --endpoint <https-url>
        [--secret-file <path|->] [--program <id>] [--auto-enroll] [--enable]
  atlas referrals backfill --since <YYYY-MM-DD> [--map <file.csv>]
        [--metadata-path public_metadata.referral_code]
        [--own-map <file.csv>] [--own-metadata-path public_metadata.my_code] [--wait]
  atlas referrals resync <user_id> [--dry-run]      re-report one user and apply the answer (code, link)
  atlas referrals status
  atlas referrals conformance [--protocol webhook|connection] [--base-url <url>] [--connection-id <id>] --secret-file <path|->
        [--only <case ids or areas>] [--simulate]

connect --provider referalli --oauth is one-click: it prints a Referalli link, you choose the
organization and program there, and Referalli hands Atlas the connection secret directly (nothing to
copy). It needs no key, --program or --base-url, and waits until the connection appears. Where the
deployment does not offer it yet, use a key as below.

conformance runs the referral protocol conformance suite (@atlasauth/referral-conformance) against
any platform (--protocol webhook: the generic Atlas referral protocol; connection: the Referalli dialect): signed calls with the answers a conforming server must give (401 for a bad signature,
an empty export for an unknown customer, nulls accepted, …). It defaults to the connected Referalli;
the secret is read from --secret-file because Atlas never shows it. --simulate also sends Atlas's own
simulated sign-up. It exits 1 on any failed case.

connect --provider referalli creates the Atlas connection on Referalli with
your merchant key (bring your own key: used for this one call, never stored or
printed), saves the connection id and secret on the instance, and runs a ping.
It requires v2 signatures on the connection from the start and registers a
Referalli webhook that sends referral changes (voided, approved, reassigned…)
back to Atlas; --no-sync skips the webhook. A test key (rk_test_) belongs with a
development instance and a live key with production: a mismatch is refused
unless --allow-mode-mismatch. --auto-enroll and --destination are passed to
Referalli. --enable turns referrals on when the ping passes. Prefer --referalli-key-file (or
REFERALLI_API_KEY) to --referalli-key: a key on the command line can end up in
your shell history. The old names (--provider referally, --referally-key-file,
--referally-key, REFERALLY_*) still work and print a notice.

connect --provider webhook points the instance at a platform that speaks the
Atlas referral protocol. Without --secret-file, a signing secret is generated
and written to a 0600 file for you to configure on the platform.

backfill reports users who signed up since the date, with their real sign-up
time. --map reads customerRef,code lines; --metadata-path reads a stored code.
Those are the codes users ARRIVED with. To keep each user's OWN code (the one
they share), use --own-map (customerRef,code lines) or --own-metadata-path:
Atlas stores it and sends it to the platform before the sign-up, so the
platform does not hand out a new one.

status prints the connection, its health and the referral preflight findings;
it exits 1 when one is an error.

All subcommands take --instance <id> or --product <name> like preflight.`,

  login: `atlas login — authenticate and store a profile credential

Usage: atlas login [--profile <name>] [--url <api-url>] [--secret-key <sk_...>]

Prompts for an API URL and a secret key, validates the key with one Backend
call, then stores it (0600) under the profile. --url / --secret-key skip the
prompts for non-interactive setup.

Operator sign-in (no key on disk):
  atlas login --device [--resource <ins_…|app_…>] [--scope "<scopes>"]
Opens Atlas's sign-in (passkey, multi-factor) with a device code. Only
short-lived tokens are stored: the operator token, and with --resource a
one-hour token bound to that instance or app (scope "read" by default).
Creating apps or instances and minting keys need a multi-factor sign-in
within the last 5 minutes.

An operator token for another product that trusts Atlas operators:
  atlas login --device --audience <id> [--json]
<id> is one of the audiences GET /v1/operator lists. The token carries
aud=<id>, auth_time, amr/acr and your verified email; it is printed (for
that product's own token exchange), never stored, and Atlas refuses it.`,

  token: `atlas token — a one-hour token bound to one instance or app

Usage: atlas token --resource <ins_…|app_…|acct_…> [--scope "<scopes>"] [--json]

Swaps your operator sign-in (atlas login --device) for an Atlas token (RFC 8693
token exchange). "read" = every read scope.`,

  keys: `atlas keys — the instance's secret keys

Usage:
  atlas keys whoami                         What the current key is and can do
  atlas keys list                           Every credential on the instance
  atlas keys create --scopes "<scopes>" [--name n] [--owner o] [--expires-at <ISO>] [--allowed-ips <cidr,…>] [--out <file>]
  atlas keys rotate <id> [--overlap <seconds>] [--out <file>]
  atlas keys data status|enable|rotate|rewrap|check|shred   Customer-managed data key (shred needs the instance id typed or --confirm)
  atlas keys op list|rotate                           OpenID provider signing keys
  atlas keys revoke <id>
  atlas keys revoke-leaked [<secret>]       Revoke a leaked Atlas credential (no login needed)

New secrets come back sealed to a key pair made on this machine and are
written to a 0600 file (default .atlas/secret-key-<id>.env); --print-secret
prints them instead.`,

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
  atlas webhooks upsert --url <https-url> [--events a,b]       one endpoint per URL; idempotent
  atlas webhooks update <id> [--url <u>] [--events a,b] [--active | --inactive]
  atlas webhooks test <id> [--timeout 10s] [--no-wait] [--json]
  atlas webhooks deliveries <id> [--status failed] [--event-type user.created]
        [--since <iso|2h|7d>] [--until <iso>] [--limit <n>] [--starting-after <id>] [--json]
  atlas webhooks redeliver <id> --delivery <delivery-id>
  atlas webhooks redeliver <id> --since <iso|2h|7d> [--until <iso>] [--status failed]
  atlas webhooks replay <id> [--since failing_since]           re-send what a disabled endpoint missed
  atlas webhooks rotate <id> [--now | --overlap <seconds>]
  atlas webhooks reveal <id>

create, upsert, rotate and reveal write the signing secret to a 0600 file and
print only its path (--print-secret prints it instead; --force replaces a file).
test sends a signed webhook.test event and waits for your endpoint's answer;
the exit code is 1 when it did not answer 2xx. rotate --overlap keeps the old
secret signing alongside the new one for that many seconds.`,
  listen: `atlas listen — forward live events to your local server

Usage:
  atlas listen --forward-to <url> [--events user.*,session.created] [--count <n>] [--timeout <dur>] [--json]
  atlas listen --no-forward [--events ...]            only print events

Opens a signed event stream from your instance and POSTs each event to
--forward-to with the same atlas-id, atlas-timestamp and atlas-signature headers a
real delivery carries, then prints the status your server returned. No tunnel
and no second endpoint. The signing secret belongs to this session only and is
written to a 0600 file (webhook-listen.env): point your verifier at it. --events
takes names or patterns (user.*, *.created). The session lasts up to an hour;
Ctrl-C stops it. --count n exits after n events (exit 1 if any forward failed).`,
  dev: `atlas dev — a local, in-memory Atlas

Usage:
  atlas dev [--port 4400] [--seed seed.json] [--app http://localhost:3000]
  atlas dev proxy --app <url> --api <fapi url> [--port 4401]

The emulator serves the Frontend API, a minimal Backend API, OIDC discovery and
a mail/SMS catcher at /__emulator/mail. Every code is 424242. With --app it also
forwards everything it does not own to your app, so both share one origin.
'dev proxy' does the same against a real instance. No account, no network.`,
  'move-origin': `atlas move-origin — move an app to a new domain

Usage: atlas move-origin --from <origin> --to <origin> [--dry-run] [--yes] [--json]

Rewrites every field that points at the old origin: allowed origins, branding
links, OAuth client redirect and logout URIs, webhook URLs, the redirect-URL
allowlist and your Sign in with Atlas apps. Shows the before and after of every
field first and asks before writing (--yes skips the question). After a real
move it sends a signed test delivery to each webhook endpoint that moved.
--dry-run prints the diff and writes nothing; running it twice changes nothing.`,
  fga: `atlas fga — author and test authorization models

Usage:
  atlas fga test <suite.fga.yaml> [--store <id>] [--json]
  atlas fga validate <model.fga|model.json>
  atlas fga transform <model.fga|model.json> [--to dsl|json]
  atlas fga export|materializations <store>
  atlas fga import <store> --file tuples.json [--data '{"dry_run":true}']
  atlas fga watch <store> [--since <revision>]
  atlas fga materialize <store> --data '{"object_type":…,"relation":…,"user_type":…}' --yes
  atlas fga rebuild|unmaterialize <store> <id> --yes

A test file follows the OpenFGA format: model (DSL text) or model_file, tuples or tuple_file,
and tests, each with check, list_objects and list_users assertions. The suite runs in memory on
the Atlas engine; no stored tuples are read or written. Exit code 1 when any test fails, so it
gates CI. Prints which model relations the assertions cover.`,
  csp: `atlas csp — the Content Security Policy sources Atlas needs

Usage: atlas csp [--framework next|express|nginx] [--shape redirect|panel|button]
                 [--instance <id> | --product <name> [--instance-env <env>]] [--origin <url>]
                 [--manifest <url|file>]... [--no-atlas] [--json]

Reads your instance's embed manifest (including a custom Frontend API host) and
prints the script-src, connect-src, img-src and frame-src sources for your
setup, as a next.config.ts headers() block, a helmet() config or an nginx
add_header line. Read-only. --shape redirect (hosted sign-in) needs none.
With --origin, warns when that origin is not one of the instance's allowed origins.

Any provider that publishes the open embed-manifest format ({surfaces:{name:{csp:{directive:[sources]}}}},
usually at /.well-known/atlas-embed.json) can be merged in with --manifest <url|file>
(repeatable): a consent platform, chat widget, captcha or analytics vendor. --no-atlas
skips the Atlas instance and uses only the manifests you list.`,

  'partner-platforms': `atlas partner-platforms — this instance as a partner platform of another product

Usage:
  atlas partner-platforms list [--json]
  atlas partner-platforms get <partner>
  atlas partner-platforms set <partner> [--platform-id <id>] [--jwks-url <url>] [--signature-header <name>]
                              [--allowed-source <site id>]... [--disable] [--json]
  atlas partner-platforms registration <partner> [--json]
  atlas partner-platforms token <partner> --token-file <path|-> [--rotate] [--base-url <partner api>]
  atlas partner-platforms deliveries <partner> [--limit <n>] [--json]
  atlas partner-platforms remove <partner> [--json]

<partner> is a preset (cookiemunch) or your own id (then --platform-id, --jwks-url
and --signature-header are required). "registration" prints what to send the
partner; the partner registers the receiver and hands back a partner token once.
"token" stores it encrypted (from a file, stdin with -, or ATLAS_PARTNER_TOKEN);
it is never printed or shown again.`,

  admin: `atlas admin — Atlas staff: Sign in with Atlas accounts for other platforms' integration teams

Usage:
  atlas admin id-accounts list [--team <team>] [--kind provisioned|developer] [--limit <n>] [--json]
  atlas admin id-accounts provision --email <address> --team <team> (--app <id[,id…]> | --any-app)
                              [--days <n> | --expires-at <ISO date|epoch ms>] [--two-factor-exempt]
                              [--password-file <path|->] [--unverified] [--product <name>] [--print-secret] [--json]
  atlas admin id-accounts extend <account id> [--days <n> | --expires-at <ISO date|epoch ms>] [--json]
  atlas admin id-accounts rotate <account id> [--password-file <path|->] [--print-secret] [--json]
  atlas admin id-accounts revoke <account id> [--json]
  atlas admin developer-accounts provision --email <address> --team <team>
                              [--account-name <name>] [--application-name <name>]
                              [--days <n> | --expires-at <ISO date|epoch ms>] [--password-file <path|->] [--json]
  atlas admin developer-accounts revoke <account id> [--json]

Common: [--profile <name>] [--staff-account <acct_…>] [--no-step-up]

Only owners and admins of Atlas's own account can use these. The credential is your
operator sign-in ('atlas login --device'), exchanged for a one-hour token on Atlas's
account (--staff-account, or ATLAS_STAFF_ACCOUNT_ID; remembered on the profile) with
the platform:atlas_id_apps:provision scope. Every call needs a sign-in verified with a
second factor; writes need one from the last 5 minutes. When Atlas asks for that, the
CLI starts the operator sign-in again and retries once (--no-step-up: just fail).

Accounts expire (30 days by default, at most a year; never "never"). An "id-account"
signs in only to the named apps (or any customer app with --any-app), never to the
Atlas dashboard, the CLI or account settings. A developer account is a dashboard
account owning a test application. Passwords come back sealed to a key made for the
run and are written to a 0600 file (staff-account-<id>.env under ~/.config/<product>/),
never printed unless you pass --print-secret.`,

  'id-accounts': `atlas id-accounts — test and review accounts for a Sign in with Atlas app

Usage:
  atlas id-accounts provision --app <app id> --email <address> --label <purpose>
                              [--password-file <path|->] [--two-factor-exempt]
                              [--expires-at <ISO date|epoch ms>] [--unverified]
                              [--product <name>] [--print-secret] [--json]
  atlas id-accounts list --app <app id> [--json]
  atlas id-accounts rotate <account id> --app <app id> [--password-file <path|->]
                              [--product <name>] [--print-secret] [--json]
  atlas id-accounts remove <account id> --app <app id> [--json]

For directory and app-store reviewer logins, end-to-end tests in CI, demos and
partner testing. The account is a real Atlas account that works with THIS app
only (never other apps, the Atlas dashboard or account settings). Needs a
platform key scoped platform:atlas_id_apps:provision, or atlas_id_apps:<app id>:provision
for one app (ATLAS_PLATFORM_KEY, or a psk_ profile from atlas login).

Without --password-file Atlas generates a strong password. Either way the password
is returned once and written to a 0600 file (id-account-<id>.env under
~/.config/<product>/); it is never printed unless you pass --print-secret.
--two-factor-exempt lets the account skip the second factor for this app: anyone who
holds the password can sign in, so use it only for reviewer logins. Without
--expires-at the account never expires. "remove" deletes the account and ends its
sessions and grants.`,

  integrations: `atlas integrations — identity integrations (presets and custom)

Usage:
  atlas integrations list [--json]
  atlas integrations get <id>
  atlas integrations set <id> --audience <aud> [--name <n>] [--events-url <url|none>]
                         [--backchannel-logout-url <url|none>] [--oauth-client-id <client_id|none>]
                         [--disable] [--dry-run] [--json]
  atlas integrations remove <id> [--json]
  atlas integrations deliveries <id> [--trace <id>] [--json]

<id> is a preset (chatly, forumulate, cookiemunch, referalli) or your own id.
--oauth-client-id names the first-party OAuth client the service signs users in
with: while no --backchannel-logout-url is set, its backchannel_logout_uri is the
integration's back-channel receiver.`,

  init: `atlas init — create or complete an app's setup, idempotently

Usage:
  atlas init --product <name> [--domain <domain>] [--auth-host <host>]
             [--instance-env development|production] [--name <app-name>]
             [--strategies password,email_code,...]
             [--email managed|development|none] [--email-from <address>]
             [--email-provider resend|brevo --email-key-file <path|->]
             [--client-redirect <url>]... [--webhook-url <url>]
             [--backchannel <url>]
             [--yes] [--force] [--rotate-secret] [--json]

Needs a platform key (ATLAS_PLATFORM_KEY, or a psk_ profile from atlas login).
Finds the app by name and environment, or creates it, then sets strategies, the
email sender, the custom domain (auth.<domain> unless --auth-host; prints the
CNAME), a first-party OAuth client and a webhook. Re-running only fills what is
missing. --backchannel <url> sets the client's back-channel logout URI (your
route that ends the app session when Atlas ends one; @atlasauth/backend has
ready-made handlers).

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

  doctor: `atlas doctor — integration health (a CI / deploy gate)

Usage: atlas doctor [--instance <id> | --product <name> [--instance-env <env>]]
                    [--only <source,...>] [--no-probe] [--json]

Prints every check: setup findings, webhook receivers (with the failing hop:
dns, tls, http, challenge or auth), back-channel logout, the referral
platform, email, the consent manager and SDK versions. Exits 1 when a check
fails. --no-probe uses recorded deliveries only (no live calls).`,

  env: `atlas env — print deploy variables without secrets

Usage: atlas env [--product <name> [--instance-env <env>]] [--format dotenv|coolify|vercel|k8s] [--json]

Public values (publishable key, Frontend API, issuer, discovery and JWKS URLs,
OAuth client id) are printed as-is. Secrets are printed as references to their
0600 files: *_FILE=<path> (dotenv), KEY=@<path> (coolify), or a vercel env add
command that pipes the value from the file (vercel). k8s prints a ConfigMap plus
kubectl create secret commands that read each file. Without --product it reads
the public values from the instance your key belongs to (no secret references).
Both ATLAS_API_BASE and ATLAS_API_URL are printed.`,

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
  atlas config plan   [--dir <path>] [--format json|yaml] [--prune] [--exit-code] [--json]
  atlas config promote --from <profile> --to <profile> [--dry-run] [--prune] [--yes] [--format json|yaml]

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

plan    A Terraform-style, read-only diff of the directory against the live
        instance: field-by-field before -> after for updates. --exit-code exits 2
        when there is drift (for CI); --json for tooling.

promote Copy one environment's configuration to another (development ->
        staging -> production). Each environment is a profile holding that
        instance's secret key ('atlas login --profile staging'). Uses the same
        plan/apply engine as import; --dry-run prints the plan only, and
        applying to a live key needs --yes. Secrets never travel.

Secrets never live on disk. Inject a credential at import with a \${ENV_VAR}
placeholder in a file (e.g. a provider "client_secret": "\${GOOGLE_SECRET}").`,
  pages: `atlas pages — code-defined hosted-page templates

Usage:
  atlas pages list [--json]
  atlas pages push <file> --page <sign-in|sign-up|user-profile> [--promote] [--json]
  atlas pages preview --page <page> [--json]
  atlas pages promote --page <page> [--json]
  atlas pages pull --page <page> [--draft]
  atlas pages discard --page <page> --status <draft|live> [--json]

A template is a JSON file of components (heading, text, image, link, button_link,
list, divider, spacer, columns) in four regions around the sign-in card: header,
above_form, below_form and footer. There is no raw HTML, CSS or script; Atlas
validates the file and renders it. push saves a draft only; the live page does not
change until promote (or push --promote). preview prints a signed link, valid for an
hour, that shows the draft with a preview banner.`,
  actions: `atlas actions — manage Actions (tenant code run in the auth pipeline)

Usage:
  atlas actions list [--json]
  atlas actions deploy <file> --trigger <trigger> [--name <n>] [--json]
  atlas actions test <file> [--trigger <t>] [--json]
  atlas actions logs <action-id> [--json]

  atlas actions gallery [query] [--trigger <t>] [--json]
  atlas actions show <slug> [--json]
  atlas actions install <slug> [--name <n>] [--secrets-file <dotenv>] [--json]
  atlas actions installs [--json]
  atlas actions update <action-id> [--secrets-file <dotenv>] [--json]
  atlas actions publish <template.json> [--draft] [--json]

deploy uploads the file's code verbatim as a new action (created, not yet bound).
test runs the file OFFLINE through the @atlasauth/actions harness — no network,
no real users — and exits non-zero if the action throws. logs explains where an
action's execution history is recorded (Atlas has no live log-stream endpoint).

The gallery: gallery lists first-party and community templates; install copies
one into the instance as a DISABLED, unbound action (secret values come from a
dotenv file, never argv); installs shows which actions came from the gallery
and whether a newer version exists; update moves one to the latest version.
publish reads a manifest {slug, name, author_name, summary, description,
category, tags, trigger, license, version, code_file, secrets, changelog},
creates the template or adds the version, and submits it for review.`,
};

/** Help for the table-driven resource commands, generated from their route tables. */
function resHelp(name: string, blurb: string, ops: Ops): string {
  const lines = Object.entries(ops).map(([sub, o]) => {
    const args = (o.p.match(/\{\}/g) ?? []).map(() => '<id>').join(' ');
    return `  atlas ${name} ${`${sub} ${args}`.trim().padEnd(26)} ${o.m} ${o.p.replace(/\{\}/g, '…')}${o.f?.includes('y') ? '  (--yes)' : ''}`;
  });
  return `atlas ${name} — ${blurb}

Usage:
${lines.join('\n')}

A request body is JSON from --data '<json>' or --file <path>. Anything that changes or removes
data needs --yes. --json prints raw JSON. Secrets the API returns once are shown once; store them
right away.`;
}
Object.assign(COMMAND_HELP, {
  workflows: resHelp('workflows', 'workflow runs, templates and approvals', WORKFLOWS),
  chat: resHelp('chat', 'chat approval integrations (test a bot, list user links)', CHAT),
  'saml-idp': resHelp('saml-idp', 'SAML identity provider service providers (import-metadata takes --data with url, entity_id, mdq_base_url)', SAML_IDP),
  provisioning: resHelp('provisioning', 'outbound provisioning connectors, preview, logs and the failure inbox', PROVISIONING),
  catalog: resHelp('catalog', 'app catalog requests', CATALOG),
  cloud: resHelp('cloud', 'cloud access portal; login prints the https launch URL for a target', CLOUD),
  'device-sso': resHelp('device-sso', 'native OS SSO device registrations', DEVICE_SSO),
  'connection-actions': resHelp('connection-actions', 'actions on a connected provider account', CONNECTION_ACTIONS),
  triggers: resHelp('triggers', 'connection triggers', TRIGGERS),
  agents: resHelp('agents', 'agent lifecycle, activity and access reviews', AGENTS),
  telemetry: resHelp('telemetry', 'OTLP export of gateway and relay calls', TELEMETRY),
  pdp: resHelp('pdp', 'local decision points', PDP),
  billing: resHelp('billing', 'discount codes and account credit', BILLING),
  audit: resHelp('audit', 'audit log retention (shortening needs confirm_deletion in --data)', AUDIT),
  federation: resHelp('federation', 'OpenID federation', FEDERATION),
  vc: resHelp('vc', 'deferred verifiable credential issuance', VC),
});
