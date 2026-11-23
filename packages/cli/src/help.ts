import { EMAIL_PROVIDER_LIST } from './commands/shared';
import { AGENTS, AUDIT, BILLING, CATALOG, CHAT, CLOUD, PROVISIONING, SAML_IDP, CONNECTION_ACTIONS, CONNECTION_LIMITS, DEVICE_SSO, FEDERATION, PDP, TELEMETRY, TRIGGERS, VC, WORKFLOWS, APP_EVENTS, DIAGNOSTICS, PROVIDER_CHANGES, FLOWS, REFERRAL_REWARDS, POLICIES, REGION, OAUTH_PUBLISHERS, DOMAINS, AGE_ASSURANCE, APPROVAL_DEVICES, PCA, PCA_REGISTRY, PCA_GRANTS, PCA_APPROVERS, PCA_UNDO, SSF, STAGING_COPIES, PLATFORM_APPS, OAUTH_DEVICE, ANALYTICS, MACHINES, WEBHOOK_DLQ, ORG_INVITATIONS, MESSAGE_LINKS, PERMISSIONS, MIGRATION_SESSIONS, REVOCATIONS, USER_SECURITY, SESSIONS_MORE, API_KEYS_MORE, CHANGES_MORE, CONNECTIONS_MORE, GRANTS_MORE, MESSAGES_MORE, ORGS_MORE, AUTHZ, ATLAS_ID_APPS, RATE_LIMITS, RISK_SIGNALS, SUPPRESSIONS, WEB_BOT_AUTH, ABUSE_SIGNALS, APPROVAL_REQUESTS, ENTITLEMENTS, FGA_SYNC, IMPERSONATIONS, INSTANCE, LEGAL_HOLDS, MFA_CAMPAIGNS, MACHINE_TRUST_POLICIES, ORG_TEMPLATES, RISK_BASED_MFA, SCIM_TOKENS, SSO_CONNECTIONS, STEP_UP, MESSAGING_PROVIDERS, RESOURCE_ROLE_ASSIGNMENTS, RESOURCE_SERVERS, type Ops } from './commands/resources';
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
        --audience <id>      A token for another tool from the same sign-in (no browser)
  keys whoami|list|create|rotate|revoke|revoke-leaked|data|op
                             Scoped secret keys; new secrets go sealed into 0600 files
  logout                     Remove a stored profile credential
  whoami                     Show the active profile and instance
  users list|get|create|merge|protect|delete|deleted|deletion-update|risk-signals|risk-signal-add|risk-signals-clear|security-summary|approval-requests|delegation-token|upsert
  orgs list|get|members
  api-keys list|create|revoke
  webhooks list|create|upsert|update|test|deliveries|redeliver|replay|rotate|reveal
  changes tail|consumers     Watch the change feed (users, orgs, memberships, keys, machines); consumers lists its readers
  compliance posture|ropa|sign|board|requests|triage|i18n-check ...   Compliance reports, data rights board, translation checks
  mirror init                Print a starter schema + code to mirror Atlas data into your database
  listen --forward-to <url>  Forward live events to your local server, signed (no tunnel)
  proxy --target <url>       Put sign-in in front of any app: only valid Atlas sessions get through
  dev [proxy]                Local in-memory Atlas (emulator) / one-origin dev proxy
  move-origin --from --to    Move an app to a new domain in one step (--dry-run first)
  preview create|clone|list|delete   Per-PR preview instances and environment clones (platform key)
  config snapshot|snapshots|diff|restore   Config time travel: save, compare and put back configuration
  workflows list|get|runs|run|dry-run|status|cancel|retry|resume|templates|approvals|approve|deny
  app-events types|publish|list|get ...   Application events (publish to one organization, or "*" to all)
  logs tail                  Live log: refused requests, audit entries, events
  diagnostics traces|trace|login-readiness|inspect   Why a request was refused, can an origin sign in
  chat list|test|links|interactions   Chat approval integrations
  cloud targets|setup|login <id>      Cloud access portal (AWS, Google Cloud, Azure)
  device-sso list|show|revoke|delete  Native OS single sign-on registrations
  connection-actions catalog|list|run|define|remove
  triggers list|get|create|set|delete Connection triggers
  connection-limits get|set|relay-get|relay-set  Connection rate limits + usage, relay size limits
  agents list|lifecycle|renew|activity|reviews|review-decide ...
  telemetry show|set|test             OTLP export of gateway and relay calls
  pdp list|remove                     Local decision points
  billing coupons|credits ...         Discount codes and account credit
  audit retention|set-retention       Audit log retention
  audit verify                        Verify the tamper-evident audit chain on this machine
  audit chain|chain-enable|chain-checkpoint|chain-links
                                      The audit chain: status, turn on, sign a checkpoint, list links
  federation show|resolve             OpenID federation
  vc deferred|approve|deny            Deferred credential issuance
  provider-changes list|get|acknowledge|resolve   Provider scope or terms changes awaiting a decision
  flows messages|message-cancel|readout   Journey message queue and experiment readouts
  referral-rewards list|get|void|run  Referral reward ledger
  policies audience|set-audience|translations|translation-set|translation-delete
                                      Who a policy is asked of, and its per-language text
  region show|set|pin|failover        Region pin, failover region, Frontend API isolation
  oauth-publishers list|verify|attach|detach   Verified publishers of your OAuth apps
  domains list|get|verify|rotate-verification  Custom domains; rotate-verification issues a new path-mount verify URL
  age-assurance list|record|revoke <user-id>   A user's age checks
  approval-devices list|trust|remove <user-id>  A user's trusted approval devices
  pca principals|bond-accounts|constitution|beacon|guardian-rotate|intent-schema|workflow-receipt ...   Proof-carrying authority admin
  pca-registry actions|drafts|versions|diff|pin|sources|reviewers|templates|publish ...   The action registry
  pca-grants list|get|needs|amend|authority|step-up|revoke   Grants of authority
  pca-approvers list|get|enrol|update|settings|approve|deny   Approvers and the needs they decide
  pca-undo record|record-add|record-update|vetoes   Undo records and vetoes
  ssf show|metadata|create|replace|update|remove|add-subject|remove-subject|verify|poll   Shared signals stream
  revocations list|stream    Everything that ended a credential, as a long poll or a live feed
  staging-copies list|get|create|refresh|delete   Staging copies of the instance
  platform-apps clone-refresh|renew-provisioning-key   Refresh a clone; extend a web app's provisioning key
  oauth-device list|accept|reject|switch-account   Pending device authorizations and consent account switch
  analytics captcha|sms      Captcha and SMS reports
  machines revoked           Revoked machines
  webhook-dlq list           Dead-lettered deliveries across all endpoints
  org-invitations list       Organization invitations across the instance
  message-links create       Signed links for messages
  permissions rename <id>    Rename a permission everywhere it is used
  migration-sessions create <source>   Start a migration session for a vendor
  csp --framework next|express|nginx
                             Print the Content Security Policy sources Atlas needs
  types generate [--out atlas-types.d.ts] [--check] [--from-config <atlas.yaml>]
                             Generate TypeScript types for your roles, permissions, plans, metadata and events
  fga test|validate|transform <file>
  fga export|import|watch|materialize <store>
                             Run .fga.yaml test suites, validate and convert authorization models
  integrations list|health|forwarding|get|set|remove|deliveries   Identity integrations (chat, docs, consent, referrals, custom)
  hooks before-first-session show|set|remove|test   The hook that links accounts before a first session
  issuers                    The token issuers a verifier accepts (active, planned, previous)
  partner-platforms list|get|set|registration|token|deliveries|remove
                             This instance as a partner platform (signed consent deliveries in)
  id-accounts provision|list|rotate|remove
                             Test and review accounts for a Sign in with Atlas app (passwords go to 0600 files)
  admin id-accounts list|provision|extend|rotate|revoke
  admin developer-accounts provision|revoke
                             Atlas staff: accounts for other platforms' integration teams
                             (operator sign-in with a recent second factor; passwords to 0600 files)
  sessions revoke|binding|unbind|set-active-organization
  grants usage <machine|agent> <grant-id>
  connections templates | rehome <from-client> <to-client> [<connection-id>...] [--dry-run|--yes]
                             Marketplace connection templates; move connections between owner OAuth clients
  messages send --to <address[,address]> (--template <name> | --subject <text> --html-file <f> / --text-file <f>)
                             Live usage counters and open leases of a machine or agent grant
  oauth-clients consents|revoke-consents <client-id>
                             Who authorized an app (active or revoked); revoke them and their tokens in bulk
  config export|import|plan|promote|schema|snapshot|snapshots|diff|restore
                             Config-as-code: round-trip the instance's config; plan = drift diff;
                             promote = copy one environment's config to another
  plan [<file|dir>]          Drift diff of a config file or directory; --check exits 2 on drift
  apply [<file|dir>]         Plan, confirm (--yes to skip), then apply; --check = plan only, exit 2 on drift
  suite plan|apply <file>    Run several config-as-code tools in dependency order
  actions list|deploy|test|logs|gallery|show|install|installs|update|publish
  pages list|push|preview|promote|pull|discard
                             Code-defined hosted-page templates: draft, signed preview link, promote
  init                       Create or complete an app's setup (idempotent); secrets to 0600 files
  setup-guide                The setup calls in order, with the read-back for each (--json for agents)
  preflight | health         Check an instance's setup; non-zero exit on errors (for CI)
  doctor                     Integration health: webhooks, logout, referrals, email, consent; 'doctor rs <url>' probes your API (exit 1 on a failure)
  golive --origin <url>      Take an instance live for an app origin, step by step; stops at the first failure
  env                        Print deploy variables: public values + secret file paths
  client rotate              Rotate an OAuth client secret straight into its file
  referrals connect|backfill|resync|status
                             Connect a referral platform, backfill, check the connection
  status                     Atlas status, incidents that concern the instance and its
                             upstream status pages; non-zero exit on an outage
  import --from <vendor> <file>
                             Move users from Auth0, Clerk, Supabase, Firebase, Cognito,
                             Auth.js, WorkOS or Better Auth (resumable; --dry-run first)
  migrate plan --from authjs (--set dump=<dir> | --file <f>)
                             Count an Auth.js database and recommend the route
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
  atlas migrate plan --from authjs (--set dump=<dir> | --file <export.json> | --db <url>) [--json]
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

