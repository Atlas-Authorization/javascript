import { exportWorkos } from '../export/workos';
import { fetchWorkosConfig, translateWorkosConfig } from '../export/workos-config';
import type { CredentialSpec, MigrationPlugin, PluginContext } from '../framework/plugin';
import { localFile, need, vendorStep, writeRecordSet } from '../export/plugin-kit';
import { VendorHttp } from '../export/vendor-http';

/**
 * `atlas migrate workos` — a WorkOS environment (AuthKit, SSO, Directory
 * Sync) through the WorkOS API with the environment's API key (on this
 * machine): roles and permissions as Atlas config; users with verified
 * emails, OAuth identities, organizations, memberships and role slugs,
 * invitations and SSO connections as data; the `workos` bridge preset (access
 * tokens verified against the client's JWKS, with a local unsealer for the
 * `wos-session` cookie) and lazy migration through WorkOS's password
 * authentication for every password.
 */

const API_KEY: CredentialSpec = { flag: '--workos-api-key', env: 'WORKOS_API_KEY', label: 'a WorkOS API key (sk_…)', required: true, secret: true };
const CLIENT_ID: CredentialSpec = { flag: '--workos-client-id', env: 'WORKOS_CLIENT_ID', label: 'your WorkOS client id (client_…)', required: true };
const HASHES_FILE: CredentialSpec = { flag: '--workos-hashes-file', env: 'WORKOS_HASHES_FILE', label: 'a password-hash export from WorkOS support', required: false };
const BASE_URL: CredentialSpec = { flag: '--workos-base-url', env: 'WORKOS_BASE_URL', label: 'the WorkOS API base URL', required: false };
const COUNT_FACTORS: CredentialSpec = { flag: '--workos-factors', env: 'WORKOS_COUNT_FACTORS', label: 'set to 1 to count second factors (one extra request per user)', required: false };

/** The client id from the flag/env, or the app's own public env var; undefined when neither is set. */
function clientIdOpt(p: PluginContext): string | undefined {
  return (
    p.credential({ ...CLIENT_ID, required: false }) ??
    (p.ctx.env.NEXT_PUBLIC_WORKOS_CLIENT_ID?.trim() || p.ctx.env.VITE_WORKOS_CLIENT_ID?.trim() || undefined)
  );
}

function clientId(p: PluginContext): string {
  return clientIdOpt(p) ?? need(p, CLIENT_ID);
}

function baseUrl(p: PluginContext): string | undefined {
  return p.credential(BASE_URL)?.replace(/\/+$/, '');
}

export const workosPlugin: MigrationPlugin = {
  vendor: 'workos',
  source: 'workos',
  label: 'WorkOS',
  help: 'Move a WorkOS environment: roles and permissions as Atlas config; users with verified emails and OAuth identities, organizations, memberships and role slugs, invitations and SSO connections; password hashes when WorkOS support provides them; a zero-logout bridge for AuthKit access tokens (including the sealed wos-session cookie); lazy migration through WorkOS password authentication; and the code. Your API key stays on this machine.',
  config: {
    reads: 'your WorkOS environment via the API (roles, permissions, redirect URIs, connections)',
    credentials: [API_KEY, CLIENT_ID],
    async translate(p) {
      const http = new VendorHttp({ vendor: 'WorkOS', baseUrl: baseUrl(p) ?? 'https://api.workos.com', headers: { authorization: `Bearer ${need(p, API_KEY)}` }, fetchImpl: p.fetch });
      const snap = await vendorStep('WorkOS', () => fetchWorkosConfig(http, clientIdOpt(p)));
      return translateWorkosConfig(snap);
    },
  },
  export: {
    reads: 'the WorkOS API (organizations, roles, users, identities, memberships, invitations, connections) and, if you have one, the support hash export (--workos-hashes-file)',
    credentials: [API_KEY, CLIENT_ID, HASHES_FILE, BASE_URL, COUNT_FACTORS],
    limits: [
      'WorkOS has no password-hash export: if WorkOS support provides one, pass it with --workos-hashes-file; otherwise passwords move by lazy migration (checked against WorkOS on each user\'s first sign-in).',
      'TOTP secrets and passkeys are not exportable: users enrol their second factor and passkeys again.',
      'SSO connections move without the identity provider\'s entity id, SSO URL or OIDC secret (the WorkOS API does not return them): each customer\'s IdP admin sets the connection up again against the new Atlas details.',
      'API key secrets are shown once by WorkOS: reissue them as Atlas API keys. Sessions are not exported: AuthKit access tokens are JWTs, exchanged by the workos bridge preset.',
    ],
    async run(p, writer, resume) {
      const set = await vendorStep('WorkOS', () =>
        exportWorkos({
          apiKey: need(p, API_KEY),
          clientId: clientIdOpt(p),
          baseUrl: baseUrl(p),
          hashesText: localFile(p, HASHES_FILE, 'text'),
          countFactors: Boolean(p.credential(COUNT_FACTORS)),
          fetchImpl: p.fetch,
          onProgress: (m) => p.say(`  reading ${m}`),
        }),
      );
      await writeRecordSet(set, writer, resume, p.say);
    },
  },
  bridge: {
    preset: 'workos',
    vars: (p, t) => ({ ...t?.bridge?.vars, client_id: t?.bridge?.vars.client_id ?? clientId(p) }),
  },
  lazy: {
    preset: 'workos',
    config: (p, t) => ({ ...t?.lazy?.config, client_id: t?.lazy?.config.client_id ?? clientId(p) }),
    secret: API_KEY,
  },
  codemod: 'workos',
};
