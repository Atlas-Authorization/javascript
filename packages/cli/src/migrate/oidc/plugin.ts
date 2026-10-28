import { CliError } from '../../errors';
import { writeRecordSet } from '../export/plugin-kit';
import { connectionSet, fetchDiscovery, oidcConnection } from '../export/sso-metadata';
import { ConfigBuilder } from '../export/translate-kit';
import type { CredentialSpec, MigrationPlugin, PluginContext, TranslationResult } from '../framework/plugin';

/**
 * `atlas migrate oidc export --set oidc-issuer=https://idp.example.com` — any
 * OpenID Connect provider from its discovery document: an Atlas SSO connection,
 * the JWT bridge preset (the issuer's tokens exchange for Atlas sessions, keys
 * found by discovery) and, when the provider allows the password grant, the
 * lazy-migration preset. Users come from `atlas migrate user-table` / `ldap`.
 */

const ISSUER: CredentialSpec = { flag: 'oidc-issuer', env: 'OIDC_ISSUER', label: 'the provider issuer URL (https://idp.example.com/realms/acme)', required: true };
const CLIENT_ID: CredentialSpec = { flag: 'oidc-client-id', env: 'OIDC_CLIENT_ID', label: 'the client id Atlas signs in with (and the password grant uses)', required: false };
const CLIENT_SECRET: CredentialSpec = { flag: 'oidc-client-secret', env: 'OIDC_CLIENT_SECRET', label: 'the client secret', required: false, secret: true };
const DOMAINS: CredentialSpec = { flag: 'oidc-domains', env: 'OIDC_DOMAINS', label: 'email domains that sign in through this provider (comma separated)', required: false };

async function discover(p: PluginContext) {
  const issuer = p.credential({ ...ISSUER, required: true })!;
  try {
    return await fetchDiscovery(p.fetch, issuer);
  } catch (err) {
    throw new CliError(`OpenID Connect discovery: ${(err as Error).message}`);
  }
}

export const oidcPlugin: MigrationPlugin = {
  vendor: 'oidc',
  source: 'oidc',
  label: 'Any OpenID Connect provider',
  help: 'Move off a generic OpenID Connect provider: discovery (--set oidc-issuer=…) creates the Atlas SSO connection, the zero-logout bridge accepts the provider\'s tokens (keys found by discovery), and lazy migration uses the password grant when the provider offers it for a client you register. Bring the accounts with atlas migrate user-table (a CSV/JSON export) or atlas migrate ldap.',
  config: {
    reads: 'the provider\'s OpenID Connect discovery document',
    credentials: [ISSUER, CLIENT_ID],
    async translate(p): Promise<TranslationResult> {
      const d = await discover(p);
      const b = new ConfigBuilder();
      b.add('mapped', 'oidc', d.issuer, 'Becomes an Atlas SSO connection (atlas migrate oidc export + import). Add Atlas\'s redirect URI to the provider\'s client.', 'sso_connections');
      b.add('mapped', 'oidc', 'jwks_uri', d.jwks_uri ? `Session tokens verify against ${d.jwks_uri} (found by discovery).` : 'The provider publishes no jwks_uri: the bridge cannot verify its tokens.', 'bridge');
      if (d.grant_types_supported.includes('password')) b.add('differs', 'oidc', 'grant_types_supported password', 'The password grant is offered: lazy migration can check passwords against the provider.', 'legacy_auth_connection');
      else b.add('manual', 'oidc', 'grant_types_supported', 'The provider does not list the password grant: passwords cannot be checked by lazy migration (users reset, or you export hashes).');
      const clientId = p.credential(CLIENT_ID);
      return b.result(`OIDC provider ${d.issuer}`, {
        bridge: { preset: 'oidc', vars: { issuer: d.issuer } },
        ...(d.token_endpoint && clientId ? { lazy: { preset: 'oidc', config: { token_endpoint: d.token_endpoint, client_id: clientId, ...(d.userinfo_endpoint ? { userinfo_endpoint: d.userinfo_endpoint } : {}) } } } : {}),
      });
    },
  },
  export: {
    reads: 'the provider\'s OpenID Connect discovery document (--set oidc-issuer=…)',
    credentials: [ISSUER, CLIENT_ID, CLIENT_SECRET, DOMAINS],
    limits: ['An OpenID Connect provider exposes no user list: bring the accounts with atlas migrate user-table or atlas migrate ldap.'],
    async run(p, writer, resume) {
      const d = await discover(p);
      const domains = (p.credential(DOMAINS) ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
      const c = oidcConnection(d, { clientId: p.credential(CLIENT_ID), clientSecret: p.credential(CLIENT_SECRET), domains: domains.length ? domains : undefined });
      await writeRecordSet(connectionSet([c], `OIDC provider ${d.issuer}`), writer, resume, p.say);
    },
  },
  bridge: {
    preset: 'oidc',
    vars: (p, t) => ({ ...t?.bridge?.vars, issuer: t?.bridge?.vars.issuer ?? p.credential({ ...ISSUER, required: true })! }),
  },
  lazy: {
    preset: 'oidc',
    config: (p, t) => ({ ...t?.lazy?.config, ...(p.credential(CLIENT_ID) ? { client_id: p.credential(CLIENT_ID)! } : {}) }),
    secret: CLIENT_SECRET,
  },
};