migrate plan reads your Auth.js tables (a dump folder, or one JSON file with
users / accounts / sessions / authenticators arrays), prints what is in them and
recommends a route: import with identities, lazy link, or session bridge, each
with its exact commands. It never connects to a database: --db only prints the
psql commands that make the dump (this CLI has no database driver).

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
  import: `atlas import — move users from another auth provider, or from a JSONL file

Usage:
  atlas import <users.jsonl> [--dry-run] [--since <ts>] [--on-conflict skip|update]
                             [--password-policy active|until_email_verified] [--json]
  atlas import --from <vendor> <export-file> [--dry-run]
  atlas import --from better-auth --bundle <file> [--dry-run] [--yes]
  atlas import --from better-auth --import <id> [--confirm-conflicts]
  atlas import --from better-auth             (prints the import key and export command)

With no --from the file has one user per line: external_id and email (required),
email_verified, password_digest + algorithm, password_salt, password_hash_params,
oauth_identities [{provider, provider_user_id}], first_name, last_name, created_at,
updated_at. Any other key is an error, with the line and the nearest real key, and
nothing is sent. Each row is
matched by external_id, so running it again changes nothing. --since keeps rows
updated (or else created) at or after <ts>. --on-conflict skip (the default here)
leaves existing users alone; update applies rows that changed. It reports created,
updated, skipped and unverified-with-password counts, and never an email address.
A hash that cannot be checked is listed by external_id: warning ambiguous_scrypt_salt
for a hex-looking scrypt salt with no salt_encoding, and unsupported_password_hash for
a row the API refused.

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
  --since <ts>           Only users created at or after <ts>
  --on-conflict <mode>   update (the default for --from) or skip a user who already exists
  --password-policy <p>  active (default), or until_email_verified: an imported hash signs in
                         only once the address is verified
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
        [--auto-enroll] [--destination <url>] [--tracking-token <token>] [--link-template <url>]
        [--enable] [--no-sync] [--no-identity-backfill] [--allow-mode-mismatch] [--dry-run]
  atlas referrals connect --oauth [--preset <id>] [--enable]   (default preset: referalli)
  atlas referrals connect --provider webhook --endpoint <https-url>
        [--secret-file <path|->] [--program <id>] [--auto-enroll] [--enable]
  atlas referrals backfill --since <YYYY-MM-DD> [--map <file.csv>]
        [--metadata-path public_metadata.referral_code]
        [--own-map <file.csv>] [--own-metadata-path public_metadata.my_code] [--wait]
  atlas referrals resync <user_id> [--dry-run]      re-report one user and apply the answer (code, link)
  atlas referrals status [--json] [--referalli-key-file <path|->]
  atlas referrals conformance [--protocol webhook|connection] [--base-url <url>] [--connection-id <id>] --secret-file <path|->
        [--only <case ids or areas>] [--simulate]

connect --dry-run (any provider) makes no change anywhere: it lists the calls it would make to the
platform and validates the Atlas settings write with ?dry_run=true. No secret is saved or printed and
no connection test is run.

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
back to Atlas, limited to --program (programIds), so other programs in a shared
organization never reach the instance; --no-sync skips the webhook. The instance's app origins
(allowed origins and Frontend API host) are sent with the connection, and Atlas keeps them current
when they change. With --enable, Atlas also reads the referral code of every existing user from
Referalli (10 per second at most); --no-identity-backfill skips that. It is safe to
run again: the instance's existing connection and webhook are reused and updated
in place (an unscoped webhook is re-scoped), never duplicated. The tracking token
and link template are read from Referalli (GET /v1/org, the link domain); a link
template you set before is kept. Whatever it cannot read is printed as the exact
PATCH /v1/instance/referrals body left to send. A test key (rk_test_) belongs with a
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
it exits 1 when one is an error. --json prints a machine-readable status object
(connection id, program, webhook endpoint id and scope, link template and tracking
token set, last sync) next to the raw settings. The webhook's program scope is read
from Referalli when a merchant key is given (--referalli-key-file or
REFERALLI_API_KEY); without one it is "unknown".

All subcommands take --instance <id> or --product <name> like preflight.`,

  login: `atlas login — authenticate and store a profile credential

Usage: atlas login [--profile <name>] [--url <api-url>] [--secret-key <sk_...>]

Prompts for an API URL and a secret key, validates the key with one Backend
call, then stores it (0600) under the profile. --url / --secret-key skip the
prompts for non-interactive setup.

Operator sign-in (no key on disk):
  atlas login --device [--resource <ins_…|app_…>] [--scope "<scopes>"] [--no-browser]
Opens Atlas's sign-in (passkey, multi-factor) with a device code, in your
browser when this is a terminal outside CI (--no-browser only prints the link). Only
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
       atlas token --audience <id> [--json]

Swaps your operator sign-in (atlas login --device) for an Atlas token (RFC 8693
token exchange). "read" = every read scope.

--audience hands the same sign-in to another tool, no browser: <id> is one of the
audiences GET /v1/operator lists, or the client_id of a Sign in with Atlas app whose
owner turned on cli_handoff (you must have signed in to that app once). The token is for that tool, lasts at most an hour
(never past your sign-in) and Atlas refuses it. --json prints
{access_token, expires_in, audience, issuer}.`,

  keys: `atlas keys — the instance's secret keys

Usage:
  atlas keys whoami                         What the current key is and can do
  atlas keys list                           Every credential on the instance
  atlas keys create (--scopes "<scopes>" | --preset app-runtime|provisioning|integrations) [--name n] [--env-var <NAME>] [--owner o] [--expires-at <ISO>] [--allowed-ips <cidr,…>] [--out <file>]
  atlas keys rotate <id> [--preset app-runtime|provisioning|integrations] [--overlap <dur, e.g. 72h or seconds>] [--out <file>] [--env-var <NAME>]   --preset narrows an all-scope key; the old key keeps working for the overlap
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

Usage: atlas whoami [--profile <name>] [--remote] [--json]

--remote asks the server what this key is and can do (GET /v1/whoami).`,

  users: `atlas users — manage users

Usage:
  atlas users list [--limit <n>] [--starting-after <cursor>] [--json]
  atlas users get <user-id> [--json]
  atlas users create --email <address> [--first-name <n>] [--last-name <n>] [--password <p>] [--json]
  atlas users clear-password <user-id> [--json]
  atlas users protect <user-id> [--json]
  atlas users delete <user-id> [--json]
  atlas users deleted | deletion-update <id> | risk-signals <id> | risk-signal-add <id> | risk-signals-clear <id>
  atlas users security-summary <id> | approval-requests <id> | delegation-token <id> | upsert <external-id>
    (route per subcommand; a body is JSON from --data or --file; anything that changes data needs --yes)

protect makes a proof of an unverified user's address reach that user, instead of
making a second account. A password goes on hold; a row with no credential is marked
as yours. It refuses a user with a verified address, or one with anything else that
signs in, and names what it found.`,

  'setup-guide': `atlas setup-guide — the setup calls in order, with the read-back for each

Usage: atlas setup-guide [--json]

Prints each step, the exact call or command, and what to read to prove it worked.
Full guide: https://atlasauth.net/docs/agent-setup`,

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

  compliance: `atlas compliance — compliance reports, the data rights board and translation checks

Usage:
  atlas compliance posture | ropa                      the live posture / record of processing
  atlas compliance sign --kind posture|ropa            sign and keep a report (reports lists them, report <id> fetches one)
  atlas compliance inactive-preview                    who the inactive-user policy would act on now
  atlas compliance board                               open / overdue / due soon / unassigned
  atlas compliance requests [--status s] [--assignee a] [--priority p] [--label l] [--overdue true] [--unassigned true]
  atlas compliance triage <request-id> [--assignee a] [--priority low|normal|high|urgent]
  atlas compliance note <request-id> --body <text>
  atlas compliance downstream <request-id>             erasure progress per tracked system
  atlas compliance downstream-done <request-id> <connector-id> [--status done|not_applicable] [--note n]
  atlas compliance erasure-catalog | cookie-summary | erasure-probe <connector-id>
  atlas compliance downstream-run <request-id> <connector-id>   run one tracked system's erasure now (--yes)
  atlas compliance cookie-consents | cookie-subject <subject> | cookie-subject-erase <subject> | cookie-user-erase <user-id>
  atlas compliance i18n-reviews <localization-id>      the review history of one translation
  atlas compliance i18n-summary | i18n-review <id> --action submit|approve|request_changes|reopen [--note n]
  atlas compliance i18n-check --file translations.json   exit 1 when a translation fails (CI)

translations.json: { "items": [{ "resource_type", "resource_name", "locale", "content" }], "require_approved": true }.
The check never writes.`,

  changes: `atlas changes — watch the change feed

Usage:
  atlas changes tail [--types user,organization] [--after <seq>] [--once] [--json]

Prints one line per change: seq, time, op, resource type, resource id. Without
--after it starts at the current head (only new changes); --after 0 replays
everything still retained. --once prints what is there and exits.`,

  mirror: `atlas mirror — keep a copy of Atlas data in your database

Usage:
  atlas mirror init --adapter drizzle|prisma [--types user,organization,membership]

Prints a starter table/model definition and the createMirror wiring for your ORM.
Nothing is written to disk.`,

  webhooks: `atlas webhooks — manage webhook endpoints

Usage:
  atlas webhooks list [--json]
  atlas webhooks create --url <https-url> [--events a,b] [--product <name>] [--print-secret] [--json]
  atlas webhooks upsert --url <https-url> [--events a,b]       one endpoint per URL; idempotent
  atlas webhooks update <id> [--url <u>] [--events a,b] [--active | --inactive] [--max-rps <n>|none] [--filters '<json>'|none]
  atlas webhooks test <id> [--timeout 10s] [--no-wait] [--json]
  atlas webhooks deliveries <id> [--status failed] [--event-type user.created]
        [--since <iso|2h|7d>] [--until <iso>] [--limit <n>] [--starting-after <id>] [--json]
  atlas webhooks redeliver <id> --delivery <delivery-id>
  atlas webhooks redeliver <id> --since <iso|2h|7d> [--until <iso>] [--status failed]
  atlas webhooks replay <id> [--since failing_since]           re-send what a disabled endpoint missed
  atlas webhooks rotate <id> [--now | --overlap <seconds>]
  atlas webhooks reveal <id>
  atlas webhooks dlq <id> [--limit <n>]                          deliveries that used every attempt, with payloads
  atlas webhooks dlq-ack <id> --delivery <id>[,<id>...]          handled: take them out of the queue
  atlas webhooks dlq-requeue <id> --delivery <id>[,<id>...]      send them again

create, upsert, rotate and reveal write the signing secret to a 0600 file and
print only its path (--print-secret prints it instead; --force replaces a file).
test sends a signed webhook.test event and waits for your endpoint's answer;
the exit code is 1 when it did not answer 2xx. rotate --overlap keeps the old
secret signing alongside the new one for that many seconds.`,
  listen: `atlas listen — forward live events to your local server

Usage:
  atlas listen --forward-to <url> [--events user.*,session.created] [--count <n>] [--timeout <dur>] [--json]
  atlas listen --no-forward [--events ...]            only print events
  atlas listen --revocations [--kinds session,api_key,machine,...] [--count <n>] [--timeout <dur>] [--json]

Opens a signed event stream from your instance and POSTs each event to
--forward-to with the same atlas-id, atlas-timestamp and atlas-signature headers a
real delivery carries, then prints the status your server returned. No tunnel
and no second endpoint. The signing secret belongs to this session only and is
written to a 0600 file (webhook-listen.env): point your verifier at it. --events
takes names or patterns (user.*, *.created). The session lasts up to an hour;
Ctrl-C stops it. --count n exits after n events (exit 1 if any forward failed).

--revocations watches the revocation stream instead: everything that ends a
session, token, API key, machine, machine grant or person's access, in commit
order, with reason and actor (needs events:read; nothing is forwarded). --kinds
filters (session, user_sessions, token_family, grant, api_key, machine,
machine_grant, user). It starts from now and resumes by position on reconnect.`,
  proxy: `atlas proxy — an authenticating reverse proxy for any app

Usage:
  atlas proxy --target <url> [--port 4500] [--public /health,/static] [--allow-api-keys]
              [--cache <seconds>] [--strip-credentials] [--bind <address>]
              [--revocation-interval <seconds>]

Listens locally and forwards to --target. A request must carry a valid Atlas session
(Authorization: Bearer <session token>, or the __session cookie), otherwise it is
answered 401 and never reaches your app. A valid one is forwarded with x-atlas-user-id,
x-atlas-session-id, x-atlas-org-id, x-atlas-org-role and x-atlas-auth-method headers.
Any x-atlas-* header the client sent is removed first, so your app can trust them.
--public lets listed path prefixes through without a credential. --allow-api-keys also
accepts ak_ API keys (x-atlas-key-id, x-atlas-subject-*, x-atlas-scopes). Answers are
cached --cache seconds (default 10, 0 = off): a session revoked just now still works for
that long, except that the session revocation feed is polled every --revocation-interval
seconds (default 5, 0 = off) and a session it lists is dropped at once. If Atlas cannot be
reached the request is refused (503). The secret key needs
sessions:read (and api_keys:read with --allow-api-keys). WebSocket upgrades are refused.`,
  dev: `atlas dev — a local, in-memory Atlas

Usage:
  atlas dev [--port 4400] [--seed seed.json] [--app http://localhost:3000] [--openapi <path or URL>]
  atlas dev proxy --app <url> --api <fapi url> [--port 4401] [--base-path /atlas]
  atlas dev native [--provider discord] [--json]

The emulator serves the Frontend API, a minimal Backend API, OIDC discovery and
a mail/SMS catcher at /__emulator/mail. Every code is 424242. With --openapi (the
API document: a file or https://atlasauth.net/v1/openapi.json?surface=BAPI) it also serves the full
Backend API from memory: roles, API keys, machines and grants, signed webhooks, the change feed.
With --app it also
forwards everything it does not own to your app, so both share one origin.
'dev proxy' does the same against a real instance. No account, no network.
'dev native' reads your real instance: its publishable key and Frontend API URL, the
registered native apps with their callback URLs, what is still missing (preflight
findings for native apps), and the exact useSignIn().signInWithOAuth call to paste.`,
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

  types: `atlas types generate — TypeScript types for your instance

Usage: atlas types generate [--out <file>] [--lang ts] [--check] [--from-config <atlas.yaml|dir>] [--json]

Writes atlas-types.d.ts (or --out) with the permission, role, plan, feature, scope, event, FGA and
metadata types your instance really has, and registers them with the SDKs:

  declare module '@atlasauth/types' { interface Register { permission: AtlasPermission; ... } }

After that, has({ permission }), <Protect permission>, the backend's has() and verified session
claims reject a key your instance does not define. With no generated file everything stays a plain
string, so nothing changes for existing code. Add the file to your tsconfig "include".

Reads the live instance (secret key from your login or ATLAS_SECRET_KEY): roles, permissions, app
roles, billing plans, scopes, JWT templates, the metadata schema, the webhook event catalog, app and
audit event types, and the types and relations of your fine-grained authorization models. A source
the key cannot read is warned about and left as string.

--from-config reads atlas.yaml (or an atlas config directory) instead, with no network. It knows only
what the file declares: system permissions appear only when a role in the file grants them, and
events, app roles and fine-grained models stay string.

--check writes nothing: exit 1 when the file on disk differs from what would be generated (use it in
CI after a role or plan change). Only TypeScript is supported (--lang ts).`,

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
  atlas integrations health [--json]
  atlas integrations forwarding set <lucida|hermetica|seolyticize|webhook> [--secret-file <path|->] [--host <h>]
                         [--site-key <k>] [--conversion-event <e>] [--include-pii] [--url <https url>] [--active|--inactive]
  atlas integrations forwarding show <destination> [--json]
  atlas integrations forwarding remove <destination>
  atlas integrations deliveries <id> [--trace <id>] [--json]

