import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CanonicalModel, CanonicalRecordData, MigrationSource } from '@atlasauth/migrate';
import { str } from '../../args';
import { CliError } from '../../errors';
import { exportAppUsers, type AppUsersExportOptions } from '../export/frameworks/app-users';
import { exportAuthJs } from '../export/frameworks/authjs';
import { DEVISE_EXPORT_SCRIPT, exportDevise } from '../export/frameworks/devise';
import { DJANGO_EXPORT_SCRIPT, exportDjango } from '../export/frameworks/django';
import { exportLucia } from '../export/frameworks/lucia';
import { type FrameworkExport, Tables, parseTableText, readDumpDir, tablesFromStream } from '../export/frameworks/tables';
import type { CredentialSpec, MigrationPlugin, PluginContext, TranslationResult } from '../framework/plugin';
import { translateAuthJs, translateIronSession, translateLucia, translatePassport } from './translate-js';
import { translateDevise, translateDjango } from './translate-rails-django';

/**
 * The `atlas migrate <vendor>` plugins for the self-hosted frameworks:
 * Auth.js / NextAuth, Lucia, Passport (+ express-session), iron-session,
 * Devise and Django (contrib.auth + allauth).
 *
 * These keep users in the APP's database, so there is no vendor API to call:
 * `config` reads the app's source (statically), `export` reads table dumps
 * made with the owner's own tools (`--set dump=<dir>`) or the NDJSON a
 * framework export script prints (`--file <path>`, `--file -` for stdin).
 * Database credentials and app secrets never reach the CLI, let alone Atlas.
 */

// ── Shared inputs ───────────────────────────────────────────────────────────

const DUMP: CredentialSpec = { flag: '--dump', env: 'ATLAS_MIGRATE_DUMP', label: 'the folder of table dumps (--set dump=<dir>)', required: false };
const RP_ID: CredentialSpec = { flag: '--rp-id', env: 'ATLAS_MIGRATE_RP_ID', label: 'the WebAuthn relying-party id passkeys were registered on (your domain)', required: false };
const SESSIONS: CredentialSpec = { flag: '--sessions', env: 'ATLAS_MIGRATE_SESSIONS', label: 'whether to export live sessions (true / false)', required: false };

function setting(p: PluginContext, name: string, env: string, label: string, secret = false): string | undefined {
  return p.credential({ flag: `--${name}`, env, label, required: false, secret });
}

