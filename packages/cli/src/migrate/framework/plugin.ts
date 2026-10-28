import type { MigrationBundleWriter, MigrationSource } from '@atlasauth/migrate';
import type { ParsedArgs } from '../../args';
import type { RunContext } from '../../context';
import type { Json } from '../../serialize';

/**
 * The TRANSLATOR PLUGIN interface behind `atlas migrate <vendor> [config|export|import|bridge]`.
 *
 * One plugin per vendor, registered in ./registry.ts. The framework owns the
 * command surface, the resumable orchestrator (`atlas migrate <vendor>` with
 * no subcommand runs every step with checkpoints), the upload/import of the
 * bundle, the bridge settings call and the codemod hand-off; a plugin only
 * supplies the vendor-specific parts:
 *
 *   config  read the vendor's configuration (its API with the owner's
 *           credentials, an export file, or the app's config source) and
 *           translate it into Atlas config-as-code plus a report in which
 *           every setting is `mapped` (1:1), `differs`, or `manual`, with where
 *           it came from (file:line or the vendor setting path).
 *   export  read the vendor's users / orgs / … and write them through the
 *           {@link MigrationBundleWriter} the framework hands over (sealed to
 *           the instance's import key). Vendor credentials come from flags or
 *           env vars ON THIS MACHINE and are never sent to Atlas.
 *   bridge  the zero-logout bridge preset and its variables (resolved from the
 *           translation or flags), applied with PUT /v1/migrations/{source}/bridge.
 *   lazy    the lazy-migration preset for vendors whose hashes never leave
 *           (applied with PUT /v1/legacy_auth_connection).
 *   code    the `atlas migrate code --from <vendor>` codemod id, when one exists.
 */

export type ReportStatus = 'mapped' | 'differs' | 'manual';

/** One line of the translation report. */
export interface TranslationReportEntry {
  status: ReportStatus;
  /** The vendor area (`connections`, `tenant settings`, `plugin:organization` …). */
  area: string;
  /** The vendor setting path (`session_lifetime`, `password_policy.min_length`). */
  setting: string;
  /** Where it lands in Atlas (`auth_config.session.idleMs`, `oauth_providers google`). */
  atlas?: string;
  note: string;
  /** Source location for a config read from code (file and 1-based line); absent for an API/file read. */
  file?: string;
  line?: number;
}

/** Atlas config-as-code, as `atlas config import --dir` reads it. Keys are the document types. */
export type ConfigDocuments = Record<string, Json>;

export interface TranslationResult {
  /** Where the config was read from, for the report header (`auth0 tenant acme.us.auth0.com`, `src/auth.ts`). */
  origin: string;
  documents: ConfigDocuments;
  report: TranslationReportEntry[];
  /** Env vars the documents' `${NAME}` placeholders need at import time. */
  env: Array<{ name: string; for: string }>;
  /** Vendor ids → Atlas ids for the data import and the codemod (provider keys, role keys). */
  mappings: { providers: Record<string, string>; roles: Record<string, string> };
  /** What the bridge step needs, when the translation learned it (preset variables, cookie names). */
  bridge?: { preset: string; vars: Record<string, string> };
  /** What the lazy-migration step needs, when the translation learned it. */
  lazy?: { preset: string; config: Record<string, string> };
}

/**
 * A credential an exporter needs, read from `--set <flag>=<value>` or an env
 * var — never sent to Atlas. (Vendor flags are `--set` pairs because the CLI's
 * option schema is strict and shared by every command.)
 */
export interface CredentialSpec {
  /** The `--set` name (`auth0-domain` → `--set auth0-domain=acme.us.auth0.com`). A leading `--` is ignored. */
  flag: string;
  /** The env var (`AUTH0_DOMAIN`). */
  env: string;
  label: string;
  required: boolean;
  secret?: boolean;
}

/** Everything a plugin step gets. */
export interface PluginContext {
  ctx: RunContext;
  args: ParsedArgs;
  /** The project folder (`atlas migrate <vendor> <step> [path]`). */
  project: string;
  /** `--set` / env lookup for a credential spec (`--set` wins). Throws a CliError when a required one is missing. */
  credential(spec: CredentialSpec): string | undefined;
  /** HTTP for the VENDOR's API (injectable for tests — never real vendors in tests). */
  fetch: typeof fetch;
  /** Progress line (stderr in --json mode). */
  say(line: string): void;
  dryRun: boolean;
}

export interface ExportSummary {
  counts: Record<string, number>;
  omitted: Record<string, { count: number; reason: string }>;
  warnings: string[];
}

/** An exporter's checkpoint, so `--resume` restarts a long export where it stopped (opaque to the framework). */
export type ExportCursor = Json;

export interface MigrationPlugin {
  /** CLI spelling (`auth0`, `better-auth`). */
  vendor: string;
  source: MigrationSource;
  label: string;
  /** One-paragraph help for `atlas migrate <vendor> --help`. */
  help: string;
  config?: {
    /** What `config` reads (`your Auth0 tenant via the Management API`, `your auth.ts`). */
    reads: string;
    credentials?: CredentialSpec[];
    translate(p: PluginContext): Promise<TranslationResult>;
  };
  export?: {
    reads: string;
    credentials: CredentialSpec[];
    /**
     * Write every record through `writer` in canonical model order (the writer
     * enforces it). `cursor` is the last checkpoint this export saved with
     * `checkpoint` (resume), or null on a fresh run.
     */
    run(p: PluginContext, writer: MigrationBundleWriter, resume: { cursor: ExportCursor | null; checkpoint(cursor: ExportCursor): void }): Promise<void>;
    /** Input checks before the import key is fetched or a segment is opened (throw a CliError to stop). */
    check?(p: PluginContext): void;
    /** What cannot be exported and the fallback, shown before the export runs. */
    limits?: string[];
  };
  bridge?: {
    /** The default preset; a translation's `bridge.preset` (e.g. Auth.js JWT vs database sessions) wins over it. */
    preset: string;
    /** When the vendor has several presets (hosted / self-hosted, token / cookie): the one the flags pick; `preset` otherwise. */
    presetFor?(p: PluginContext, translation?: TranslationResult): string;
    /** Preset variables from flags / the translation; missing ones are asked for. */
    vars(p: PluginContext, translation?: TranslationResult): Record<string, string>;
    /**
     * The HS256 shared secret for presets whose tokens are signed on the
     * owner's server (a bridge assertion from an extractor), or undefined.
     * Sent once as `shared_secret` (write-only on the Atlas side).
     */
    sharedSecret?(p: PluginContext, preset: string): string | undefined;
  };
  lazy?: {
    preset: string;
    config(p: PluginContext, translation?: TranslationResult): Record<string, string>;
    /**
     * Only a fallback (the hashes export): the program skips the step unless
     * the translation asked for it or settings were given.
     */
    optional?: boolean;
    /** Where the vendor secret comes from (a credential spec), when the preset needs one. */
    secret?: CredentialSpec;
  };
  /** The codemod vendor id (`atlas migrate code --from <id>`). */
  codemod?: string;
}