health lists every connected receiver (webhook endpoints, integrations, the privacy
orchestrator) with its last delivery. forwarding set sends user.created sign-ups to
a platform with YOUR key (read from --secret-file, or - for stdin; never printed) or
to any https receiver (webhook, with --url); show reads it back (never the key); remove stops it.

<id> is a preset (chatly, forumulate, cookiemunch, referalli) or your own id.
--oauth-client-id names the first-party OAuth client the service signs users in
with: while no --backchannel-logout-url is set, its backchannel_logout_uri is the
integration's back-channel receiver.`,

  hooks: `atlas hooks — server hooks

Usage:
  atlas hooks before-first-session show [--json]
  atlas hooks before-first-session set [--url <https url>] [--secret-file <path|->] [--timeout-ms <ms>] [--enable|--disable] [--json]
  atlas hooks before-first-session remove [--json]
  atlas hooks before-first-session test [--json]

before-first-session is called once per user, after their email is verified and
before their first session token, so your answer ({ "external_id": "..." }) is
already in that token. The signing secret is write-only: pass it with --secret-file
(or - for stdin). remove clears the url and secret and turns the hook off; test
sends a signed sample call with a made-up user and stores nothing.`,

  issuers: `atlas issuers — the token issuers a verifier accepts

Usage:
  atlas issuers [--json]

Prints the active issuer, the planned one (a path mount or custom domain whose
claim is not verified yet; register it up front), the previous issuers still
accepted, and the JWKS URL.`,

  init: `atlas init — create or complete an app's setup, idempotently

Usage:
  atlas init --product <name> [--domain <domain>] [--auth-host <host>]
             [--instance-env development|production] [--name <app-name>]
             [--strategies password,email_code,...]
             [--email managed|development|none] [--email-from <address>]
             [--email-provider ${EMAIL_PROVIDER_LIST} --email-key-file <path|->]
             (hermetica is set directly: --email-provider hermetica --email-from <address> --email-key-file <path|->)
             [--client-redirect <url>]... [--webhook-url <url>]
             [--backchannel <url>]
             [--with-dev] [--no-env-files --json]
             [--key-preset app-runtime|all] [--allow-no-email]
             [--yes] [--force] [--rotate-secret] [--json]
  atlas init --next [--mount /atlas] [--dir <app-root>] [--force]
  atlas init nextjs-local-users [--dir <app>]    (a starter that keeps your own user table in step; runs create-atlas-app)

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

Every secret goes to ~/.config/<product>/<env>/ (dir 0700, files 0600) and
is never printed. An existing file is never overwritten without --force.
--rotate-secret mints a new secret key when the app exists but its file is gone.
The app key is the app-runtime preset (ATLAS_SECRET_KEY); a separate provisioning key (ATLAS_PROVISIONING_KEY,
for atlas plan/apply and the CLI) goes in its own file, and the all-scope key that came with the app is revoked.
--key-preset all keeps the all-scope key. A production app with no email transport is refused unless
--allow-no-email.
Public values and file paths are kept in ~/.config/<product>/atlas.json.
Turns on strict request bodies unless the instance has them or opted out.

Each environment gets its own folder (~/.config/<product>/production/atlas.env and
development/atlas.env), so a script reading a folder's *.env files never mixes
keys, and init prints a line saying where the files went. --with-dev also creates
the development sibling. An existing <env>.env stays where it is and keeps its
layout; atlas doctor --scan-dir reports it beside another environment's folder until
you move it to <env>/atlas.env and run atlas init again.
--no-env-files writes no secret file: each secret is handed over once in the
--json output on stdout. Without --json it is refused and names the paths it
would have written.

--next [--mount <path>] writes, with no key and no network: atlas.yaml, the
App Router mount and verify routes (src/app when that is where your app is), and
a .env.example saying which variables are build args (the publishable key only)
and which are runtime. With --product it sets up the instance as well.`,

  preflight: `atlas preflight — check an instance's setup (a CI / deploy gate)

Usage: atlas preflight [--instance <id> | --product <name> [--instance-env <env>]]
                       [--fail-on error|warning|never] [--fix [--yes]] [--ack <code> [--ack-reason <text>]] [--json]
       atlas health ...                    (same command)

Prints every finding (severity, code, message, fix, and the exact call when there
is one). Exits 1 when there is an error, or with --fail-on warning
also on a warning; --fail-on never always exits 0.

health --json prints an array with one object per check: {id, status, detail, remedy},
status being error, warning or info and remedy the call or command that fixes it.
preflight --json prints the full report, with the same array under checks.

--fix lists the findings the server marks safe to fix, asks before each call
(--yes skips the question; needed without a terminal), applies them, runs the
checks again and prints the result.

--ack <code> accepts a known warning or info finding (for example issuer_changed_recently
once every verifier is updated): it stays listed, marked acknowledged, and stops counting.
An error is never acknowledgeable. Remove it with DELETE /v1/instance/preflight/acks/<code>.`,

  doctor: `atlas doctor — integration health (a CI / deploy gate)

Usage: atlas doctor [--instance <id> | --product <name> [--instance-env <env>]]
                    [--only <source,...>] [--no-probe] [--origin <url>] [--ack <code>]
                    [--fail-on error|warning|never] [--json]
       atlas doctor --scan-dir <path> [--scan-image <ref>] [--json]
       atlas doctor rs <url> [--json]

Prints every check: setup findings, webhook receivers (with the failing hop:
dns, tls, http, challenge or auth), back-channel logout, the referral
platform, email, the consent manager and SDK versions. Errors print FAIL and exit 1;
warnings print WARN, are counted separately and exit 0 unless --fail-on warning;
info is a note. Same severities as atlas health. --no-probe uses recorded deliveries only (no live calls).

--origin <url> adds the go-live checks for that app origin to the same report:
setup errors (preflight), login readiness (live), the path-mount verification
state on that host, and whether the consent declaration lists every cookie the
SDKs read (__session, __atlas_uat, __atlas_rt, __client). It also requests the
mount's /.well-known/jwks.json and /v1/client/environment from outside with a
cache-busting query and reports status, content type and age/cache headers; an
HTML or cached answer is flagged.

rs <url> needs no key. It probes one of your protected API routes from outside with invalid
credentials only: an anonymous request, a forged token, a malformed header, a forged DPoP
proof and a token in the query string must all be refused the way RFC 6750 and RFC 9449 say;
the 401 should carry a WWW-Authenticate challenge with resource_metadata; the RFC 9728
protected-resource metadata must be served and name an authorization server whose metadata and
signing keys are reachable. Prints each check with its fix; exits 1 on a failure.

--scan-dir <path> and --scan-image <ref> need no key. They flag secret keys and
webhook or hook secrets in Dockerfile ARG / ENV lines, compose build.args, and an
image's docker history and environment, plus folders whose *.env files, directly
or in a subfolder, hold both a development and a production key. Prints the file and line, never the value.
Exits 1 on a finding. Only the publishable key belongs in a build arg.`,

  golive: `atlas golive — take an instance live for one app origin

Usage: atlas golive --origin <https://app.example.com> [--dry-run] [--yes] [--json]
                    [--connect cookiemunch,forumulate,chatly,referalli] [--keys-file <0600 dotenv>] [--config <file>]
                    [--revoke-unused-platform-keys]
                    [--instance <id> | --product <name> [--instance-env <env>]]

Runs, in order, and stops at the first failure with its fix:
  domains             verify the custom domain for the origin's host if it is not yet
  issuer              the origin's discovery document serves the instance's issuer
  sign_in_with_atlas  turned on when the instance declares it
  webhooks            each inactive endpoint: test delivery, then activate if it succeeded
  hooks               a configured but disabled hook: test call, then enable if it succeeded
  preflight           no error findings
  login_readiness     ready for the origin (live JWKS round-trip)
  integrations        referrals, privacy and identity integrations the instance declares

--connect (any subset) connects those partners before the integrations step, with the keys
from --keys-file (default ~/.config/atlas/partner-keys.env; refused unless only you can read
it): FORUMULATE_API_KEY, COOKIEMUNCH_API_KEY, REFERALLI_API_KEY, and <PARTNER>_AUDIENCE for a
first connect. ATLAS_INTEGRATIONS_KEY (a key created with --preset integrations) in the same file is
used for the connect and integration calls only; every other step uses your main key. With --config <file> it also sends that file's integrations (org_id, spaces,
channel, claims, urls, ...), referrals and privacy_orchestrator settings, so no curl is
needed; <PARTNER>_ORG_ID, <PARTNER>_SPACES (comma list) and <PARTNER>_CHANNEL in the keys
file work too. For cookiemunch with its key, golive also connects Atlas as the identity executor
in Cookie Munch and sets the site's rights identity (needs the site id: COOKIEMUNCH_SITE_ID,
privacy_orchestrator.site_id or the cookiemunch:<site> audience). It then prints, per integration, whether the events receiver is ok, a token has
been minted and which host redeems it.

golive also lists platform-owned secret keys unused for 14 days or more and asks whether to
revoke them. --revoke-unused-platform-keys revokes without asking; with --yes, --json or --dry-run
it only lists.

When verifying the domain would move the issuer, golive prints both issuers and
the previousIssuers value to add to your verifiers, then stops unless --yes.

--dry-run sends every write with ?dry_run=true: the server validates it and
nothing changes. Exits 0 when every step passes, 1 on the first failure.`,

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
  atlas sessions revoke <session-id> [--json]
  atlas sessions binding <session-id>        the key a session is bound to
  atlas sessions unbind <session-id>         let it bind a new key
  atlas sessions set-active-organization <session-id> --data '{"organization_id":"org_..."}' --yes`,

  grants: `atlas grants — inspect grants

