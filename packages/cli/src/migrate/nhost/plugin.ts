import { exportNhost, fetchNhostRows, nhostGraphqlUrl, readNhostDump, type NhostRows } from '../export/nhost';
import { translateNhostConfig } from '../export/nhost-config';
import { CliError } from '../../errors';
import type { CredentialSpec, MigrationPlugin, PluginContext } from '../framework/plugin';
import { vendorStep, writeRecordSet } from '../export/plugin-kit';
import { projectDir, projectFile } from '../export/project-files';

/**
 * `atlas migrate nhost` — an Nhost project (Nhost Cloud or self-hosted Hasura
 * Auth): `nhost/nhost.toml` as Atlas config; users with their bcrypt hashes,
 * social links, security keys, roles, TOTP secrets and live refresh tokens
 * read through the project's GraphQL endpoint with the admin secret (on this
 * machine only) or from a dump of the `auth` schema; the `nhost` bridge preset
 * (a refresh token becomes an Atlas session, matched on the hash Nhost
 * stores); lazy migration for anyone left; and the code.
 */

const SUBDOMAIN: CredentialSpec = { flag: '--nhost-subdomain', env: 'NHOST_SUBDOMAIN', label: 'the Nhost Cloud project subdomain', required: false };
const REGION: CredentialSpec = { flag: '--nhost-region', env: 'NHOST_REGION', label: 'the Nhost Cloud region (eu-central-1, us-east-1, …)', required: false };
const GRAPHQL_URL: CredentialSpec = { flag: '--nhost-graphql-url', env: 'NHOST_GRAPHQL_URL', label: 'the GraphQL endpoint of a self-hosted project (https://graphql.example.com/v1)', required: false };
const AUTH_URL: CredentialSpec = { flag: '--nhost-auth-url', env: 'NHOST_AUTH_URL', label: 'the Auth URL of a self-hosted project (https://auth.example.com/v1), for lazy migration', required: false };
const ADMIN_SECRET: CredentialSpec = { flag: '--nhost-admin-secret', env: 'NHOST_ADMIN_SECRET', label: 'the Hasura admin secret', required: false, secret: true };
const DUMP: CredentialSpec = { flag: '--nhost-dump', env: 'NHOST_DUMP_DIR', label: 'a folder of auth-schema table dumps (users.csv, user_providers.csv, …)', required: false };
const CONFIG_FILE: CredentialSpec = { flag: '--nhost-config', env: 'NHOST_CONFIG_TOML', label: 'nhost/nhost.toml', required: false };
const ENCRYPTION_KEY: CredentialSpec = { flag: '--nhost-encryption-key', env: 'AUTH_ENCRYPTION_KEY', label: 'AUTH_ENCRYPTION_KEY (64 hex characters), to carry encrypted TOTP secrets', required: false, secret: true };
const BRIDGE: CredentialSpec = { flag: '--nhost-bridge', env: 'NHOST_BRIDGE', label: 'what the bridge exchanges: refresh-token (default; the sessions the export imported) or access-token (JWTs signed by Hasura Auth)', required: false };
const RP_ID: CredentialSpec = { flag: '--rp-id', env: 'ATLAS_MIGRATE_RP_ID', label: 'the WebAuthn relying party id security keys were registered for', required: false };

function cloud(p: PluginContext): { subdomain: string; region: string } | undefined {
  const subdomain = p.credential(SUBDOMAIN)?.trim();
  const region = p.credential(REGION)?.trim();
  return subdomain && region ? { subdomain, region } : undefined;
}

function authUrl(p: PluginContext): string | undefined {
  const url = p.credential(AUTH_URL)?.trim().replace(/\/+$/, '');
  if (url) return url;
  const c = cloud(p);
  return c ? `https://${c.subdomain}.auth.${c.region}.nhost.run/v1` : undefined;
}

