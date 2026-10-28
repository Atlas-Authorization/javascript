import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CliError } from '../../errors';
import { exportKeycloak, keycloakAdminHttp, keycloakBase, readKeycloakExport } from '../export/keycloak';
import { fetchKeycloakConfig, translateKeycloakConfig } from '../export/keycloak-config';
import { vendorStep, writeRecordSet } from '../export/plugin-kit';
import type { CredentialSpec, MigrationPlugin, PluginContext } from '../framework/plugin';

/**
 * `atlas migrate keycloak` — a Keycloak (or Red Hat build of Keycloak) realm:
 * its settings as Atlas config (Admin API or a realm export); users with their
 * federated identities, roles, groups, organizations, SSO brokers, TOTP,
 * recovery codes and passkeys from a REALM EXPORT (`kc.sh export`, the only
 * path that carries password hashes and OTP secrets) or the Admin API (no
 * secrets); the `keycloak` bridge preset for access / ID tokens; lazy migration
 * through the password grant; and the code. Your admin credentials stay on this machine.
 */

const URL_SPEC: CredentialSpec = { flag: '--keycloak-url', env: 'KEYCLOAK_URL', label: 'your Keycloak base URL (https://sso.example.com; with /auth on Keycloak 16 and older)', required: false };
const REALM: CredentialSpec = { flag: '--keycloak-realm', env: 'KEYCLOAK_REALM', label: 'the realm to move', required: false };
const CLIENT_ID: CredentialSpec = { flag: '--keycloak-client-id', env: 'KEYCLOAK_CLIENT_ID', label: 'an admin client (service account with view-users, view-realm, query-users, view-clients) or the client of an admin user (default admin-cli)', required: false };
const CLIENT_SECRET: CredentialSpec = { flag: '--keycloak-client-secret', env: 'KEYCLOAK_CLIENT_SECRET', label: 'that client\'s secret', required: false, secret: true };
const ADMIN_USER: CredentialSpec = { flag: '--keycloak-admin-user', env: 'KEYCLOAK_ADMIN_USER', label: 'an admin user (alternative to a client)', required: false };
const ADMIN_PASSWORD: CredentialSpec = { flag: '--keycloak-admin-password', env: 'KEYCLOAK_ADMIN_PASSWORD', label: 'that admin user\'s password', required: false, secret: true };
const AUTH_REALM: CredentialSpec = { flag: '--keycloak-auth-realm', env: 'KEYCLOAK_AUTH_REALM', label: 'the realm the admin credential lives in (default master for a user, the realm for a client)', required: false };
const EXPORT_FILE: CredentialSpec = { flag: '--keycloak-export', env: 'KEYCLOAK_EXPORT', label: 'a realm export: the file or folder `kc.sh export` wrote', required: false };
const RP_ID: CredentialSpec = { flag: '--keycloak-rp-id', env: 'KEYCLOAK_RP_ID', label: 'the WebAuthn relying-party id when the realm leaves it empty', required: false };
const GROUPS_AS: CredentialSpec = { flag: '--groups-as', env: 'ATLAS_MIGRATE_GROUPS_AS', label: 'how groups move: roles, organizations or skip', required: false };
const LAZY_CLIENT: CredentialSpec = { flag: '--keycloak-lazy-client-id', env: 'KEYCLOAK_LAZY_CLIENT_ID', label: 'a client with Direct access grants enabled (lazy migration)', required: false };

function groupsAs(p: PluginContext): 'roles' | 'organizations' | 'skip' {
  const raw = p.credential(GROUPS_AS) ?? 'roles';
  if (raw !== 'roles' && raw !== 'organizations' && raw !== 'skip') throw new CliError(`Keycloak: --groups-as must be roles, organizations or skip (got ${raw}).`);
  return raw;
}

function baseUrl(p: PluginContext, required: boolean): string | undefined {
  const raw = p.credential({ ...URL_SPEC, required });
  return raw ? keycloakBase(raw) : undefined;
}

function adminApi(p: PluginContext, realm: string) {
  const url = baseUrl(p, true)!;
  const username = p.credential(ADMIN_USER);
  const password = p.credential(ADMIN_PASSWORD);
  const clientId = p.credential(CLIENT_ID);
  const clientSecret = p.credential(CLIENT_SECRET);
  if (!(username && password) && !(clientId && clientSecret)) {
    throw new CliError('Keycloak: pass an admin client (--set keycloak-client-id=… and KEYCLOAK_CLIENT_SECRET) or an admin user (--set keycloak-admin-user=… and KEYCLOAK_ADMIN_PASSWORD).');
  }
  return { baseUrl: url, realm, clientId, clientSecret, username, password, authRealm: p.credential(AUTH_REALM), fetchImpl: p.fetch };
}

/** The JSON documents of a realm export: one file, or every .json in a folder. */
function readExportDocs(p: PluginContext, path: string): unknown[] {
  const abs = resolve(path);
  let files: string[];
  try {
    files = statSync(abs).isDirectory() ? readdirSync(abs).filter((f) => f.endsWith('.json')).sort().map((f) => join(abs, f)) : [abs];
  } catch (err) {
    throw new CliError(`Keycloak: could not read the realm export at ${path}: ${(err as Error).message}`);
  }
  if (!files.length) throw new CliError(`Keycloak: no .json files in ${path}.`);
  return files.map((f) => {
    try {
      return JSON.parse(p.ctx.readFile(f)) as unknown;
    } catch (err) {
      throw new CliError(`Keycloak: ${f} is not valid JSON: ${(err as Error).message}`);
    }
  });
}