function flagBool(p: PluginContext, spec: CredentialSpec, fallback: boolean): boolean {
  const v = p.credential(spec)?.toLowerCase();
  if (v === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new CliError(`${spec.label}: expected true or false, got "${v}".`);
}

/** The `--file` path, `-` for stdin. */
function fileArg(p: PluginContext): string | undefined {
  return str(p.args.values, 'file');
}

/**
 * The tables to export from: `--file` (an export script's NDJSON stream, or a
 * single JSON / NDJSON / CSV table file) and/or `--set dump=<dir>`.
 */
export function readInput(p: PluginContext, opts: { singleFile?: (text: string, tables: Tables) => void } = {}): Tables {
  const dump = p.credential(DUMP);
  const file = fileArg(p);
  const tables = dump ? readDumpDir(resolve(dump)) : new Tables();
  if (file) {
    const text = file === '-' ? readFileSync(0, 'utf8') : p.ctx.readFile(resolve(file));
    if (opts.singleFile && !looksLikeStream(text)) opts.singleFile(text, tables);
    else tablesFromStream(text, tables);
  }
  return tables;
}

/** True for the export scripts' `{"table": …, "row": …}` NDJSON. */
function looksLikeStream(text: string): boolean {
  return /^\s*\{\s*"table"\s*:/m.test(text);
}

function needInput(p: PluginContext, hint: string): void {
  if (!p.credential(DUMP) && !fileArg(p)) throw new CliError(hint);
}

/** Write a framework export's rows through the bundle writer, in canonical order. */
export async function writeFrameworkExport(p: PluginContext, out: FrameworkExport, writer: Parameters<NonNullable<MigrationPlugin['export']>['run']>[1]): Promise<void> {
  for (const w of out.warnings) writer.warn(w);
  for (const [model, o] of Object.entries(out.omitted)) writer.omit(model, o.reason, o.count);
  let written = 0;
  for (const [model, data] of out.entries()) {
    const issues = await writer.add(model as CanonicalModel, data as CanonicalRecordData[CanonicalModel]);
    if (issues.length) p.say(`  left out a ${model}: ${issues[0]!.message}`);
    else written++;
  }
  const counts = Object.entries(out.counts()).map(([m, n]) => `${n} ${m}`).join(', ');
  p.say(`  read ${counts || 'no records'} (${written} written)`);
}

/** The bridge preset and variables: the translation's when there is one, flags over it. */
function bridgeVars(p: PluginContext, translation: TranslationResult | undefined, names: string[]): Record<string, string> {
  const vars: Record<string, string> = { ...(translation?.bridge?.vars ?? {}) };
  for (const name of names) {
    const v = p.credential({ flag: `--${name.replace(/_/g, '-')}`, env: `ATLAS_BRIDGE_${name.toUpperCase()}`, label: name, required: false });
    if (v) vars[name] = v;
  }
  return vars;
}

function lazyConfig(p: PluginContext, translation: TranslationResult | undefined, keys: string[]): Record<string, string> {
  const config: Record<string, string> = { ...(translation?.lazy?.config ?? {}) };
  for (const key of keys) {
    const v = p.credential({ flag: `--${key.replace(/_/g, '-')}`, env: `ATLAS_LAZY_${key.toUpperCase()}`, label: key, required: false });
    if (v) config[key] = v;
  }
  // A placeholder from the source is not a URL the preset can call.
  for (const [k, v] of Object.entries(config)) if (v.includes('${')) delete config[k];
  return config;
}

/** Presets whose token is a bridge assertion signed on the owner's server (see the backend extractors). */
export const ASSERTION_PRESETS = new Set(['authjs_jwt', 'iron_session', 'devise', 'django_signed_cookies']);

/**
 * The bridge secret shared by the extractor on your server and Atlas:
 * `--set bridge-secret=…` / ATLAS_BRIDGE_SECRET, else the one generated on an
 * earlier run, else a new one — kept in atlas-migrate/<vendor>/bridge-secret
 * (mode 0600) for your server's ATLAS_BRIDGE_SECRET.
 */
export function bridgeSecret(p: PluginContext, vendor: string, preset: string): string | undefined {
  if (!ASSERTION_PRESETS.has(preset)) return undefined;
  const given = p.credential({ flag: '--bridge-secret', env: 'ATLAS_BRIDGE_SECRET', label: 'the bridge secret', required: false, secret: true });
  if (given) return given;
  const path = resolve(p.project, 'atlas-migrate', vendor, 'bridge-secret');
  if (existsSync(path)) {
    const kept = readFileSync(path, 'utf8').trim();
    if (kept) return kept;
  }
  const secret = randomBytes(32).toString('base64url');
  mkdirSync(resolve(p.project, 'atlas-migrate', vendor), { recursive: true });
  writeFileSync(path, `${secret}\n`, { mode: 0o600 });
  p.say(`  generated the bridge secret in ${path}: set it as ATLAS_BRIDGE_SECRET on the server that runs the bridge middleware (it never goes in your code)`);
  return secret;
}

function frameworkPlugin(input: {
  vendor: string;
  source: MigrationSource;
  label: string;
  help: string;
  reads: string;
  translate: (project: string) => TranslationResult;
  exportReads: string;
  credentials: CredentialSpec[];
  /** Input checks before anything is fetched or written (throws a CliError). */
  check: (p: PluginContext) => void;
  run: (p: PluginContext) => FrameworkExport;
  limits: string[];
  bridgePreset: string;
  bridgeVarNames: string[];
  lazy?: { preset: string; keys: string[] };
  codemod?: string;
}): MigrationPlugin {
  return {
    vendor: input.vendor,
    source: input.source,
    label: input.label,
    help: input.help,
    config: {
      reads: input.reads,
      async translate(p) {
        return input.translate(p.project);
      },
    },
    export: {
      reads: input.exportReads,
      credentials: input.credentials,
      limits: input.limits,
      check: input.check,
      async run(p, writer) {
        const out = input.run(p);
        await writeFrameworkExport(p, out, writer);
      },
    },
    bridge: {
      preset: input.bridgePreset,
      vars: (p, translation) => bridgeVars(p, translation, input.bridgeVarNames),
      sharedSecret: (p, preset) => bridgeSecret(p, input.vendor, preset),
    },
    ...(input.lazy
      ? {
          lazy: {
            preset: input.lazy.preset,
            config: (p: PluginContext, translation?: TranslationResult) => lazyConfig(p, translation, input.lazy!.keys),
            optional: true,
          },
        }
      : {}),
    ...(input.codemod ? { codemod: input.codemod } : {}),
  };
}

const DUMP_HINT = (vendor: string, tables: string) =>
  `Export your ${tables} first, one file per table (<table>.csv / .json / .ndjson — psql \\copy, sqlite3 -json, mongoexport, mysqldump --tab), then pass the folder: atlas migrate ${vendor} export --set dump=<dir>.`;

// ── Auth.js / NextAuth ──────────────────────────────────────────────────────

export const authJsPlugin = frameworkPlugin({
  vendor: 'authjs',
  source: 'authjs',
  label: 'Auth.js (NextAuth)',
  help:
    'Moves an Auth.js / NextAuth v4 or v5 app: config reads your NextAuth(...) / Auth(...) options (providers, session strategy and lifetime, cookies, pages); export reads your adapter tables (User, Account, Session, Authenticator) from a dump folder (--set dump=<dir>) — Prisma, Drizzle, Kysely, TypeORM, MongoDB and the SQL adapters all use these shapes. Database sessions bridge through the imported session table (preset authjs); JWT sessions are decrypted on your server with AUTH_SECRET (preset authjs_jwt).',
  reads: 'your Auth.js configuration (auth.ts / [...nextauth].ts), statically',
  translate: translateAuthJs,
  exportReads: 'a dump of your Auth.js adapter tables (--set dump=<dir>)',
  credentials: [DUMP, RP_ID, SESSIONS],
  check: (p) => needInput(p, DUMP_HINT('authjs', 'adapter tables (User, Account, Session, Authenticator)')),
  run(p) {
    return exportAuthJs(readInput(p), {
      rpId: p.credential(RP_ID),
      oauthTokens: flagBool(p, { flag: '--oauth-tokens', env: 'ATLAS_MIGRATE_OAUTH_TOKENS', label: 'whether to carry OAuth access / refresh tokens', required: false }, false),
      sessions: flagBool(p, SESSIONS, true),
      passwordColumn: setting(p, 'password-column', 'ATLAS_MIGRATE_PASSWORD_COLUMN', 'the users column holding a Credentials-provider hash'),
    });
  },
  limits: [
    'Passwords exist only if your Credentials provider stored hashes; a scheme Atlas cannot verify falls back to lazy migration (preset authjs_credentials).',
    'JWT-strategy sessions live only in the browser: the bridge decrypts them on your server with AUTH_SECRET (preset authjs_jwt).',
    'Verification tokens (magic links in flight) are not exported: those links expire and users request a new one.',
  ],
  bridgePreset: 'authjs',
  bridgeVarNames: ['cookie_name'],
  lazy: { preset: 'authjs_credentials', keys: ['base_url', 'provider_id', 'identifier_field'] },
  codemod: 'authjs',
});

// ── Lucia ───────────────────────────────────────────────────────────────────

export const luciaPlugin = frameworkPlugin({
  vendor: 'lucia',
  source: 'lucia',
  label: 'Lucia',
  help:
    'Moves a Lucia v2 / v3 app or one built on the Lucia guide (the post-v3 "sessions from scratch" pattern): config reads new Lucia(...) (session expiry, cookie name and attributes) and your Arctic OAuth providers; export reads the user, session, key / oauth_account, and guide TOTP / recovery / passkey tables from a dump folder. Sessions bridge through the imported session table (preset lucia).',
  reads: 'your Lucia setup (new Lucia(...) and Arctic providers), statically',
  translate: translateLucia,
  exportReads: 'a dump of your Lucia tables (--set dump=<dir>)',
  credentials: [DUMP, RP_ID, SESSIONS, { flag: '--encryption-key', env: 'LUCIA_ENCRYPTION_KEY', label: 'the guide ENCRYPTION_KEY (base64), for TOTP keys and recovery codes', required: false, secret: true }],
  check: (p) => needInput(p, DUMP_HINT('lucia', 'user, session and oauth_account / key tables')),
  run(p) {
    const hashing = setting(p, 'session-hashing', 'ATLAS_MIGRATE_SESSION_HASHING', 'how session ids store the token (none / sha256-hex)');
    if (hashing && hashing !== 'none' && hashing !== 'sha256-hex') throw new CliError('session-hashing must be none or sha256-hex.');
    return exportLucia(readInput(p), {
      rpId: p.credential(RP_ID),
      sessions: flagBool(p, SESSIONS, true),
      encryptionKey: setting(p, 'encryption-key', 'LUCIA_ENCRYPTION_KEY', 'the guide ENCRYPTION_KEY', true),
      sessionIdHashing: hashing as 'none' | 'sha256-hex' | undefined,
      userTable: setting(p, 'user-table', 'ATLAS_MIGRATE_USER_TABLE', 'the user table name'),
      sessionTable: setting(p, 'session-table', 'ATLAS_MIGRATE_SESSION_TABLE', 'the session table name'),
      oauthTable: setting(p, 'oauth-table', 'ATLAS_MIGRATE_OAUTH_TABLE', 'the OAuth account table name'),
    });
  },
  limits: [
    'Guide-style TOTP keys and recovery codes are encrypted with your ENCRYPTION_KEY: pass it (--set encryption-key=…, read only on this machine) or those users enrol again.',
    'Passkeys with an algorithm other than ES256 cannot be converted and are re-registered.',
  ],
  bridgePreset: 'lucia',
  bridgeVarNames: ['cookie_name'],
  codemod: 'lucia',
});

// ── Passport / iron-session (the app's own users table) ─────────────────────

function appUsersOptions(p: PluginContext): AppUsersExportOptions {
  const s = (name: string, label: string) => setting(p, name, `ATLAS_MIGRATE_${name.toUpperCase().replace(/-/g, '_')}`, label);
  const identityColumns = s('identity-columns', 'provider=column pairs, comma separated (google=googleId,github=githubId)');
  const digest = s('plm-digest', 'the passport-local-mongoose digest (sha1 / sha256 / sha512)');
  if (digest && !['sha1', 'sha256', 'sha512'].includes(digest)) throw new CliError('plm-digest must be sha1, sha256 or sha512.');
  const iterations = s('plm-iterations', 'the passport-local-mongoose iteration count');
  if (iterations && !/^\d+$/.test(iterations)) throw new CliError('plm-iterations must be a whole number.');
  return {
    usersTable: s('users-table', 'the users table'),
    idColumn: s('id-column', 'the user id column'),
    emailColumn: s('email-column', 'the email column'),
    emailVerifiedColumn: s('email-verified-column', 'the email-verified column'),
    usernameColumn: s('username-column', 'the username column'),
    nameColumn: s('name-column', 'the display name column'),
    passwordColumn: s('password-column', 'the password hash column'),
    plmDigest: digest as AppUsersExportOptions['plmDigest'],
    plmIterations: iterations ? Number(iterations) : undefined,
    identityColumns: identityColumns ? parsePairs(identityColumns) : undefined,
    identitiesTable: s('identities-table', 'a separate social identities table'),
    sessionsTable: s('sessions-table', 'the express-session store table'),
    sessionUserPath: s('session-user-path', 'where the user id sits in the session JSON'),
    sessions: flagBool(p, SESSIONS, true),
  };
}

/** `google=googleId,github=github_id` → { google: 'googleId', github: 'github_id' }. */
export function parsePairs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.split(',')) {
    const [k, v] = part.split('=').map((x) => x.trim());
    if (!k || !v) throw new CliError(`identity-columns: "${part}" is not provider=column.`);
    out[k] = v;
  }
  return out;
}