async function readRows(p: PluginContext): Promise<{ rows: NhostRows; origin: string }> {
  const dump = projectDir(p, DUMP);
  if (dump) return { rows: await vendorStep('Nhost', async () => readNhostDump(dump)), origin: 'auth schema dump' };
  const c = cloud(p);
  const graphqlUrl = p.credential(GRAPHQL_URL)?.trim().replace(/\/+$/, '') ?? (c ? nhostGraphqlUrl(c) : undefined);
  const adminSecret = p.credential(ADMIN_SECRET);
  if (!graphqlUrl || !adminSecret) {
    throw new CliError('Nhost: pass --set nhost-subdomain=… --set nhost-region=… (or --set nhost-graphql-url=… when self-hosted) with --set nhost-admin-secret=…, or a dump of the auth schema with --set nhost-dump=<dir>.');
  }
  const rows = await vendorStep('Nhost', () => fetchNhostRows({ graphqlUrl, adminSecret, fetchImpl: p.fetch, onProgress: (m) => p.say(`  reading ${m}`) }));
  return { rows, origin: 'nhost graphql' };
}

export const nhostPlugin: MigrationPlugin = {
  vendor: 'nhost',
  source: 'nhost',
  label: 'Nhost',
  help: 'Move an Nhost project: nhost.toml auth settings as Atlas config; users with bcrypt hashes, verified email and phone, metadata, roles, social links, security keys, TOTP secrets and live refresh tokens through GraphQL with the admin secret (on this machine) or from an auth-schema dump; a zero-logout bridge on the refresh tokens Nhost already hashes; lazy migration for anyone left; and the code.',
  config: {
    reads: 'nhost/nhost.toml',
    credentials: [CONFIG_FILE, AUTH_URL, SUBDOMAIN, REGION],
    async translate(p) {
      const file = projectFile(p, CONFIG_FILE, ['nhost/nhost.toml', 'nhost.toml']);
      if (!file) throw new CliError('Nhost: no nhost/nhost.toml in this folder. Pass --set nhost-config=<path to nhost.toml>.');
      return translateNhostConfig(file, { authUrl: authUrl(p) });
    },
  },
  export: {
    reads: 'the auth schema through the project GraphQL endpoint (admin secret) or a table dump',
    credentials: [SUBDOMAIN, REGION, GRAPHQL_URL, ADMIN_SECRET, DUMP, ENCRYPTION_KEY, RP_ID],
    limits: [
      'Personal access tokens are not exported: reissue them as Atlas API keys.',
      'TOTP secrets on current Nhost versions are encrypted with AUTH_ENCRYPTION_KEY; without --set nhost-encryption-key those users enrol again.',
      'Security keys move only with the relying-party id they were registered for (--set rp-id=…, same domain on Atlas).',
      'Access tokens are short-lived JWTs and are not exported: the bridge exchanges the refresh token instead.',
    ],
    async run(p, writer, resume) {
      const { rows, origin } = await readRows(p);
      const set = exportNhost(rows, { encryptionKey: p.credential(ENCRYPTION_KEY), rpId: p.credential(RP_ID)?.trim(), origin });
      await writeRecordSet(set, writer, resume, p.say);
    },
  },
  bridge: {
    preset: 'nhost',
    presetFor(p) {
      const mode = (p.credential(BRIDGE) ?? 'refresh-token').trim().toLowerCase();
      if (mode === 'access-token') return 'nhost_jwt';
      if (mode !== 'refresh-token') throw new CliError(`Nhost: --set nhost-bridge takes refresh-token or access-token (got ${mode}).`);
      return 'nhost';
    },
    vars(p, t) {
      const vars: Record<string, string> = { ...t?.bridge?.vars };
      if (p.credential(BRIDGE)?.trim().toLowerCase() === 'access-token') {
        const url = authUrl(p);
        if (url) vars.auth_url = url;
      }
      return vars;
    },
  },
  lazy: {
    preset: 'nhost',
    config(p, t) {
      const config: Record<string, string> = { ...t?.lazy?.config };
      const url = authUrl(p);
      if (url) config.auth_url = url;
      return config;
    },
  },
  codemod: 'nhost',
};
