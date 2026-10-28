import { exportAuth0, managementToken } from '../export/auth0';
import { fetchAuth0Config, translateAuth0Config } from '../export/auth0-config';
import { CliError } from '../../errors';
import type { CredentialSpec, MigrationPlugin, PluginContext } from '../framework/plugin';
import { flag, hostOf, localFile, need, vendorStep, writeRecordSet } from '../export/plugin-kit';
import { VendorHttp } from '../export/vendor-http';

/**
 * `atlas migrate auth0` (also Okta Customer Identity Cloud) — the tenant's
 * settings through the Management API, users through a users-export job (or
 * an export file), the password hashes and MFA secrets from Auth0 support's
 * encrypted export when the owner has it, the `auth0` bridge preset (the ID
 * token in the app session, verified against the tenant's JWKS) and lazy
 * migration through the password-realm grant for every other password.
 */

const DOMAIN: CredentialSpec = { flag: '--auth0-domain', env: 'AUTH0_DOMAIN', label: 'your Auth0 domain (tenant.us.auth0.com)', required: true };
const MGMT_CLIENT_ID: CredentialSpec = { flag: '--auth0-mgmt-client-id', env: 'AUTH0_MGMT_CLIENT_ID', label: 'the client id of a machine-to-machine app authorized for the Management API', required: false };
const MGMT_CLIENT_SECRET: CredentialSpec = { flag: '--auth0-mgmt-client-secret', env: 'AUTH0_MGMT_CLIENT_SECRET', label: 'that app\'s client secret', required: false, secret: true };
const MGMT_TOKEN: CredentialSpec = { flag: '--auth0-mgmt-token', env: 'AUTH0_MGMT_TOKEN', label: 'a Management API token', required: false, secret: true };
const CLIENT_ID: CredentialSpec = { flag: '--auth0-client-id', env: 'AUTH0_CLIENT_ID', label: 'your application\'s client id (the ID token audience)', required: false };
const CLIENT_SECRET: CredentialSpec = { flag: '--auth0-client-secret', env: 'AUTH0_CLIENT_SECRET', label: 'your application\'s client secret (for a confidential application)', required: false, secret: true };
const CONNECTION: CredentialSpec = { flag: '--auth0-connection', env: 'AUTH0_CONNECTION', label: 'the database connection', required: false };
const USERS_FILE: CredentialSpec = { flag: '--auth0-users-file', env: 'AUTH0_USERS_FILE', label: 'a users export file (NDJSON or JSON)', required: false };
const HASHES_FILE: CredentialSpec = { flag: '--auth0-hashes-file', env: 'AUTH0_HASHES_FILE', label: 'the decrypted password-hash export from Auth0 support', required: false };
const RP_ID: CredentialSpec = { flag: '--rp-id', env: 'ATLAS_MIGRATE_RP_ID', label: 'the WebAuthn relying party id passkeys were registered for', required: false };

function domainOf(p: PluginContext): string {
  return hostOf(need(p, DOMAIN));
}

/** The Management API, with a token or client credentials (asked for on this machine, sent only to Auth0). */
function managementHttp(p: PluginContext, domain: string): VendorHttp {
  const token = p.credential(MGMT_TOKEN);
  const clientId = p.credential(MGMT_CLIENT_ID);
  const clientSecret = p.credential(MGMT_CLIENT_SECRET);
  if (!token && !(clientId && clientSecret)) {
    throw new CliError('Auth0: pass a Management API token (--auth0-mgmt-token / AUTH0_MGMT_TOKEN), or the client id and secret of a machine-to-machine app authorized for it (AUTH0_MGMT_CLIENT_ID, AUTH0_MGMT_CLIENT_SECRET).');
  }
  let bearer = token;
  return new VendorHttp({
    vendor: 'Auth0',
    baseUrl: `https://${domain}/api/v2`,
    headers: async () => ({ authorization: `Bearer ${(bearer ??= await managementToken(domain, { domain, clientId, clientSecret }, p.fetch))}` }),
    fetchImpl: p.fetch,
  });
}

