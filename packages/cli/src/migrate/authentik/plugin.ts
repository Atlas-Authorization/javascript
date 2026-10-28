import { resolve } from 'node:path';
import { CliError } from '../../errors';
import { AUTHENTIK_SUB_MODES, exportAuthentik, type AuthentikSubMode } from '../export/authentik';
import { fetchAuthentikConfig, snapshotFromBlueprint, translateAuthentikConfig } from '../export/authentik-config';
import { readDumpDir } from '../export/frameworks/tables';
import { localFile, vendorStep, writeRecordSet } from '../export/plugin-kit';
import type { CredentialSpec, MigrationPlugin, PluginContext } from '../framework/plugin';

/**
 * `atlas migrate authentik` — a self-hosted authentik: its blueprint file (or
 * the settings objects through the API) as Atlas config; users with their
 * Django password digests (PBKDF2, bcrypt, Argon2, scrypt), social and SAML
 * source links, groups and RBAC roles, API and app-password tokens, TOTP
 * seeds, recovery codes, SMS / email factors and WebAuthn passkeys from a
 * dump of authentik's own PostgreSQL tables made on this machine; the
 * `authentik` bridge preset (an OAuth2 provider's token becomes an Atlas
 * session); lazy migration through authentik's flow executor when only the API
 * is available; and the code. Nothing here connects to the database.
 */

const DUMP: CredentialSpec = { flag: '--authentik-dump', env: 'AUTHENTIK_DUMP_DIR', label: 'a folder of authentik table dumps (authentik_core_user.csv, authentik_core_group.json, …)', required: false };
const URL_: CredentialSpec = { flag: '--authentik-url', env: 'AUTHENTIK_URL', label: 'the authentik URL (https://auth.example.com)', required: false };
const TOKEN: CredentialSpec = { flag: '--authentik-token', env: 'AUTHENTIK_TOKEN', label: 'an authentik API token (Directory → Tokens, intent API)', required: false, secret: true };
const BLUEPRINT: CredentialSpec = { flag: '--authentik-blueprint', env: 'AUTHENTIK_BLUEPRINT', label: 'a blueprint YAML file (ak export_blueprint)', required: false };
const SUB_MODE: CredentialSpec = { flag: '--authentik-sub-mode', env: 'AUTHENTIK_SUB_MODE', label: `the provider's Subject mode (${AUTHENTIK_SUB_MODES.join(', ')}); default: the mode the providers in the dump use, else hashed_user_id`, required: false };
const INSTALL_ID: CredentialSpec = { flag: '--authentik-install-id', env: 'AUTHENTIK_INSTALL_ID', label: 'the install id (SELECT id FROM authentik_install_id), when the dump lacks that table', required: false };
const GROUPS_AS: CredentialSpec = { flag: '--authentik-groups-as', env: 'AUTHENTIK_GROUPS_AS', label: 'roles (default), organizations or skip: what authentik groups become', required: false };
const RP_ID: CredentialSpec = { flag: '--rp-id', env: 'ATLAS_MIGRATE_RP_ID', label: 'the WebAuthn relying party id for passkeys registered before authentik stored one (your authentik host)', required: false };
const TRUST_EMAILS: CredentialSpec = { flag: '--authentik-trust-emails', env: 'AUTHENTIK_TRUST_EMAILS', label: '"true" to treat every email address as verified (authentik has no verified flag)', required: false };
const OAUTH_TOKENS: CredentialSpec = { flag: '--authentik-oauth-tokens', env: 'AUTHENTIK_OAUTH_TOKENS', label: '"include" to carry the stored upstream OAuth access tokens of social links', required: false };
const ISSUER: CredentialSpec = { flag: '--authentik-issuer', env: 'AUTHENTIK_ISSUER', label: "the provider's issuer URL (https://auth.example.com/application/o/<application slug>)", required: false };
const CLIENT_ID: CredentialSpec = { flag: '--authentik-client-id', env: 'AUTHENTIK_CLIENT_ID', label: "the OAuth2 provider's client id (the tokens' aud)", required: false };
const FLOW_SLUG: CredentialSpec = { flag: '--authentik-flow-slug', env: 'AUTHENTIK_FLOW_SLUG', label: 'the authentication flow slug for lazy migration (default default-authentication-flow)', required: false };

const LAZY_SUB_MODES: readonly string[] = ['hashed_user_id', 'user_id', 'user_username', 'user_email'];

function subMode(p: PluginContext): AuthentikSubMode | undefined {
  const raw = p.credential(SUB_MODE)?.trim().toLowerCase();
  if (!raw) return undefined;
  if (!(AUTHENTIK_SUB_MODES as readonly string[]).includes(raw)) throw new CliError(`authentik: --set authentik-sub-mode takes ${AUTHENTIK_SUB_MODES.join(', ')} (got ${raw}).`);
  return raw as AuthentikSubMode;
}

const baseUrl = (p: PluginContext): string | undefined => p.credential(URL_)?.trim().replace(/\/+$/, '');

