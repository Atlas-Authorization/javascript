import { resolve } from 'node:path';
import { CliError } from '../../errors';
import { exportLogto, logtoManagementHttp, normalizeEndpoint, tenantOfEndpoint } from '../export/logto';
import { fetchLogtoConfig, translateLogtoConfig } from '../export/logto-config';
import { readDumpDir } from '../export/frameworks/tables';
import { vendorStep, writeRecordSet } from '../export/plugin-kit';
import type { CredentialSpec, MigrationPlugin, PluginContext } from '../framework/plugin';

/**
 * `atlas migrate logto` — a Logto tenant (self-hosted or Logto Cloud): the
 * sign-in experience, connectors, applications, API resources and roles as
 * Atlas config; users, social and enterprise identities, organizations,
 * roles, invitations and personal access tokens through the Management API
 * (a machine-to-machine app on this machine) or from a database dump of a
 * self-hosted Logto, which also carries password hashes, TOTP secrets,
 * passkeys and backup codes; the `logto` bridge preset (an ID token verified
 * against the tenant's `/oidc/jwks`); lazy migration through the Management
 * API's password check; and the code.
 */

const ENDPOINT: CredentialSpec = { flag: '--logto-endpoint', env: 'LOGTO_ENDPOINT', label: 'your Logto endpoint (https://auth.example.com or https://abc123.logto.app)', required: false };
const TENANT: CredentialSpec = { flag: '--logto-tenant-id', env: 'LOGTO_TENANT_ID', label: 'the tenant id (default on a self-hosted Logto; the abc123 of abc123.logto.app on Logto Cloud)', required: false };
const APP_ID: CredentialSpec = { flag: '--logto-m2m-app-id', env: 'LOGTO_M2M_APP_ID', label: 'the id of a machine-to-machine app with the Management API role', required: false };
const APP_SECRET: CredentialSpec = { flag: '--logto-m2m-app-secret', env: 'LOGTO_M2M_APP_SECRET', label: 'that app\'s secret', required: false, secret: true };
const DUMP: CredentialSpec = { flag: '--logto-dump', env: 'LOGTO_DUMP_DIR', label: 'a folder of database table dumps (users.csv, roles.csv, organizations.csv, …)', required: false };
const CLIENT_ID: CredentialSpec = { flag: '--logto-client-id', env: 'LOGTO_APP_ID', label: 'the id of your Logto application (the audience of its ID tokens)', required: false };
const PATS: CredentialSpec = { flag: '--logto-personal-access-tokens', env: 'LOGTO_PERSONAL_ACCESS_TOKENS', label: 'true, to read each user\'s personal access tokens too (one API call per user)', required: false };
const RP_ID: CredentialSpec = { flag: '--rp-id', env: 'ATLAS_MIGRATE_RP_ID', label: 'the WebAuthn relying party id passkeys were registered for', required: false };

function endpointOf(p: PluginContext, required: boolean): string | undefined {
  const raw = p.credential({ ...ENDPOINT, required });
  if (!raw) return undefined;
  try {
    return normalizeEndpoint(raw);
  } catch (err) {
    throw new CliError(`Logto: ${(err as Error).message}`);
  }
}

function m2m(p: PluginContext): { appId: string; appSecret: string } | undefined {
  const appId = p.credential(APP_ID);
  const appSecret = p.credential(APP_SECRET);
  return appId && appSecret ? { appId, appSecret } : undefined;
}

function tenantOf(p: PluginContext, endpoint: string | undefined): string {
  return p.credential(TENANT)?.trim() ?? (endpoint ? tenantOfEndpoint(endpoint) : null) ?? 'default';
}