const APP_USERS_CREDENTIALS = [DUMP, SESSIONS];

export const passportPlugin = frameworkPlugin({
  vendor: 'passport',
  source: 'passport',
  label: 'Passport.js',
  help:
    'Moves an Express app on Passport.js and express-session: config reads your strategies (local, social, OIDC, SAML, JWT) and session() options; export reads YOUR users table by column (bcrypt, Argon2, scrypt, PBKDF2 and passport-local-mongoose hashes carry over), linked provider ids, and the express-session store (connect-pg-simple, connect-mongo, connect-redis dumps). Sessions bridge through the imported store (preset passport).',
  reads: 'your Passport strategies and express-session options, statically',
  translate: translatePassport,
  exportReads: 'a dump of your users table and session store (--set dump=<dir>)',
  credentials: APP_USERS_CREDENTIALS,
  check: (p) => needInput(p, DUMP_HINT('passport', 'users table (and your express-session store table)')),
  run(p) {
    return exportAppUsers(readInput(p), appUsersOptions(p));
  },
  limits: [
    'Passport keeps no user store of its own: name your users table and columns when they differ from the defaults (--set users-table=… --set email-column=… --set password-column=…).',
    'MemoryStore sessions cannot be exported: those users sign in again once.',
    'A password scheme Atlas cannot verify falls back to lazy migration through a verify endpoint in your app (preset webhook).',
  ],
  bridgePreset: 'passport',
  bridgeVarNames: ['cookie_name'],
  codemod: 'passport',
});

