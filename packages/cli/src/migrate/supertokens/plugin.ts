import { resolve } from 'node:path';
import { CliError } from '../../errors';
import { readDumpDir } from '../export/frameworks/tables';
import { vendorStep, writeRecordSet } from '../export/plugin-kit';
import { exportSupertokens, normalizeCoreUri, supertokensHttp } from '../export/supertokens';
import { fetchSupertokensConfig, translateSupertokensConfig } from '../export/supertokens-config';
import type { CredentialSpec, MigrationPlugin, PluginContext } from '../framework/plugin';

/**
 * `atlas migrate supertokens` — a SuperTokens core (self-hosted or the managed
 * service): the core's recipes, providers and token settings as Atlas config;
 * users with their linked login methods, verified emails, third-party links,
 * metadata, roles and tenants through the core API with its API key (on this
 * machine) or from a dump of the core database, which also carries bcrypt /
 * Argon2 password hashes and TOTP secrets; the `supertokens` bridge preset (the
 * session's access token verified against your backend's JWKS); lazy migration
 * through the core's own sign-in; and the code.
 */

const CONNECTION_URI: CredentialSpec = { flag: '--supertokens-connection-uri', env: 'SUPERTOKENS_CONNECTION_URI', label: 'the core address (https://st-dev-xxxx.aws.supertokens.io, or http://localhost:3567)', required: false };
const API_KEY: CredentialSpec = { flag: '--supertokens-api-key', env: 'SUPERTOKENS_API_KEY', label: 'the core API key', required: false, secret: true };
const DUMP: CredentialSpec = { flag: '--supertokens-dump', env: 'SUPERTOKENS_DUMP_DIR', label: 'a folder of core database table dumps (all_auth_recipe_users.csv, emailpassword_users.csv, …)', required: false };
const APP_ID: CredentialSpec = { flag: '--supertokens-app-id', env: 'SUPERTOKENS_APP_ID', label: 'the SuperTokens app id (multi-app cores; default public)', required: false };
const TENANT_ID: CredentialSpec = { flag: '--supertokens-tenant-id', env: 'SUPERTOKENS_TENANT_ID', label: 'the tenant the lazy-migration sign-in runs on (default public)', required: false };
const PREFIX: CredentialSpec = { flag: '--supertokens-table-prefix', env: 'SUPERTOKENS_TABLE_PREFIX', label: 'the core\'s table_names_prefix, when it has one', required: false };
const API_DOMAIN: CredentialSpec = { flag: '--supertokens-api-domain', env: 'SUPERTOKENS_API_DOMAIN', label: 'your backend\'s apiDomain (https://api.example.com), the issuer of your access tokens', required: false };
const API_BASE_PATH: CredentialSpec = { flag: '--supertokens-api-base-path', env: 'SUPERTOKENS_API_BASE_PATH', label: 'your backend\'s apiBasePath without slashes (default auth)', required: false };

function coreUri(p: PluginContext, required: boolean): string | undefined {
  const raw = p.credential({ ...CONNECTION_URI, required });
  if (!raw) return undefined;
  try {
    return normalizeCoreUri(raw);
  } catch {
    throw new CliError(`SuperTokens: ${raw} is not a core address (https://host or http://host:3567).`);
  }
}

export const supertokensPlugin: MigrationPlugin = {
  vendor: 'supertokens',
  source: 'supertokens',
  label: 'SuperTokens',
  help: 'Move a SuperTokens core (self-hosted or managed): its recipes, third-party providers and token settings as Atlas config; users with linked login methods, verified emails, third-party links, metadata, roles and tenants through the core API with its API key (on this machine) or from a dump of the core database, which also carries bcrypt and Argon2 password hashes and TOTP secrets; a zero-logout bridge on your access tokens; lazy migration through the core\'s own sign-in; and the code.',
  config: {
    reads: 'your SuperTokens core via its HTTP API',
    credentials: [CONNECTION_URI, API_KEY, APP_ID],
    async translate(p) {
      const uri = coreUri(p, true)!;
      const appId = p.credential(APP_ID)?.trim() || 'public';
      const http = supertokensHttp({ connectionUri: uri, apiKey: p.credential(API_KEY), fetchImpl: p.fetch });
      return translateSupertokensConfig(await vendorStep('SuperTokens', () => fetchSupertokensConfig(http, uri, appId)));
    },
  },
  export: {
    reads: 'the SuperTokens core API (API key) or a dump of the core database',
    credentials: [CONNECTION_URI, API_KEY, DUMP, APP_ID, PREFIX],
    limits: [
      'The core API never returns password hashes or TOTP secrets: export from the core database (--set supertokens-dump=<folder>) to carry bcrypt and Argon2 hashes and verified TOTP devices; the managed service has no database access, so those users move by lazy migration and enrol their authenticator app again.',
      'Sessions are not exported: the core keeps only a double hash of each refresh token. The bridge exchanges the access-token JWT a user still holds, verified against your backend\'s JWKS.',
      'A password hash that is not bcrypt or Argon2 (for example one imported from Firebase) cannot be verified by Atlas: those users reset their password or move by lazy migration.',
      'Tenants become organizations; a tenant\'s own enabled recipes and providers do not carry over (configure SSO connections per organization).',
      'Code in supertokens.init (override functions, custom claims, MFA requirements, email and SMS delivery) is not visible to the core: it is listed in the config report as manual.',
    ],
    async run(p, writer, resume) {
      const dumpDir = p.credential(DUMP);
      const uri = coreUri(p, false);
      if (!dumpDir && !uri) {
        throw new CliError('SuperTokens: pass a core database dump (--set supertokens-dump=<folder>), or the core address with its API key (--set supertokens-connection-uri=… and SUPERTOKENS_API_KEY).');
      }
      const set = await vendorStep('SuperTokens', async () =>
        exportSupertokens({
          tables: dumpDir ? readDumpDir(resolve(dumpDir)) : undefined,
          connectionUri: uri,
          apiKey: p.credential(API_KEY),
          appId: p.credential(APP_ID)?.trim(),
          tablePrefix: p.credential(PREFIX)?.trim(),
          fetchImpl: p.fetch,
          onProgress: (m) => p.say(`  reading ${m}`),
        }),
      );
      await writeRecordSet(set, writer, resume, p.say);
    },
  },
  bridge: {
    preset: 'supertokens',
    vars(p, t) {
      const vars: Record<string, string> = { ...t?.bridge?.vars };
      const domain = p.credential(API_DOMAIN)?.trim();
      if (domain) vars.base_url = domain;
      const basePath = p.credential(API_BASE_PATH)?.trim().replace(/^\/+|\/+$/g, '');
      if (basePath) vars.api_base_path = basePath;
      return vars;
    },
  },
  lazy: {
    preset: 'supertokens',
    config(p, t) {
      const config: Record<string, string> = { ...t?.lazy?.config };
      const uri = coreUri(p, false);
      if (uri) config.base_url = uri;
      const tenant = p.credential(TENANT_ID)?.trim();
      if (tenant) config.tenant_id = tenant;
      const app = p.credential(APP_ID)?.trim();
      if (app) config.app_id = app;
      return config;
    },
    secret: API_KEY,
  },
  codemod: 'supertokens',
};