Usage:
  atlas grants list [--user-id <id>] [--type consent|managed|all] [--status active|revoked|all] [--limit <n>] [--starting-after <cursor>] [--json]
  atlas grants get <grant-id>
  atlas grants usage <machine|agent> <grant-id> [--json]

list and get read consent and Grant Management grants.

usage shows each counter the grant defines (used, limit, remaining, window, when it resets)
and any lease still holding an amount.`,

  connections: `atlas connections — marketplace templates and OAuth client moves

Usage:
  atlas connections templates [--json]
  atlas connections rehome <from-client> <to-client> [<connection-id>...] (--dry-run | --yes) [--json]

templates lists each marketplace connection (kind, secrets, hosts, signature). rehome moves
connections from one owner OAuth client to another: when both are the same provider app the
tokens simply move; otherwise one real refresh per connection with the target client proves
the move, and a connection that fails stays on the old client unchanged. Exits 1 when any
connection did not move.`,

  messages: `atlas messages — send transactional email through your own provider

Usage:
  atlas messages send --to <address[,address...]> --template <name-or-id> [--data '{"order":"1042"}']
                      [--tag key=value ...] [--idempotency-key <key>] [--json]
  atlas messages send --to <address> --subject <text> [--html-file <file>] [--text-file <file>] [--tag key=value ...]