export const authentikPlugin: MigrationPlugin = {
  vendor: 'authentik',
  source: 'authentik',
  label: 'authentik',
  help: "Move authentik: a blueprint file (or the settings objects through the API) as Atlas config; users with their password digests, social and SAML identities, groups and roles, tokens, authenticator apps, recovery codes and passkeys from a dump of authentik's own tables made with psql; a zero-logout bridge for an OAuth2 provider's tokens; lazy migration through authentik's flows when you only have the API; and the code. Database access stays on this machine.",
  config: {
    reads: 'a blueprint YAML file, or the settings objects through the authentik API',
    credentials: [BLUEPRINT, URL_, TOKEN],
    async translate(p) {
      const url = baseUrl(p);
      const file = p.credential(BLUEPRINT);
      if (file) {
        const text = localFile(p, BLUEPRINT, 'text')!;
        return translateAuthentikConfig(await vendorStep('authentik', async () => snapshotFromBlueprint(text, file, url)));
      }
      const token = p.credential(TOKEN);
      if (url && token) return translateAuthentikConfig(await vendorStep('authentik', () => fetchAuthentikConfig({ baseUrl: url, token, fetchImpl: p.fetch })));
      throw new CliError('authentik: pass a blueprint file (--set authentik-blueprint=<file>, from `ak export_blueprint`), or the authentik URL and an API token to read the settings through the API.');
    },
  },
  export: {
    reads: "a dump of authentik's tables (psql \\copy of authentik_core_user, groups, tokens, source links, authenticator devices …) or the authentik API",
    credentials: [DUMP, URL_, TOKEN, SUB_MODE, INSTALL_ID, GROUPS_AS, RP_ID, TRUST_EMAILS, OAUTH_TOKENS],
    limits: [
      'The API never returns password hashes, TOTP seeds, recovery codes or WebAuthn public keys: dump the database tables to move them. The API export has users, groups, roles, source links and API token keys only; passwords then move by lazy migration and authenticator users enrol again.',
      'authentik has no verified-email flag: addresses are verified only when the user attribute email_verified is true, or with --set authentik-trust-emails=true.',
      'Users are keyed by the `sub` your providers hand out (the Subject mode; hashed_user_id by default, which needs the install id): the export reads it from the dump, and warns when providers disagree.',
      'Service accounts, outpost accounts and recovery or verification tokens do not move; LDAP, Kerberos and other directory source links stay with their directory.',
      'Passkeys only work on the domain they were registered for; devices registered before authentik stored an RP id need --set rp-id=<your authentik host>.',
    ],
    async run(p, writer, resume) {
      const dump = p.credential(DUMP);
      const url = baseUrl(p);
      const token = dump ? undefined : p.credential(TOKEN);
      if (!dump && !(url && token)) {
        throw new CliError('authentik: pass a folder of table dumps (--set authentik-dump=<folder>), or the authentik URL and an API token for an export without password hashes.');
      }
      const groups = p.credential(GROUPS_AS)?.trim().toLowerCase();
      if (groups && !['roles', 'organizations', 'skip'].includes(groups)) throw new CliError(`authentik: --set authentik-groups-as takes roles, organizations or skip (got ${groups}).`);
      const set = await vendorStep('authentik', () =>
        exportAuthentik({
          tables: dump ? readDumpDir(resolve(dump)) : undefined,
          baseUrl: url,
          token,
          subMode: subMode(p),
          installId: p.credential(INSTALL_ID),
          groupsAs: groups as 'roles' | 'organizations' | 'skip' | undefined,
          rpId: p.credential(RP_ID),
          trustEmails: p.credential(TRUST_EMAILS)?.toLowerCase() === 'true',
          oauthTokens: p.credential(OAUTH_TOKENS) === 'include',
          fetchImpl: p.fetch,
          onProgress: (m) => p.say(`  reading ${m}`),
        }),
      );
      await writeRecordSet(set, writer, resume, p.say);
    },
  },
  bridge: {
    preset: 'authentik',
    vars(p, t) {
      const vars: Record<string, string> = { ...t?.bridge?.vars };
      const issuer = p.credential(ISSUER);
      if (issuer) vars.issuer = issuer.trim().replace(/\/+$/, '');
      const clientId = p.credential(CLIENT_ID);
      if (clientId) vars.client_id = clientId.trim();
      return vars;
    },
  },
  lazy: {
    preset: 'authentik',
    config(p, t) {
      const config: Record<string, string> = { ...t?.lazy?.config };
      const url = baseUrl(p);
      if (url) config.base_url = url;
      const flow = p.credential(FLOW_SLUG);
      if (flow) config.flow_slug = flow.trim();
      const mode = subMode(p);
      if (mode) {
        if (!LAZY_SUB_MODES.includes(mode)) throw new CliError(`authentik: lazy migration reads the user from a session, which has no ${mode}: use ${LAZY_SUB_MODES.join(', ')}, or move users with the database export.`);
        config.sub_mode = mode;
      }
      return config;
    },
  },
  codemod: 'authentik',
};