export const keycloakPlugin: MigrationPlugin = {
  vendor: 'keycloak',
  source: 'keycloak',
  label: 'Keycloak',
  help: 'Move a Keycloak realm: its settings (password policy, sessions, OTP and WebAuthn, brokers, clients\' redirect URIs, roles) as Atlas config; users with identities, roles, groups or organizations, SAML and OIDC brokers as SSO connections, and, from a realm export, password hashes (PBKDF2, Argon2), TOTP secrets, recovery codes and passkeys; a zero-logout bridge on your realm\'s tokens; lazy migration through the password grant; and the code. Admin credentials stay on this machine.',
  config: {
    reads: 'your realm via the Admin REST API, or a realm export',
    credentials: [URL_SPEC, REALM, CLIENT_ID, CLIENT_SECRET, ADMIN_USER, ADMIN_PASSWORD, AUTH_REALM, EXPORT_FILE],
    async translate(p) {
      const file = p.credential(EXPORT_FILE);
      if (file) {
        const snap = readKeycloakExport(readExportDocs(p, file), p.credential(REALM));
        return translateKeycloakConfig(snap.realm, { groupsAs: groupsAs(p), baseUrl: baseUrl(p, false) });
      }
      const realm = p.credential({ ...REALM, required: true })!;
      const http = keycloakAdminHttp(adminApi(p, realm));
      const doc = await vendorStep('Keycloak', () => fetchKeycloakConfig(http, realm, baseUrl(p, true)));
      return translateKeycloakConfig(doc, { groupsAs: groupsAs(p), baseUrl: baseUrl(p, true) });
    },
  },
  export: {
    reads: 'a realm export (kc.sh export) or the Keycloak Admin REST API',
    credentials: [EXPORT_FILE, URL_SPEC, REALM, CLIENT_ID, CLIENT_SECRET, ADMIN_USER, ADMIN_PASSWORD, AUTH_REALM, RP_ID],
    limits: [
      'Only a realm export carries password hashes (PBKDF2-SHA1/256/512, Argon2), OTP secrets and recovery-code hashes: run `kc.sh export --realm <realm> --file realm.json --users realm_file` (or `--dir`) and pass it with --set keycloak-export=<path>. The Admin API strips every secret.',
      'With the Admin API alone, passwords move by lazy migration (the keycloak preset) and authenticator-app users enrol again; WebAuthn public keys DO come back.',
      'Users of an LDAP / Kerberos user-storage provider have no password in Keycloak: lazy migration lets Keycloak (and the directory) verify them. Users of a provider without local import are not exported.',
      'Identity-provider and client secrets are masked by the Admin API (a realm export keeps them unless they live in a vault): enter them on the SSO connection.',
      'Live sessions are not exportable: the bridge exchanges Keycloak access and ID tokens for Atlas sessions.',
      'Composite roles import as plain roles; fine-grained authorization services are not migrated.',
    ],
    async run(p, writer, resume) {
      const file = p.credential(EXPORT_FILE);
      const realm = p.credential(REALM);
      const common = { realm, groupsAs: groupsAs(p), rpId: p.credential(RP_ID), onProgress: (m: string) => p.say(`  reading ${m}`) };
      if (!file && !(baseUrl(p, false) && realm)) {
        throw new CliError('Keycloak: pass a realm export (--set keycloak-export=<path>), or the base URL and realm with an admin credential (--set keycloak-url=… --set keycloak-realm=…).');
      }
      const set = await vendorStep('Keycloak', async () =>
        file
          ? exportKeycloak({ ...common, exportDocs: readExportDocs(p, file), api: baseUrl(p, false) ? { baseUrl: baseUrl(p, false)!, clientId: undefined } : undefined })
          : exportKeycloak({ ...common, api: adminApi(p, realm!) }),
      );
      await writeRecordSet(set, writer, resume, p.say);
    },
  },
  bridge: {
    preset: 'keycloak',
    vars(p, t) {
      const vars: Record<string, string> = { ...t?.bridge?.vars };
      const url = baseUrl(p, false);
      if (url) vars.base_url = url;
      const realm = p.credential(REALM);
      if (realm) vars.realm = realm;
      return vars;
    },
  },
  lazy: {
    preset: 'keycloak',
    config(p, t) {
      const config: Record<string, string> = { ...t?.lazy?.config };
      const url = baseUrl(p, false);
      if (url) config.base_url = url;
      const realm = p.credential(REALM);
      if (realm) config.realm = realm;
      const client = p.credential(LAZY_CLIENT) ?? p.credential(CLIENT_ID);
      if (client) config.client_id = client;
      return config;
    },
    secret: { flag: '--keycloak-lazy-client-secret', env: 'KEYCLOAK_LAZY_CLIENT_SECRET', label: 'the secret of that client (confidential clients only)', required: false, secret: true },
  },
  codemod: 'keycloak',
};
