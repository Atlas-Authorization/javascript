import { resolve } from 'node:path';
import { CliError } from '../../errors';
import { exportFusionAuth, fusionAuthBase, fusionAuthHttp } from '../export/fusionauth';
import { fetchFusionAuthConfig, translateFusionAuthConfig } from '../export/fusionauth-config';
import { readDumpDir } from '../export/frameworks/tables';
import { vendorStep, writeRecordSet } from '../export/plugin-kit';
import type { CredentialSpec, MigrationPlugin, PluginContext } from '../framework/plugin';

/**
 * `atlas migrate fusionauth` — a FusionAuth tenant (self-hosted or FusionAuth
 * Cloud): password rules, MFA policy, token lifetimes, applications' redirect
 * URLs and roles, and identity providers as Atlas config; users with
 * registrations, roles, groups, linked identities, SAML / OIDC providers as SSO
 * connections, recovery codes and API keys through the API, and, from a database
 * dump of a self-hosted install, password hashes and authenticator secrets; the
 * `fusionauth` bridge preset for access tokens; lazy migration through
 * `/api/login`; and the code. Your API key stays on this machine.
 */

const URL_SPEC: CredentialSpec = { flag: '--fusionauth-url', env: 'FUSIONAUTH_URL', label: 'your FusionAuth URL (https://auth.example.com or https://acme.fusionauth.io)', required: false };
const API_KEY: CredentialSpec = { flag: '--fusionauth-api-key', env: 'FUSIONAUTH_API_KEY', label: 'a FusionAuth API key (read-only on the user, group, application, tenant and identity-provider endpoints)', required: false, secret: true };
const TENANT: CredentialSpec = { flag: '--fusionauth-tenant-id', env: 'FUSIONAUTH_TENANT_ID', label: 'the tenant id (several tenants and an API key that is not tenant-locked)', required: false };
const DUMP: CredentialSpec = { flag: '--fusionauth-dump', env: 'FUSIONAUTH_DUMP_DIR', label: 'a folder of database table dumps (users.csv, identities.csv, user_registrations.csv, …)', required: false };
const APP_ID: CredentialSpec = { flag: '--fusionauth-application-id', env: 'FUSIONAUTH_APPLICATION_ID', label: 'the application id (lazy migration signs in to it)', required: false };
const GROUPS_AS: CredentialSpec = { flag: '--groups-as', env: 'ATLAS_MIGRATE_GROUPS_AS', label: 'how groups move: organizations (default), roles or skip', required: false };
const TENANTS_AS: CredentialSpec = { flag: '--tenants-as', env: 'ATLAS_MIGRATE_TENANTS_AS', label: 'with several tenants: organizations (default) or skip', required: false };

function groupsAs(p: PluginContext): 'organizations' | 'roles' | 'skip' {
  const raw = p.credential(GROUPS_AS) ?? 'organizations';
  if (raw !== 'organizations' && raw !== 'roles' && raw !== 'skip') throw new CliError(`FusionAuth: --groups-as must be organizations, roles or skip (got ${raw}).`);
  return raw;
}

function tenantsAs(p: PluginContext): 'organizations' | 'skip' | undefined {
  const raw = p.credential(TENANTS_AS);
  if (raw === undefined) return undefined;
  if (raw !== 'organizations' && raw !== 'skip') throw new CliError(`FusionAuth: --tenants-as must be organizations or skip (got ${raw}).`);
  return raw;
}

function api(p: PluginContext) {
  const url = p.credential({ ...URL_SPEC, required: true })!;
  const apiKey = p.credential({ ...API_KEY, required: true })!;
  return { baseUrl: fusionAuthBase(url), apiKey, tenantId: p.credential(TENANT), fetchImpl: p.fetch, onProgress: (m: string) => p.say(`  reading ${m}`) };
}

export const fusionauthPlugin: MigrationPlugin = {
  vendor: 'fusionauth',
  source: 'fusionauth',
  label: 'FusionAuth',
  help: 'Move a FusionAuth tenant: password rules, MFA policy, token lifetimes, redirect URLs, application roles and identity providers as Atlas config; users with registrations, roles, groups or tenants as organizations, linked social and SAML / OIDC identities, SSO connections, recovery codes and API keys through the API, and, from a database dump of a self-hosted install, password hashes and authenticator secrets; a zero-logout bridge on your tenant\'s access tokens; lazy migration through the login API; and the code. Your API key stays on this machine.',
  config: {
    reads: 'your tenant via the FusionAuth API (tenants, applications, identity providers, lambdas, webhooks)',
    credentials: [URL_SPEC, API_KEY, TENANT],
    async translate(p) {
      const a = api(p);
      const http = fusionAuthHttp(a);
      const snap = await vendorStep('FusionAuth', () => fetchFusionAuthConfig(http, a.baseUrl, (m) => p.say(`  ${m}`)));
      return translateFusionAuthConfig(snap, { tenantId: a.tenantId });
    },
  },
  export: {
    reads: 'the FusionAuth API, or a database dump of a self-hosted install',
    credentials: [URL_SPEC, API_KEY, TENANT, DUMP],
    limits: [
      'The API never returns password hashes or authenticator-app secrets. A self-hosted install can dump its database (users, identities, user_registrations, twofactor_methods, … as CSV or JSON, one file per table) and pass the folder with --set fusionauth-dump=<folder>; FusionAuth Cloud has no database access: ask FusionAuth support for the export, or use lazy migration (the fusionauth preset).',
      'Custom password-hashing plugins (an encryption scheme that is not one of FusionAuth\'s built-ins) cannot be verified: those users move by lazy migration or reset their password.',
      'WebAuthn credentials are not exported: users register passkeys again.',
      'Entities, entity grants, consents, lambdas, themes and webhooks are not migrated (the config report lists them).',
      'FusionAuth sessions are not exportable: the bridge exchanges FusionAuth access tokens for Atlas sessions.',
    ],
    async run(p, writer, resume) {
      const dump = p.credential(DUMP);
      const haveApi = !!(p.credential(URL_SPEC) && p.credential(API_KEY));
      if (!dump && !haveApi) throw new CliError('FusionAuth: pass a database dump (--set fusionauth-dump=<folder>), or the URL and an API key (--set fusionauth-url=… and FUSIONAUTH_API_KEY).');
      const set = await vendorStep('FusionAuth', () =>
        exportFusionAuth({ tables: dump ? readDumpDir(resolve(dump)) : undefined, api: haveApi ? api(p) : undefined, groupsAs: groupsAs(p), tenantsAs: tenantsAs(p) }),
      );
      await writeRecordSet(set, writer, resume, p.say);
    },
  },
  bridge: {
    preset: 'fusionauth',
    vars(p, t) {
      const vars: Record<string, string> = { ...t?.bridge?.vars };
      const url = p.credential(URL_SPEC);
      if (url) vars.base_url = fusionAuthBase(url);
      return vars;
    },
  },
  lazy: {
    preset: 'fusionauth',
    config(p, t) {
      const config: Record<string, string> = { ...t?.lazy?.config };
      const url = p.credential(URL_SPEC);
      if (url) config.base_url = fusionAuthBase(url);
      const app = p.credential(APP_ID);
      if (app) config.application_id = app;
      const tenant = p.credential(TENANT);
      if (tenant) config.tenant_id = tenant;
      return config;
    },
    secret: { ...API_KEY, label: 'an API key allowed to POST /api/login', required: true },
  },
  codemod: 'fusionauth',
};