POST /v1/messages: the mail goes out through the instance's own email provider and failover, is recorded in the
message ledger as a transactional message, and is not sent to suppressed addresses (it is returned as 'suppressed').
Use --html-file - to read the html from stdin. A retry with the same --idempotency-key does not send twice.`,

  'oauth-clients': `atlas oauth-clients — who authorized an OAuth app

Usage:
  atlas oauth-clients consents <client-id> [--status active|revoked|all] [--limit <n>] [--starting-after <cursor>] [--json]
  atlas oauth-clients revoke-consents <client-id> [<user-id>...] --yes [--json]

consents lists each user's scopes, when they authorized the app and when it was last used.
revoke-consents revokes every active consent (or only the listed users) together with their tokens
(POST /v1/oauth_clients/{id}/consents/revoke); consents reads GET /v1/oauth_clients/{id}/consents.`,

  config: `atlas config — config-as-code for an Atlas instance (the Auth0 deploy-cli peer)

Usage:
  atlas config export [--dir <path>] [--format json|yaml]
  atlas config import [--dir <path>] [--format json|yaml] [--dry-run] [--prune] [--force-hook] [--skip-validate]
  atlas config plan   [--dir <path>] [--format json|yaml] [--prune] [--check|--exit-code] [--json]
  atlas config schema [--out <file>]
  atlas config promote --from <profile> --to <profile> [--dry-run] [--prune] [--yes] [--format json|yaml] [--skip-validate]
  atlas config snapshot [--label <text>]
  atlas config snapshots [--limit <n>]
  atlas config diff <from> [<to>]
  atlas config restore <id> [--dry-run] [--yes]