export const ironSessionPlugin = frameworkPlugin({
  vendor: 'iron-session',
  source: 'iron_session',
  label: 'iron-session',
  help:
    'Moves an app that keeps its session in an iron-session sealed cookie: config reads your session options (cookieName, ttl, cookieOptions); export reads YOUR users table by column. The session itself only exists in the cookie, so the bridge unseals it on your server with the session password (preset iron_session) and Atlas only sees a short-lived signed assertion.',
  reads: 'your getIronSession / sealData options, statically',
  translate: translateIronSession,
  exportReads: 'a dump of your users table (--set dump=<dir>)',
  credentials: APP_USERS_CREDENTIALS,
  check: (p) => needInput(p, DUMP_HINT('iron-session', 'users table')),
  run(p) {
    return exportAppUsers(readInput(p), { ...appUsersOptions(p), sessions: false });
  },
  limits: [
    'iron-session has no server-side session store and no user table: export your own users table; sessions move through the bridge only.',
  ],
  bridgePreset: 'iron_session',
  bridgeVarNames: ['cookie_name'],
  codemod: 'iron-session',
});

// ── Devise / Django (an export script run inside the app) ───────────────────

/** Write the export script into the migration folder and explain how to run it. */
function scriptMissing(p: PluginContext, vendor: string, file: string, script: string, run: string): never {
  const dir = resolve(p.project, 'atlas-migrate', vendor);
  const path = join(dir, file);
  if (!p.dryRun) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, script, { mode: 0o600 });
  }
  throw new CliError(`Wrote the export script to ${path}. Run it inside your app and pipe it in:\n  ${run.replace('{script}', join('atlas-migrate', vendor, file))}\n(or redirect it to a file and pass --file <path>).`);
}

