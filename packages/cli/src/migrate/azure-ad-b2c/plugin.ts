import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { exportAzure, graphHttp, type AzureKind } from '../export/azure';
import { fetchAzureConfig, translateAzureConfig, type AzureConfigSnapshot } from '../export/azure-config';
import { CliError } from '../../errors';
import { truthyCredential } from '../export/project-files';
import type { CredentialSpec, MigrationPlugin, PluginContext } from '../framework/plugin';
import { need, vendorStep, writeRecordSet } from '../export/plugin-kit';

/**
 * `atlas migrate azure-ad-b2c` and (through {@link azurePlugin})
 * `atlas migrate entra-external-id` — a Microsoft customer-identity tenant
 * through Microsoft Graph with an app registration the owner creates
 * (client credentials). Users keyed by their object id with sign-in
 * identities, federated links, custom attributes, groups and SMS / email
 * factors; identity providers, user flows, custom policies (B2C), app
 * registrations and groups as Atlas config; the JWT bridge preset; lazy
 * migration (B2C ROPC user flow, External ID native authentication) — Graph
 * never returns a password. The client secret is sent to Microsoft only.
 */

const TENANT: CredentialSpec = { flag: '--azure-tenant', env: 'AZURE_TENANT_ID', label: 'the tenant id (GUID) or domain (contoso.onmicrosoft.com)', required: true };
const CLIENT_ID: CredentialSpec = { flag: '--azure-client-id', env: 'AZURE_CLIENT_ID', label: 'the client id of an app registration with Graph User.Read.All (application)', required: false };
const CLIENT_SECRET: CredentialSpec = { flag: '--azure-client-secret', env: 'AZURE_CLIENT_SECRET', label: 'that app registration\'s client secret', required: false, secret: true };
const ACCESS_TOKEN: CredentialSpec = { flag: '--azure-graph-token', env: 'AZURE_GRAPH_TOKEN', label: 'a Microsoft Graph access token, instead of client credentials', required: false, secret: true };
const AUTH_METHODS: CredentialSpec = { flag: '--azure-auth-methods', env: 'AZURE_EXPORT_AUTH_METHODS', label: 'true to read each user\'s phone / email MFA methods (UserAuthenticationMethod.Read.All)', required: false };
const DIRECTORY_USERS: CredentialSpec = { flag: '--azure-directory-users', env: 'AZURE_EXPORT_DIRECTORY_USERS', label: 'true to also export admin / work accounts', required: false };
const GROUPS_AS: CredentialSpec = { flag: '--groups-as', env: 'ATLAS_MIGRATE_GROUPS_AS', label: 'how groups move: roles or skip', required: false };
const POLICY_DIR: CredentialSpec = { flag: '--b2c-policy-dir', env: 'B2C_POLICY_DIR', label: 'a folder with your B2C custom policy XML files (TrustFrameworkBase.xml, …)', required: false };
const APP_CLIENT_ID: CredentialSpec = { flag: '--azure-app-client-id', env: 'AZURE_APP_CLIENT_ID', label: 'your app\'s client id (the ID token audience; for lazy migration a public client)', required: false };
const SIGN_IN_POLICY: CredentialSpec = { flag: '--b2c-policy', env: 'B2C_POLICY', label: 'the user flow / custom policy that issued your users\' tokens (B2C_1_signupsignin)', required: false };
const ROPC_CLIENT_ID: CredentialSpec = { flag: '--b2c-ropc-client-id', env: 'B2C_ROPC_CLIENT_ID', label: 'the public client registration the ROPC user flow signs in with, when it is not your app\'s client id', required: false };
const ROPC_POLICY: CredentialSpec = { flag: '--b2c-ropc-policy', env: 'B2C_ROPC_POLICY', label: 'the ROPC user flow lazy migration checks passwords with (B2C_1_ROPC_Auth)', required: false };
const CUSTOM_DOMAIN: CredentialSpec = { flag: '--azure-custom-domain', env: 'AZURE_CUSTOM_DOMAIN', label: 'a custom domain in front of b2clogin.com / ciamlogin.com', required: false };

function graph(p: PluginContext) {
  const tenant = need(p, TENANT).trim();
  const accessToken = p.credential(ACCESS_TOKEN);
  const clientId = p.credential(CLIENT_ID);
  const clientSecret = p.credential(CLIENT_SECRET);
  if (!accessToken && !(clientId && clientSecret)) {
    throw new CliError('Microsoft Graph: pass an app registration\'s client id and secret (AZURE_CLIENT_ID, AZURE_CLIENT_SECRET) with the User.Read.All application permission, or a Graph access token (AZURE_GRAPH_TOKEN).');
  }
  return { tenant, accessToken, clientId, clientSecret };
}

/** The B2C custom policy files of a folder (`*.xml`), for the config report. */
export function readPolicyDir(dir: string): AzureConfigSnapshot['policies'] {
  const root = resolve(dir);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch (err) {
    throw new CliError(`Could not read the custom policy folder ${dir}: ${(err as Error).message}`);
  }
  return names
    .filter((n) => n.toLowerCase().endsWith('.xml') && statSync(join(root, n)).isFile())
    .sort()
    .map((n) => ({ file: basename(n), text: readFileSync(join(root, n), 'utf8') }));
}