snapshot  Save the instance's configuration as it is now (secrets are never in it).
          'config import --snapshot' saves one first, so an apply can be undone.
snapshots List the saved copies, newest first (the worker also saves one after config changes).
diff      What changed between two snapshots, or one and the live config ("current").
restore   Put a snapshot back. Shows the changes, asks (--yes skips), saves the
          state it replaces first, and refuses if the config moved since the preview.

export  Read the instance's current config (instance/auth config, OAuth clients
        and providers, SSO connections, resource servers, JWT templates, roles,
        webhook endpoints, billing plans, redirect URLs, org settings schema,
        email provider, before_user_create hook, branding,
        notification and email templates, org policies) and write a deterministic
        directory tree — one file per resource type, keys sorted, SECRETS OMITTED.

import  Diff the directory against live config and apply creates/updates
        idempotently. A resource type with no file is left untouched.
          --dry-run   print the plan and apply nothing
          --prune     also delete live resources absent from the config
          --prune-type <type>  also delete live resources of one opt-in type (repeatable); a bare --prune skips those
          --include-owned  also diff clients owned by a user or created by code (skipped by default)
          --match-by-name  (deprecated) match OAuth clients by name when the file gives no id or external_ref
          --force-hook  enable a before_user_create hook even if its test call fails
          --dir       config directory (default: ./atlas-config)
          --format    json (default) or yaml

plan    A Terraform-style, read-only diff of the directory against the live
        instance: field-by-field before -> after for updates. --check (alias
        --exit-code) exits 2 when there is drift (for CI); --json for tooling.
        --fail-on-unmanaged also exits 2 when live has objects the file no longer
        declares (a provider or client deleted from the file but still live).

promote Copy one environment's configuration to another (development ->
        staging -> production). Each environment is a profile holding that
        instance's secret key ('atlas login --profile staging'). Uses the same
        plan/apply engine as import; --dry-run prints the plan only, and
        applying to a live key needs --yes. Secrets never travel.

Secrets never live in config files. Inject a credential at import with a
\${ENV_VAR} placeholder in a file (e.g. a provider "client_secret": "\${GOOGLE_SECRET}"),
resolved from the environment or from --secrets-file <dotenv> (must be mode 0600).

See also 'atlas apply' and 'atlas plan' (one config file or a directory).`,
  pages: `atlas pages — code-defined hosted-page templates

Usage:
  atlas pages list [--json]
  atlas pages push <file> --page <sign-in|sign-up|user-profile> [--promote] [--json]
  atlas pages preview --page <page> [--json]
  atlas pages promote --page <page> [--json]
  atlas pages pull --page <page> [--draft]
  atlas pages discard --page <page> --status <draft|live> [--json]

A template is a JSON file of components (heading, text, image, link, button_link,
list, divider, spacer, columns, custom) in four regions around the sign-in card:
header, above_form, below_form and footer. There is never script. A custom
component carries your own html and css (plus a frame height); Atlas accepts only
an allowlisted subset, refuses anything else with the reason, and draws it in a
sandboxed frame. Atlas validates the file and renders it. push saves a draft only; the live page does not
change until promote (or push --promote). preview prints a signed link, valid for an
hour, that shows the draft with a preview banner.`,
  actions: `atlas actions — manage Actions (tenant code run in the auth pipeline)

