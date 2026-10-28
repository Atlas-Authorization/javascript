import { exportOkta } from '../export/okta';
import { fetchOktaConfig, translateOktaConfig } from '../export/okta-config';
import { CliError } from '../../errors';
import type { CredentialSpec, MigrationPlugin, PluginContext } from '../framework/plugin';
import { flag, hostOf, need, vendorStep, writeRecordSet } from '../export/plugin-kit';
import { VendorHttp } from '../export/vendor-http';

/**
 * `atlas migrate okta` — Okta Workforce Identity and Okta Customer Identity
 * Solution (the Okta platform; Okta Customer Identity Cloud is Auth0 and uses
 * `atlas migrate auth0`). Users, groups (as roles or organizations), social
 * and enterprise IdP links and factors through the Okta API; Okta never
 * exports password hashes, so passwords move by lazy migration (Classic
 * `/api/v1/authn`, or the password grant on Identity Engine orgs). The `okta`
 * bridge preset verifies access tokens from a custom authorization server.
 */

const DOMAIN: CredentialSpec = { flag: '--okta-domain', env: 'OKTA_DOMAIN', label: 'your Okta domain (example.okta.com)', required: true };
const API_TOKEN: CredentialSpec = { flag: '--okta-api-token', env: 'OKTA_API_TOKEN', label: 'an Okta API token (read-only admin is enough)', required: true, secret: true };
const AUTH_SERVER: CredentialSpec = { flag: '--okta-auth-server', env: 'OKTA_AUTH_SERVER', label: 'the custom authorization server id (default)', required: false };
const GROUPS_AS: CredentialSpec = { flag: '--groups-as', env: 'ATLAS_MIGRATE_GROUPS_AS', label: 'how groups move: roles, organizations or skip', required: false };
const CLIENT_ID: CredentialSpec = { flag: '--okta-client-id', env: 'OKTA_CLIENT_ID', label: 'the client id of an app with the Resource Owner Password grant (Identity Engine lazy migration)', required: false };

function domainOf(p: PluginContext): string {
  // OKTA_ORG_URL is what the Okta SDK samples use.
  const raw = p.credential({ ...DOMAIN, required: false }) ?? p.ctx.env.OKTA_ORG_URL?.trim();
  if (!raw) return hostOf(need(p, DOMAIN));
  return hostOf(raw);
}

function groupsAs(p: PluginContext): 'roles' | 'organizations' | 'skip' {
  const raw = p.credential(GROUPS_AS) ?? 'roles';
  if (raw !== 'roles' && raw !== 'organizations' && raw !== 'skip') throw new CliError(`Okta: --groups-as must be roles, organizations or skip (got ${raw}).`);
  return raw;
}

export const oktaPlugin: MigrationPlugin = {
  vendor: 'okta',
  source: 'okta',
  label: 'Okta',
  help: 'Move an Okta org (Workforce Identity or Customer Identity Solution): applications, identity providers, password and session policy, authenticators and groups as Atlas config; users with their status, profile, social and enterprise links, groups (as roles or organizations) and factors; a zero-logout bridge for access tokens from a custom authorization server; lazy migration for passwords (Okta never exports hashes); and the code. Your API token stays on this machine.',
  config: {
    reads: 'your Okta org via the Okta API (apps, IdPs, policies, authenticators, groups, authorization servers)',
    credentials: [DOMAIN, API_TOKEN],
    async translate(p) {
      const domain = domainOf(p);
      const http = new VendorHttp({ vendor: 'Okta', baseUrl: `https://${domain}/api/v1`, headers: { authorization: `SSWS ${need(p, API_TOKEN)}` }, fetchImpl: p.fetch });
      const snap = await vendorStep('Okta', () => fetchOktaConfig(http, domain));
      return translateOktaConfig(snap, { groupsAs: groupsAs(p) });
    },
  },
  export: {
    reads: 'the Okta API (users, groups, identity providers, factors)',
    credentials: [DOMAIN, API_TOKEN],
    limits: [
      'Okta never exports password hashes (neither by API nor through support): every password moves by lazy migration, verified against Okta on the user\'s first Atlas sign-in.',
      'Factor secrets (TOTP seeds, WebAuthn credentials) are not exportable: users enrol those again. Phone (SMS/voice) and email factors move as Atlas factors; the export counts the rest by type.',
      'DEPROVISIONED (deactivated) users are left out: they cannot sign in to Okta either.',
    ],
    async run(p, writer, resume) {
      const set = await vendorStep('Okta', () =>
        exportOkta({
          domain: domainOf(p),
          apiToken: need(p, API_TOKEN),
          groupsAs: groupsAs(p),
          factors: flag(p, 'factors'),
          authorizationServerId: p.credential(AUTH_SERVER),
          fetchImpl: p.fetch,
          onProgress: (m) => p.say(`  reading ${m}`),
        }),
      );
      await writeRecordSet(set, writer, resume, p.say);
    },
  },
  bridge: {
    preset: 'okta',
    vars(p, t) {
      const vars: Record<string, string> = { ...t?.bridge?.vars };
      const raw = p.credential({ ...DOMAIN, required: false }) ?? p.ctx.env.OKTA_ORG_URL?.trim();
      if (raw) vars.domain = hostOf(raw);
      const server = p.credential(AUTH_SERVER);
      if (server) vars.auth_server = server;
      return vars;
    },
  },
  lazy: {
    preset: 'okta',
    config(p, t) {
      const config: Record<string, string> = { ...t?.lazy?.config };
      const raw = p.credential({ ...DOMAIN, required: false }) ?? p.ctx.env.OKTA_ORG_URL?.trim();
      if (raw) config.domain = hostOf(raw);
      // Identity Engine orgs without the Classic authn API: the password grant through an app that allows it.
      const clientId = p.credential(CLIENT_ID);
      if (clientId) {
        config.mode = 'password_grant';
        config.client_id = clientId;
        config.auth_server = p.credential(AUTH_SERVER) ?? 'default';
      }
      return config;
    },
    secret: { flag: '--okta-client-secret', env: 'OKTA_CLIENT_SECRET', label: 'that app\'s client secret (confidential apps, password grant only)', required: false, secret: true },
  },
  codemod: 'okta',
};