export const devisePlugin = frameworkPlugin({
  vendor: 'devise',
  source: 'devise',
  label: 'Devise (Rails)',
  help:
    'Moves a Rails app on Devise: config reads config/initializers/devise.rb, your Devise models, OmniAuth providers and the session store; export runs a small Rails runner script inside your app (written for you on the first run) that streams users, confirmable / lockable state, OmniAuth identities, devise-two-factor secrets and activerecord-session_store sessions — bcrypt hashes (with your pepper) carry over. Cookie-store sessions bridge through deviseExtractor on your server (preset devise); activerecord sessions through the imported table (devise_active_record).',
  reads: 'config/initializers/devise.rb, your Devise models and session store, statically',
  translate: translateDevise,
  exportReads: 'the Rails export script output (--file <path>, or --file - to pipe it)',
  credentials: [SESSIONS],
  check(p) {
    if (!fileArg(p) && !p.credential(DUMP)) scriptMissing(p, 'devise', 'atlas_export.rb', DEVISE_EXPORT_SCRIPT, 'bin/rails runner {script} [User] | atlas migrate devise export --file -');
  },
  run(p) {
    return exportDevise(readInput(p), {
      usersTable: setting(p, 'users-table', 'ATLAS_MIGRATE_USERS_TABLE', 'the Devise model table'),
      trustUnconfirmable: flagBool(p, { flag: '--trust-unconfirmable', env: 'ATLAS_MIGRATE_TRUST_UNCONFIRMABLE', label: 'treat emails as verified when the model is not :confirmable', required: false }, false),
      sessions: flagBool(p, SESSIONS, true),
    });
  },
  limits: [
    'devise-encryptable digests (SHA-1/SHA-512, Authlogic, restful_authentication) do not carry over: those users migrate lazily (preset devise_json) or reset.',
    'Cookie-store sessions are opened on your server with secret_key_base; the bridge needs the JSON (or hybrid) cookie serializer, not Marshal.',
  ],
  bridgePreset: 'devise',
  bridgeVarNames: ['cookie_name'],
  lazy: { preset: 'devise_json', keys: ['base_url', 'path', 'scope'] },
});