Usage:
  atlas actions list [--json]
  atlas actions deploy <file> --trigger <trigger> [--name <n>] [--json]
  atlas actions test <file> [--trigger <t>] [--json]
  atlas actions logs <action-id> [--json]
  atlas actions versions <action-id> [--json]                    every version, which is live, which is staged
  atlas actions release <action-id> <file> [--percent <1-99>] [--note <text>]
                                                                  new version: live now, or staged for that share of executions
  atlas actions rollout <action-id> --percent <0-100>            change a staged share; 100 promotes it, 0 aborts it
  atlas actions rollback <action-id> --to-version <n> --yes      put an earlier version back live (as a new version)

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
  'authz': resHelp('authz', 'what-if runs, authorization events, explain and RBAC checks', AUTHZ),
  'atlas-id-apps': resHelp('atlas-id-apps', 'adoption codes, adopting and releasing a Sign in with Atlas app', ATLAS_ID_APPS),
  'rate-limits': resHelp('rate-limits', 'per-subject rate limit overrides and the policy that applies (resolve takes --subject-type, --subject-id)', RATE_LIMITS),
  'risk-signals': resHelp('risk-signals', 'risk signals on record (list takes --user-id)', RISK_SIGNALS),
  'suppressions': resHelp('suppressions', 'addresses mail is never sent to', SUPPRESSIONS),
  'web-bot-auth': resHelp('web-bot-auth', 'trusted web bot key directories', WEB_BOT_AUTH),
  'abuse-signals': resHelp('abuse-signals', 'abuse signals and their summary', ABUSE_SIGNALS),
  'approval-requests': resHelp('approval-requests', 'approval requests: create, read, cancel, consume', APPROVAL_REQUESTS),
  'entitlements': resHelp('entitlements', 'consume entitlement units and refund them', ENTITLEMENTS),
  'fga-sync': resHelp('fga-sync', 'authorization sync runs, backfill and purge', FGA_SYNC),
  'impersonations': resHelp('impersonations', 'one impersonation request', IMPERSONATIONS),
  'instance': resHelp('instance', 'data-key rotation drills, deprecations, instance exports and imports', INSTANCE),
  'legal-holds': resHelp('legal-holds', 'users under legal hold', LEGAL_HOLDS),
  'mfa-campaigns': resHelp('mfa-campaigns', 'per-user state of an MFA enrolment campaign', MFA_CAMPAIGNS),
  'machine-trust-policies': resHelp('machine-trust-policies', 'test a machine trust policy', MACHINE_TRUST_POLICIES),
  'org-templates': resHelp('org-templates', 'create an organization from a template', ORG_TEMPLATES),
  'risk-based-mfa': resHelp('risk-based-mfa', 'replay risk-based MFA decisions', RISK_BASED_MFA),
  'scim-tokens': resHelp('scim-tokens', 'rotate a SCIM token', SCIM_TOKENS),
  'sso-connections': resHelp('sso-connections', 'SSO login history and connection tests', SSO_CONNECTIONS),
  'step-up': resHelp('step-up', 'assert a step-up proof', STEP_UP),
  'messaging-providers': resHelp('messaging-providers', 'fallback order and push provider', MESSAGING_PROVIDERS),
  'resource-role-assignments': resHelp('resource-role-assignments', 'changes to resource role assignments', RESOURCE_ROLE_ASSIGNMENTS),
  'resource-servers': resHelp('resource-servers', 'revoked tokens of a resource server', RESOURCE_SERVERS),
  'staging-copies': resHelp('staging-copies', 'staging copies of the instance (list takes --kind)', STAGING_COPIES),
  'platform-apps': resHelp('platform-apps', 'platform apps: refresh a clone from its source; renew the 24-hour provisioning key of a web app (platform key)', PLATFORM_APPS),
  revocations: `${resHelp('revocations', 'revoked sessions, tokens, keys, machines and banned users (list takes --after, --since, --kinds, --wait-seconds)', REVOCATIONS)}

atlas revocations stream [--after <cursor>] [--since <time>] [--kinds <list>] [--count <n>]
  Follow the live feed; one JSON frame per line. Resume with --after <cursor of the last frame>.`,
  'oauth-device': resHelp('oauth-device', 'pending device authorizations (accept or reject by user code) and the account switch of a consent request', OAUTH_DEVICE),
  analytics: resHelp('analytics', 'captcha and SMS reports (--from, --to, --days)', ANALYTICS),
  machines: resHelp('machines', 'revoked machines', MACHINES),
  'webhook-dlq': resHelp('webhook-dlq', 'dead-lettered webhook deliveries across every endpoint', WEBHOOK_DLQ),
  'org-invitations': resHelp('org-invitations', 'organization invitations across the instance (--organization-id to narrow)', ORG_INVITATIONS),
  'message-links': resHelp('message-links', 'signed links for messages', MESSAGE_LINKS),
  permissions: resHelp('permissions', 'rename a permission everywhere it is used', PERMISSIONS),
  'migration-sessions': resHelp('migration-sessions', 'start a migration session for a vendor', MIGRATION_SESSIONS),
  suite: `atlas suite — run several config-as-code tools in dependency order

Usage:
  atlas suite plan <suite.yaml>  [--only <step>] [--json]
  atlas suite apply <suite.yaml> [--only <step>] [--json]

<suite.yaml>
        steps:
          - name: atlas
            plan: atlas plan --check
            apply: atlas apply --yes
          - name: billing
            cwd: ./billing        # relative to the suite file
            plan: ./tool plan
            apply: ./tool apply
            depends_on: [atlas]
            env: { TARGET: production }

plan   runs every step's plan command, each output under a header. Exit 2 when any step
       exited 2 (drift), 1 when any failed otherwise, 0 when all are clean.
apply  runs the apply commands in dependency order and stops at the first failure;
       later steps are reported as skipped.
--only <name>  that step and the steps it depends on.   --json  a summary instead of the output.
Commands run through the shell with your environment plus the step's env. A duplicate name,
an unknown depends_on or a cycle is an error before anything runs.`,
  apply: `atlas apply — make the instance match a config file (plan, confirm, apply)

Usage:
  atlas apply [<file|dir> | --file <path>] [--yes] [--prune] [--force-hook] [--rotate-secret] [--show-secrets] [--secrets-file <dotenv>] [--out <dir>] [--secrets-out <dotenv>] [--format json|yaml] [--skip-validate] [--json]
  atlas apply [<file|dir>] --check

<file>  One JSON or YAML document keyed by resource type, for example:
          instance:            { auth_config: {...}, allowed_origins: [...] }
          redirect_urls:       [ { url: ... } ]
          oauth_clients:       [ { name: ..., redirect_uris: [...] } ]
          webhook_endpoints:   [ { url: ..., enabled_events: [...], secret: "\${WEBHOOK_SECRET}", active: false } ]
          email_provider:      { transport: brevo, from_address: ..., config: { api_key: "\${BREVO_KEY}" } }   # or resend, hermetica (api_key hm_sk_…)
          sms_provider:        { transport: twilio, from_address: "+15551234567", config: { account_sid: ..., auth_token: "\${TWILIO_TOKEN}" } }
          push_provider:       { transport: expo, config: { access_token: "\${EXPO_TOKEN}" } }   # or apns_fcm
          hooks:               { before_user_create: { url: ..., timeout_ms, fail_closed, enabled } }
          branding:            { applicationName: ..., logoUrl: ... }
          sign_in_with_atlas:  { enabled: true }
        or a directory from 'atlas config export' (default ./atlas-config).

Shows the plan, asks before applying (--yes skips the question; needed without a
terminal), then applies creates and updates in a fixed order: email_provider, sms_provider, push_provider, instance, org_settings_schema, redirect_urls, oauth_clients, hooks, oauth_providers, custom_oauth_providers, resource_servers, scopes, jwt_templates, permissions, roles, webhook_endpoints, sso_connections, sso_onboarding_profiles, billing_plans, notification_templates, email_templates, organization_policies, branding, cookie_consent, sign_in_with_atlas, signing_key_policy, domains, integrations, referrals, privacy_orchestrator, proxy_secret, hosted_pages, connection_oauth_clients, migration_bridges, impersonation_policy, connection_token_limits, connection_provider_topics, connection_reconnect, referral_reward_rules, connection_relay_limits, web_bot_auth, notification_categories, sms_templates, localizations, page_templates, passkey_campaigns, step_up_policies, mfa_campaigns, policy_settings, policy_source, actions, action_bindings, journeys, journey_experiments, workflows, app_event_types, audit_event_schemas, log_streams, audit_exports, audit_retention, telemetry_export, alert_rules, abac_policies, abac_schema, access_policies, fga_stores, fga_settings, fga_sync, authz_decision_settings, marketing_settings, groups, group_rules, permission_aliases, app_roles, resource_types, iga_sod_rules, iga_birthright_rules, iga_bundles, iga_settings, agent_registration, scim_provisioning_targets, service_connectors, logout_notify_endpoints, billing_coupons, billing_settings, billing_providers, identity_verification, user_traits_schema, rate_limit_policies, org_role_sets, org_templates, machine_trust_policies, messaging_settings, sms_country_routes, messaging_fallbacks, message_receivers, write_budget, oauth_publishers, erasure_connectors, signing_key_schedule, audit_chain, policy_audiences, oauth_publisher_clients, region, native_apps, native_apps_publishable_key, connection_provider_policies. Re-running is a no-op.
Without --prune the plan compares only the keys the file sets.
  --check         plan only; exit 2 when anything would change (CI)
  --skip-validate leave out the server dry-run pass (the published-limit checks still run)
  --json          with --yes: print what was applied, what failed and what was not applied, as JSON
Before anything is written every change is validated: the file against the limits the server
publishes (roles per resource type, permissions per role, implied permissions), then each change
against the server's own dry run. Any refusal is listed and nothing is applied (exit 1). If a change
fails while applying, the output names which changes were applied and which were not; run it again
and what was applied is a no-op.
Set-valued fields (a role's permissions, scopes, redirect URIs, event lists, allowed origins and so
on) compare without their order, so a re-plan right after apply shows no changes.
requires: [VAR, ...] on a section (an object section as a key; a list section as
{ requires: [...], items: [...] }) or on a list entry skips it with a warning
"skipped <type> <key>: VAR unset" when VAR is unset or empty, and a skipped entry's live copy is
never pruned. An action takes code_file: <path relative to the config> in place of code.
  --prune         also delete live resources missing from the config, and compare every live key
  --include-owned also diff OAuth clients owned by an Atlas user or created by code (left out by default, with a count)
  --match-by-name (deprecated) match OAuth clients by name when the file gives no id or external_ref
  --force-hook    enable the before_user_create hook even when its test call fails (409)
  --rotate-secret send again each secret Atlas cannot compare (it never returns them)
  --show-secrets  print secret values in the diff; refused without a terminal or when CI is set
  --secrets-file  dotenv file for \${VAR} placeholders; refused unless mode 0600
  --out <dir>     where a new client or webhook secret is saved (mode 0600;
                  default ~/.config/atlas). It is shown only once.
  --secrets-out <file>  put every secret this run generates into ONE dotenv file (mode 0600,
                  merged: other lines stay, re-generated keys are replaced). If a webhook
                  endpoint already exists and the file has no ATLAS_WEBHOOK_SECRET, it is read
                  back (no rotation). An existing OAuth client's secret is never rotated: the
                  'atlas client rotate' command to run is printed. Only key names are printed.
oauth_providers entries take settings.native_client_ids (a string or a list): the extra
audiences a native app's id_token may carry.
Placeholders: \${VAR} comes from the environment or --secrets-file; \${instance.fapi_host},
\${instance.frontend_api_url} and \${instance.id} come from the instance the key targets.
Applying stops if any \${VAR} is unresolved. A key the resource does not have is an
error, with the nearest real key. So is a provider mode other than native or redirect,
and a webhook secret that is not whsec_ plus 32 to 256 characters, checked whether or
not it can be compared. Secrets are never printed: a changed one shows as
"client_secret: <redacted> (changed)". Where Atlas cannot tell whether a secret changed
the plan says so instead of showing drift. A changed webhook secret is rotated with no
overlap: the old one stops signing at once.`,
  plan: `atlas plan — read-only drift diff of a config file or directory

Usage:
  atlas plan [<file|dir> | --file <path>] [--check|--exit-code] [--json] [--prune] [--rotate-secret] [--show-secrets] [--secrets-file <dotenv>] [--skip-validate]

The same diff as 'atlas config plan', also for a single config file (see 'atlas
apply --help'). --check exits 2 when there is drift (with --fail-on-unmanaged, also when live has
objects the file no longer declares); nothing is ever written.
It also runs the checks apply would hit: the file against the server's published limits, then
each change against the server's own dry run (validated, then rolled back: nothing is saved).
Errors are listed (and under "validation" in --json) and the exit code is 1. A key without write
scope cannot dry-run: that is noted and only the limit checks run. --skip-validate omits the dry run.`,
  workflows: resHelp('workflows', 'workflow runs, templates and approvals (run takes --data with input; dry-run, retry --from-step <path>, approve|deny --comment)', WORKFLOWS),
  'app-events': resHelp('app-events', 'application events: the type catalog, publishing (publish --organization-id "*" reaches every organization with an endpoint) and the log (list needs --organization-id)', APP_EVENTS),
  diagnostics: resHelp('diagnostics', 'why requests are refused (traces; --since takes an ISO time or epoch ms), whether an origin can sign in (login-readiness --origin), and what a browser request would hit (inspect --origin [--method --path --token])', DIAGNOSTICS),
  logs: `atlas logs — a live log of what the instance is doing

Usage:
  atlas logs tail [--source traces,audit,events] [--user-id <id>] [--code <code>] [--count <n>] [--timeout <dur>] [--interval <dur>] [--json]

traces  requests Atlas refused, and the step that decided it (diagnostics:read)
audit   audit log entries as they are written (audit:read)
events  the live event stream (webhooks:write); a listen session, nothing is forwarded
The default is traces and audit. They are polled every --interval (default 2s) and printed oldest
first; nothing from before the command started is shown. Ctrl-C stops it.`,
  chat: resHelp('chat', 'chat approval integrations (test a bot, list user links)', CHAT),
  'saml-idp': resHelp('saml-idp', 'SAML identity provider service providers (import-metadata takes --data with url, entity_id, mdq_base_url)', SAML_IDP),
  provisioning: resHelp('provisioning', 'outbound provisioning connectors, preview, logs and the failure inbox', PROVISIONING),
  catalog: resHelp('catalog', 'app catalog requests', CATALOG),
  cloud: resHelp('cloud', 'cloud access portal; login prints the https launch URL for a target', CLOUD),
  'device-sso': resHelp('device-sso', 'native OS SSO device registrations', DEVICE_SSO),
  'connection-actions': resHelp('connection-actions', 'actions on a connected provider account', CONNECTION_ACTIONS),
  triggers: resHelp('triggers', 'connection triggers', TRIGGERS),
  'connection-limits': resHelp('connection-limits', 'connection-token rate limits (per key, per connection, per provider) with current usage, and relay size limits; set takes --data \'{"per_key":12000,"providers":{"ebay":600}}\'', CONNECTION_LIMITS),
  agents: resHelp('agents', 'agent lifecycle, activity and access reviews', AGENTS),
  telemetry: resHelp('telemetry', 'OTLP export of gateway and relay calls', TELEMETRY),
  pdp: resHelp('pdp', 'local decision points', PDP),
  billing: resHelp('billing', 'discount codes and account credit', BILLING),
  audit: `${resHelp('audit', 'audit log retention (shortening needs confirm_deletion in --data) and the tamper-evident audit chain', AUDIT)}

atlas audit verify [--after <seq>] [--jwks-url <url>] [--json]
  Recompute the audit chain on this machine: every row hash and link hash from the exported links,
  and every signed checkpoint against the instance's published signing keys. Nothing is taken on
  Atlas's word. --after <seq> starts after that link (the link before it is trusted as given);
  --jwks-url overrides where the signing keys are read from. Exit 0 when intact, 1 when any row,
  link or checkpoint does not match. Needs the chain on: atlas audit chain-enable.`,
  federation: resHelp('federation', 'OpenID federation', FEDERATION),
  vc: resHelp('vc', 'deferred verifiable credential issuance', VC),
  'provider-changes': resHelp('provider-changes', 'changes a provider made to its scopes or terms: each affected connection is acknowledged or resolved', PROVIDER_CHANGES),
  flows: resHelp('flows', 'journey message queue (list, cancel one) and experiment readouts', FLOWS),
  'referral-rewards': resHelp('referral-rewards', 'the referral reward ledger; run applies the reward rules now (--data \'{"dry_run":true}\' to preview)', REFERRAL_REWARDS),
  policies: resHelp('policies', 'policy audience (everyone, or members of listed organizations) and per-language text of a version (set takes --data with title and content_markdown)', POLICIES),
  region: resHelp('region', 'where the instance lives; pin is one-way, set takes --failover-region and --fapi-isolation off|enforce', REGION),
  domains: resHelp('domains', 'custom domains; rotate-verification prints a new verify URL for a path mount (the old one works for 24 hours)', DOMAINS),
  'oauth-publishers': resHelp('oauth-publishers', 'verified publishers; attach takes the app\'s public client_id (--data \'{"allow_subject_change":true}\' to confirm a subject change)', OAUTH_PUBLISHERS),
  'age-assurance': resHelp('age-assurance', 'age checks on record for a user, recording one and revoking one', AGE_ASSURANCE),
  'approval-devices': resHelp('approval-devices', 'a user\'s trusted approval devices', APPROVAL_DEVICES),
  pca: resHelp('pca', 'proof-carrying authority admin: principals, bond accounts, constitutions, beacons, guardian rotation, intent schemas, post-quantum pins and workflow receipts', PCA),
  'pca-registry': resHelp('pca-registry', 'the action registry: actions and their review, drafts, namespace versions and pins, publisher keys, reviewers, sources, templates', PCA_REGISTRY),
  'pca-grants': resHelp('pca-grants', 'grants of authority (list takes --principal, --agent, --status)', PCA_GRANTS),
  'pca-approvers': resHelp('pca-approvers', 'approvers, approval settings and the needs they approve or deny', PCA_APPROVERS),
  'pca-undo': resHelp('pca-undo', 'undo records and the vetoes against them', PCA_UNDO),
  ssf: resHelp('ssf', 'shared signals: stream configuration, subjects, verification and polling', SSF),
});

for (const [name, ops] of [['api-keys', API_KEYS_MORE], ['changes', CHANGES_MORE], ['connections', CONNECTIONS_MORE], ['grants', GRANTS_MORE], ['messages', MESSAGES_MORE], ['orgs', ORGS_MORE], ['sessions', SESSIONS_MORE], ['users', USER_SECURITY]] as Array<[string, Ops]>) {
  if (Object.keys(ops).length && COMMAND_HELP[name]) COMMAND_HELP[name] += `\n\nMore subcommands:\n${resHelp(name, 'more', ops).split('\n\nUsage:\n')[1]!.split('\n\n')[0]}`;
}