export const auth0Plugin: MigrationPlugin = {
  vendor: 'auth0',
  source: 'auth0',
  label: 'Auth0',
  help: 'Move an Auth0 (Okta Customer Identity Cloud) tenant: its connections, MFA, password policy, applications, APIs, roles and organizations as Atlas config; its users (export job), identities, organizations, members, roles and invitations, plus password hashes and MFA secrets from the encrypted export Auth0 support provides; a zero-logout bridge; lazy migration for every password you do not have; and the code. Management credentials stay on this machine.',
  config: {
    reads: 'your Auth0 tenant via the Management API',
    credentials: [DOMAIN, MGMT_TOKEN, MGMT_CLIENT_ID, MGMT_CLIENT_SECRET],
    async translate(p) {
      const domain = domainOf(p);
      const snap = await vendorStep('Auth0', () => fetchAuth0Config(managementHttp(p, domain), domain));
      return translateAuth0Config(snap);
    },
  },
  export: {
    reads: 'the Auth0 Management API (users-export job, organizations, roles) and the support hash export (--auth0-hashes-file)',
    credentials: [DOMAIN, MGMT_TOKEN, MGMT_CLIENT_ID, MGMT_CLIENT_SECRET, USERS_FILE, HASHES_FILE, CONNECTION],
    limits: [
      'Password hashes and MFA secrets never come out of the Management API: Auth0 support exports them on request (paid plans, encrypted to your PGP key). Pass the decrypted file with --auth0-hashes-file; without it, passwords move by lazy migration.',
      'Users-export jobs are not available on the Free plan: export from the dashboard (or the User Import / Export extension) and pass the file with --auth0-users-file.',
      'Passkey private keys never leave the authenticator; with --authentication-methods the public credentials are exported and keep working when your Atlas domain matches the relying party (--rp-id).',
      'Sessions are not exported: the auth0 bridge preset exchanges the ID token from the app session.',
    ],
    async run(p, writer, resume) {
      const domain = domainOf(p);
      const usersText = localFile(p, USERS_FILE, 'text');
      const token = p.credential(MGMT_TOKEN);
      const clientId = p.credential(MGMT_CLIENT_ID);
      const clientSecret = p.credential(MGMT_CLIENT_SECRET);
      if (!usersText && !token && !(clientId && clientSecret)) {
        throw new CliError('Auth0: pass Management API credentials (AUTH0_MGMT_TOKEN, or AUTH0_MGMT_CLIENT_ID and AUTH0_MGMT_CLIENT_SECRET), or a users export file (--auth0-users-file).');
      }
      const set = await vendorStep('Auth0', () =>
        exportAuth0({
          domain,
          token,
          clientId,
          clientSecret,
          usersText,
          hashesText: localFile(p, HASHES_FILE, 'text'),
          connectionId: p.credential(CONNECTION),
          authenticationMethods: flag(p, 'authentication-methods'),
          rpId: p.credential(RP_ID),
          fetchImpl: p.fetch,
          onProgress: (m) => p.say(`  reading ${m}`),
        }),
      );
      await writeRecordSet(set, writer, resume, p.say);
    },
  },
  bridge: {
    preset: 'auth0',
    vars(p, t) {
      const vars: Record<string, string> = { ...t?.bridge?.vars };
      const domain = p.credential({ ...DOMAIN, required: false });
      if (domain) vars.domain = hostOf(domain);
      const clientId = p.credential(CLIENT_ID);
      if (clientId) vars.client_id = clientId;
      return vars;
    },
  },
  lazy: {
    preset: 'auth0',
    config(p, t) {
      const config: Record<string, string> = { ...t?.lazy?.config };
      const domain = p.credential({ ...DOMAIN, required: false });
      if (domain) config.domain = hostOf(domain);
      const clientId = p.credential(CLIENT_ID);
      if (clientId) config.client_id = clientId;
      const connection = p.credential(CONNECTION);
      if (connection) config.connection = connection;
      return config;
    },
    secret: CLIENT_SECRET,
  },
  codemod: 'auth0',
};
