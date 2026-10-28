import { resolve } from 'node:path';
import { CliError } from '../../errors';
import { readDumpDir } from '../export/frameworks/tables';
import { exportHankoApi, exportHankoTables } from '../export/hanko';
import { settingsFromYaml, translateHankoConfig } from '../export/hanko-config';
import { vendorStep, writeRecordSet } from '../export/plugin-kit';
import type { CredentialSpec, MigrationPlugin, PluginContext } from '../framework/plugin';

/**
 * `atlas migrate hanko` — Hanko, self-hosted or Hanko Cloud: `config.yaml` as
 * Atlas config; users with their emails, usernames, bcrypt or Firebase-scrypt
 * password hashes, TOTP secrets, passkeys and security keys, third-party and
 * SAML identities, organizations and roles from a dump of the Hanko database
 * made on this machine (or, without database access, passkeys, emails and
 * profiles through the Admin API); the `hanko` bridge presets (the session JWT
 * is verified against the API's `/.well-known/jwks.json`); lazy migration
 * through Hanko's password endpoint for the passwords an API export cannot
 * carry; and the code.
 */

const DUMP: CredentialSpec = { flag: '--hanko-dump', env: 'HANKO_DUMP_DIR', label: 'a folder of Hanko database table dumps (users.csv, emails.csv, passkeys …)', required: false };
const ADMIN_URL: CredentialSpec = { flag: '--hanko-admin-url', env: 'HANKO_ADMIN_URL', label: 'the Hanko Admin API URL (self-hosted server.admin.address, or your Hanko Cloud admin URL)', required: false };
const API_KEY: CredentialSpec = { flag: '--hanko-api-key', env: 'HANKO_API_KEY', label: 'a Hanko Cloud API key (Admin API export only)', required: false, secret: true };
const API_URL: CredentialSpec = { flag: '--hanko-api-url', env: 'HANKO_API_URL', label: 'the public Hanko API URL (https://<project id>.hanko.io): its signing keys, the bridge and lazy migration', required: false };
const RP_ID: CredentialSpec = { flag: '--hanko-rp-id', env: 'HANKO_RP_ID', label: 'the WebAuthn relying party id passkeys were registered for (webauthn.relying_party.id, e.g. example.com)', required: false };
const TENANT: CredentialSpec = { flag: '--hanko-tenant-id', env: 'HANKO_TENANT_ID', label: 'multi-tenant Hanko: the tenant id to export', required: false };
const CONFIG_FILE: CredentialSpec = { flag: '--hanko-config', env: 'HANKO_CONFIG_FILE', label: "Hanko's config.yaml", required: false };
const ISSUER: CredentialSpec = { flag: '--hanko-issuer', env: 'HANKO_ISSUER', label: "the session.issuer you configured, when it is not the API URL", required: false };

const apiUrl = (p: PluginContext): string | undefined => p.credential(API_URL)?.trim().replace(/\/+$/, '');

export const hankoPlugin: MigrationPlugin = {
  vendor: 'hanko',
  source: 'hanko',
  label: 'Hanko',
  help: "Move Hanko, self-hosted or Cloud: config.yaml as Atlas config; users with their emails, password hashes, TOTP secrets, passkeys, social and SAML identities and organizations from a dump of the Hanko database made with psql; without database access, emails, profiles and passkeys through the Admin API (passwords then move by lazy migration); a zero-logout bridge for Hanko's session JWT; and the code. Database access stays on this machine.",
  config: {
    reads: "Hanko's config.yaml (Hanko Cloud keeps its settings in the console: copy them by hand, see the guide)",
    credentials: [CONFIG_FILE, API_URL],
    async translate(p) {
      const path = p.credential(CONFIG_FILE) ?? `${p.project}/config.yaml`;
      let text: string;
      try {
        text = p.ctx.readFile(resolve(path));
      } catch {
        throw new CliError(`Hanko: no config.yaml at ${path}. Pass --set hanko-config=<path>. (Hanko Cloud has no file to read: the guide lists the console settings to copy.)`);
      }
      return translateHankoConfig(await vendorStep('Hanko', async () => settingsFromYaml(text, path, apiUrl(p))));
    },
  },
  export: {
    reads: 'a dump of the Hanko database (psql \\copy of users, emails, password_credentials, webauthn_credentials, otp_secrets, identities, …) or the Hanko Admin API',
    credentials: [DUMP, ADMIN_URL, API_KEY, API_URL, RP_ID, TENANT],
    limits: [
      'The Admin API never returns password hashes or TOTP secrets: dump the database to move them. Hanko Cloud: emails, profiles and passkeys by API, passwords by lazy migration, and TOTP users enrol again.',
      'Passkeys and security keys move only with the relying-party id they were registered for (--set hanko-rp-id=example.com) and only work while Atlas serves sign-in on that domain.',
      'Password hashes Atlas cannot verify (Firebase scrypt with a parallelism other than 1) move by lazy migration.',
      'Live sessions are not exported: a Hanko session is a signed JWT, which the bridge accepts as it is.',
      'Multi-tenant Hanko: one tenant per export (--set hanko-tenant-id=<id>).',
    ],
    async run(p, writer, resume) {
      const dump = p.credential(DUMP);
      const admin = p.credential(ADMIN_URL);
      if (!dump && !admin) {
        throw new CliError('Hanko: pass a folder of database dumps (--set hanko-dump=<folder>), or the Admin API URL (--set hanko-admin-url=<url>) for an export without password hashes.');
      }
      const set = await vendorStep('Hanko', async () =>
        dump
          ? exportHankoTables(readDumpDir(resolve(dump)), { rpId: p.credential(RP_ID), tenantId: p.credential(TENANT) })
          : exportHankoApi({ adminUrl: admin!, apiKey: p.credential(API_KEY), apiUrl: apiUrl(p), rpId: p.credential(RP_ID), fetchImpl: p.fetch, onProgress: (m) => p.say(`  reading ${m}`) }),
      );
      await writeRecordSet(set, writer, resume, p.say);
    },
  },
  bridge: {
    preset: 'hanko',
    presetFor(p, t) {
      return p.credential(ISSUER) || t?.bridge?.preset === 'hanko_jwt' ? 'hanko_jwt' : 'hanko';
    },
    vars(p, t) {
      const vars: Record<string, string> = { ...t?.bridge?.vars };
      const url = apiUrl(p);
      if (url) vars.base_url = url;
      const issuer = p.credential(ISSUER);
      if (issuer) vars.issuer = issuer.trim().replace(/\/+$/, '');
      return vars;
    },
  },
  lazy: {
    preset: 'hanko',
    config(p, t) {
      const config: Record<string, string> = { ...t?.lazy?.config };
      const url = apiUrl(p);
      if (url) config.base_url = url;
      return config;
    },
  },
  codemod: 'hanko',
};