export const logtoPlugin: MigrationPlugin = {
  vendor: 'logto',
  source: 'logto',
  label: 'Logto',
  help: 'Move a Logto tenant (self-hosted or Logto Cloud): its sign-in experience, connectors, applications, API resources and roles as Atlas config; users, social and enterprise identities, organizations, roles, invitations and personal access tokens through the Management API with a machine-to-machine app (on this machine) or from a database dump, which also carries password hashes, TOTP secrets, passkeys and backup codes; a zero-logout bridge on the tenant\'s ID tokens; lazy migration for passwords you cannot export; and the code.',
  config: {
    reads: 'your Logto tenant via the Management API',
    credentials: [ENDPOINT, TENANT, APP_ID, APP_SECRET],
    async translate(p) {
      const endpoint = endpointOf(p, true)!;
      const credentials = m2m(p);
      if (!credentials) throw new CliError('Logto: pass the machine-to-machine app id and secret (--set logto-m2m-app-id=… --set logto-m2m-app-secret=…, or LOGTO_M2M_APP_ID / LOGTO_M2M_APP_SECRET).');
      const tenantId = tenantOf(p, endpoint);
      const http = logtoManagementHttp({ endpoint, m2m: credentials, tenantId, fetchImpl: p.fetch });
      return translateLogtoConfig(await vendorStep('Logto', () => fetchLogtoConfig(http, endpoint, tenantId)));
    },
  },
  export: {
    reads: 'the Logto Management API (machine-to-machine app) or a database dump of a self-hosted Logto',
    credentials: [ENDPOINT, TENANT, APP_ID, APP_SECRET, DUMP, RP_ID, PATS],
    limits: [
      'The Management API never returns MFA secrets (TOTP keys, WebAuthn credentials, backup codes): those users enrol again, unless you export from the database of a self-hosted Logto (--set logto-dump=<folder>).',
      'The Management API does not reliably return password hashes: a database dump of a self-hosted Logto carries them (Argon2, bcrypt, SHA-family and legacy expressions). Logto Cloud tenants, and every user without a hash, move by lazy migration (the logto preset).',
      'Passkeys move only with the relying-party id they were registered for (--set rp-id=…, or the endpoint host): your Atlas domain must match it.',
      'Machine-to-machine apps and their secrets are not exported: create Atlas M2M clients.',
      'Logto sessions are encrypted cookies of your app\'s SDK: the bridge exchanges the ID token inside them (see the guide for the extractor).',
      'Personal access tokens come over the API one call per user: add --set logto-personal-access-tokens=true.',
    ],
    async run(p, writer, resume) {
      const dumpDir = p.credential(DUMP);
      const endpoint = endpointOf(p, false);
      const credentials = m2m(p);
      if (!dumpDir && !(endpoint && credentials)) {
        throw new CliError('Logto: pass a database dump (--set logto-dump=<folder>), or the endpoint with a machine-to-machine app (--set logto-endpoint=… plus LOGTO_M2M_APP_ID and LOGTO_M2M_APP_SECRET).');
      }
      const set = await vendorStep('Logto', async () =>
        exportLogto({
          tables: dumpDir ? readDumpDir(resolve(dumpDir)) : undefined,
          endpoint,
          m2m: credentials,
          tenantId: p.credential(TENANT)?.trim(),
          rpId: p.credential(RP_ID)?.trim(),
          personalAccessTokens: /^(1|true|yes)$/i.test(p.credential(PATS)?.trim() ?? ''),
          fetchImpl: p.fetch,
          onProgress: (m) => p.say(`  reading ${m}`),
        }),
      );
      await writeRecordSet(set, writer, resume, p.say);
    },
  },
  bridge: {
    preset: 'logto',
    vars(p, t) {
      const vars: Record<string, string> = { ...t?.bridge?.vars };
      const endpoint = endpointOf(p, false);
      if (endpoint) vars.base_url = endpoint;
      const clientId = p.credential(CLIENT_ID);
      if (clientId) vars.client_id = clientId;
      return vars;
    },
  },
  lazy: {
    preset: 'logto',
    config(p, t) {
      const config: Record<string, string> = { ...t?.lazy?.config };
      const endpoint = endpointOf(p, false);
      if (endpoint) config.base_url = endpoint;
      const appId = p.credential(APP_ID);
      if (appId) config.app_id = appId;
      const tenant = p.credential(TENANT)?.trim();
      if (tenant) config.tenant_id = tenant;
      else if (endpoint && tenantOfEndpoint(endpoint)) config.tenant_id = tenantOfEndpoint(endpoint)!;
      return config;
    },
    secret: APP_SECRET,
  },
  codemod: 'logto',
};