export const djangoPlugin = frameworkPlugin({
  vendor: 'django',
  source: 'django',
  label: 'Django (contrib.auth, django-allauth)',
  help:
    'Moves a Django app on django.contrib.auth with or without django-allauth: config reads settings.py (password hashers and validators, session engine and age, allauth account / socialaccount / mfa settings); export reads `manage.py dumpdata` JSON or, better, the export script (written for you on the first run) that also decrypts allauth TOTP secrets and lists unused recovery codes. pbkdf2_sha256, argon2, bcrypt_sha256 and scrypt hashes carry over. Database sessions bridge through the imported table (preset django); signed-cookie sessions through djangoSignedCookieExtractor (django_signed_cookies).',
  reads: 'your Django settings, statically',
  translate: translateDjango,
  exportReads: 'manage.py dumpdata JSON or the export script output (--file <path>, or --file - to pipe it)',
  credentials: [SESSIONS, RP_ID],
  check(p) {
    if (!fileArg(p) && !p.credential(DUMP)) scriptMissing(p, 'django', 'atlas_export.py', DJANGO_EXPORT_SCRIPT, 'python manage.py shell < {script} | atlas migrate django export --file -');
  },
  run(p) {
    const tables = readInput(p, {
      // dumpdata: one JSON array of { model, pk, fields }, which the exporter reads as the "dumpdata" table.
      singleFile: (text, into) => into.set('dumpdata', parseTableText(text, '.json')),
    });
    return exportDjango(tables, {
      userModel: setting(p, 'user-model', 'ATLAS_MIGRATE_USER_MODEL', 'AUTH_USER_MODEL (app_label.model)'),
      rpId: p.credential(RP_ID),
      oauthTokens: flagBool(p, { flag: '--oauth-tokens', env: 'ATLAS_MIGRATE_OAUTH_TOKENS', label: 'whether to carry OAuth tokens', required: false }, false),
      sessions: flagBool(p, SESSIONS, true),
      trustEmails: flagBool(p, { flag: '--trust-emails', env: 'ATLAS_MIGRATE_TRUST_EMAILS', label: 'treat user.email as verified without allauth', required: false }, false),
    });
  },
  limits: [
    'allauth recovery codes and TOTP secrets encrypted by a custom MFA adapter need the export script (run inside your app); a plain dumpdata leaves them out.',
    'cache and file session engines cannot be exported: those users sign in again once. Signed-cookie sessions are opened on your server with SECRET_KEY.',
    'A custom password hasher falls back to lazy migration through the allauth headless API (preset allauth_headless).',
  ],
  bridgePreset: 'django',
  bridgeVarNames: ['cookie_name'],
  lazy: { preset: 'allauth_headless', keys: ['base_url', 'login_field'] },
});

export const FRAMEWORK_PLUGINS: readonly MigrationPlugin[] = [authJsPlugin, luciaPlugin, passportPlugin, ironSessionPlugin, devisePlugin, djangoPlugin];