/** Tenant name of a domain argument (`contoso.onmicrosoft.com` → `contoso`), or undefined for a GUID. */
function tenantNameOf(raw: string | undefined): string | undefined {
  const m = raw ? /^([a-z0-9-]+)\.(onmicrosoft|b2clogin|ciamlogin)\.com$/i.exec(raw.trim()) : null;
  return m ? m[1]!.toLowerCase() : undefined;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The plugin for one of the two Microsoft customer-identity products. */
export function azurePlugin(kind: AzureKind): MigrationPlugin {
  const b2c = kind === 'b2c';
  const label = b2c ? 'Azure AD B2C' : 'Microsoft Entra External ID';
  const preset = b2c ? 'azure_ad_b2c' : 'entra_external_id';
  const commonVars = (p: PluginContext, base: Record<string, string> | undefined): Record<string, string> => {
    const out: Record<string, string> = { ...base };
    const tenant = p.credential({ ...TENANT, required: false })?.trim();
    const name = tenantNameOf(tenant);
    if (name) out.tenant = name;
    if (tenant && GUID.test(tenant)) out.tenant_id = tenant.toLowerCase();
    const clientId = p.credential(APP_CLIENT_ID);
    if (clientId) out.client_id = clientId;
    return out;
  };
  return {
    vendor: b2c ? 'azure-ad-b2c' : 'entra-external-id',
    source: preset,
    label,
    help: b2c
      ? 'Move an Azure AD B2C tenant: identity providers, user flows, custom policies (with file and line), custom attributes, app registrations and groups as Atlas config; consumer users keyed by object id with their sign-in names, social links, custom attributes, groups and SMS / email factors; a zero-logout bridge for B2C ID tokens; lazy migration through a ROPC user flow (Graph never returns passwords); and the MSAL code. Your app registration secret stays on this machine.'
      : 'Move a Microsoft Entra External ID (external) tenant: identity providers, sign-up / sign-in flows, custom attributes, app registrations and groups as Atlas config; customers keyed by object id with their sign-in identities, social links, custom attributes, groups and SMS / email factors; a zero-logout bridge for External ID ID tokens; lazy migration through the native authentication API (Graph never returns passwords); and the MSAL code. Your app registration secret stays on this machine.',
    config: {
      reads: `your ${label} tenant via Microsoft Graph${b2c ? ' (and your custom policy files with --b2c-policy-dir)' : ''}`,
      credentials: [TENANT, CLIENT_ID, CLIENT_SECRET, ACCESS_TOKEN, ...(b2c ? [POLICY_DIR] : [])],
      async translate(p) {
        const g = graph(p);
        const dir = b2c ? p.credential(POLICY_DIR) : undefined;
        const policies = dir ? readPolicyDir(dir) : [];
        const snap = await vendorStep(label, () => fetchAzureConfig(graphHttp({ ...g, fetchImpl: p.fetch }), kind, g.tenant, policies));
        return translateAzureConfig(snap);
      },
    },
    export: {
      reads: 'Microsoft Graph (users with their identities and extension attributes, groups, authentication methods)',
      credentials: [TENANT, CLIENT_ID, CLIENT_SECRET, ACCESS_TOKEN, AUTH_METHODS, DIRECTORY_USERS],
      limits: [
        `${label} never returns passwords: Graph's password field is write-only. Every password moves by lazy migration, ${b2c ? 'through a ROPC user flow' : 'through the native authentication API'}, on the user's first Atlas sign-in.`,
        'Authenticator-app (software OATH) secrets and FIDO2 keys are never exported: those users enrol again. SMS and email methods move with --set azure-auth-methods=true.',
        'Sessions are not exported: the bridge exchanges the ID token your app holds (MSAL caches up to v3 are read in the browser; v4 caches are encrypted).',
        ...(b2c ? ['Federated identities that Graph keeps only as an alternativeSecurityId cannot be linked by id: those users relink by verified email on first sign-in.'] : []),
      ],
      async run(p, writer, resume) {
        const g = graph(p);
        const groups = p.credential(GROUPS_AS) ?? 'roles';
        if (groups !== 'roles' && groups !== 'skip') throw new CliError(`${label}: --groups-as must be roles or skip (got ${groups}).`);
        const set = await vendorStep(label, () =>
          exportAzure({
            kind,
            ...g,
            authMethods: truthyCredential(p, AUTH_METHODS),
            includeDirectoryUsers: truthyCredential(p, DIRECTORY_USERS),
            groups,
            fetchImpl: p.fetch,
            onProgress: (m) => p.say(`  reading ${m}`),
          }),
        );
        await writeRecordSet(set, writer, resume, p.say);
      },
    },
    bridge: {
      preset,
      vars(p, t) {
        const vars = commonVars(p, t?.bridge?.vars);
        if (b2c) {
          const policy = p.credential(SIGN_IN_POLICY);
          if (policy) vars.policy = policy;
        }
        return vars;
      },
    },
    lazy: {
      preset,
      config(p, t) {
        const config = commonVars(p, t?.lazy?.config);
        delete config.tenant_id;
        if (b2c) {
          const policy = p.credential(ROPC_POLICY);
          if (policy) config.policy = policy;
          const ropcClient = p.credential(ROPC_CLIENT_ID);
          if (ropcClient) config.client_id = ropcClient;
        }
        const domain = p.credential(CUSTOM_DOMAIN);
        if (domain) config.custom_domain = domain;
        return config;
      },
    },
    codemod: b2c ? 'azure-ad-b2c' : 'entra-external-id',
  };
}

export const azureAdB2cPlugin: MigrationPlugin = azurePlugin('b2c');
