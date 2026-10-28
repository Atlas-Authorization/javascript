import { exportFrontegg } from '../export/frontegg';
import { fetchFronteggConfig, translateFronteggConfig } from '../export/frontegg-config';
import { need, vendorStep, writeRecordSet } from '../export/plugin-kit';
import type { CredentialSpec, MigrationPlugin, PluginContext } from '../framework/plugin';

/**
 * `atlas migrate frontegg` — accounts, users, roles, groups, invitations and
 * SSO configurations through Frontegg's management API (environment client id
 * and API key, on this machine), the environment's settings as Atlas config,
 * the `frontegg` bridge preset (RS256 access tokens verified against the
 * environment's JWKS) and lazy migration: Frontegg never returns password
 * hashes, so each password is checked against Frontegg on first sign-in.
 */

const CLIENT_ID: CredentialSpec = { flag: '--frontegg-client-id', env: 'FRONTEGG_CLIENT_ID', label: 'your Frontegg environment client id', required: true };
const API_KEY: CredentialSpec = { flag: '--frontegg-api-key', env: 'FRONTEGG_API_KEY', label: 'your Frontegg environment API key', required: true, secret: true };
const REGION: CredentialSpec = { flag: '--frontegg-region', env: 'FRONTEGG_REGION', label: 'your Frontegg region (eu, us, ca or au; default eu)', required: false };
const DOMAIN: CredentialSpec = { flag: '--frontegg-domain', env: 'FRONTEGG_BASE_URL', label: 'your Frontegg domain (https://app-xxx.frontegg.com)', required: false };

function connection(p: PluginContext) {
  const region = p.credential(REGION);
  return { clientId: need(p, CLIENT_ID), apiKey: need(p, API_KEY), ...(region ? { region } : {}), fetchImpl: p.fetch };
}

/** The Frontegg domain from the flag or env, else the one the app already uses (`FRONTEGG_BASE_URL`). */
function domainOf(p: PluginContext): string | undefined {
  const raw = p.credential(DOMAIN) ?? p.ctx.env.FRONTEGG_BASE_URL?.trim();
  return raw ? raw.replace(/\/+$/, '') : undefined;
}

export const fronteggPlugin: MigrationPlugin = {
  vendor: 'frontegg',
  source: 'frontegg',
  label: 'Frontegg',
  help: 'Move a Frontegg environment: sign-in methods, password, MFA and session policies, roles and permissions as Atlas config; users with verified emails, usernames and metadata, accounts as organizations with members and roles, groups, invitations and SSO connections; a zero-logout bridge for Frontegg access tokens; lazy migration for passwords (Frontegg never returns hashes); and the code. Your API key stays on this machine.',
  config: {
    reads: 'your Frontegg environment via the management API',
    credentials: [CLIENT_ID, API_KEY, REGION, DOMAIN],
    async translate(p) {
      const snap = await vendorStep('Frontegg', () => fetchFronteggConfig(connection(p)));
      return translateFronteggConfig(snap, domainOf(p));
    },
  },
  export: {
    reads: 'the Frontegg management API (accounts, users, roles, groups, invitations, SSO)',
    credentials: [CLIENT_ID, API_KEY, REGION],
    limits: [
      'Frontegg never returns password hashes: passwords move by lazy migration (the frontegg preset checks each password against Frontegg on first sign-in).',
      'Authenticator-app and SMS second factors, passkeys and social-account ids cannot be exported: members enrol again and social accounts relink by verified email.',
      'API token secrets and OIDC client secrets are never revealed: reissue the tokens as Atlas API keys and enter the secrets in Atlas.',
      'Sessions are not exported: Frontegg access tokens are exchanged by the frontegg bridge preset, which needs your Frontegg domain.',
    ],
    async run(p, writer, resume) {
      const set = await vendorStep('Frontegg', () => exportFrontegg({ ...connection(p), onProgress: (m) => p.say(`  reading ${m}`) }));
      await writeRecordSet(set, writer, resume, p.say);
    },
  },
  bridge: {
    preset: 'frontegg',
    vars(p, t) {
      const base = domainOf(p);
      return { ...t?.bridge?.vars, ...(base ? { base_url: base } : {}) };
    },
  },
  lazy: {
    preset: 'frontegg',
    config(p, t) {
      const config: Record<string, string> = { ...t?.lazy?.config };
      const clientId = p.credential({ ...CLIENT_ID, required: false });
      if (clientId) config.client_id = clientId;
      const region = p.credential(REGION);
      if (region) config.region = region.toLowerCase();
      return config;
    },
    secret: API_KEY,
  },
  codemod: 'frontegg',
};
