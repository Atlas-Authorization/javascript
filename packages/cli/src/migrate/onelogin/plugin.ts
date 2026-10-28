import { exportOneLogin, oneLoginSubdomain } from '../export/onelogin';
import { need, vendorStep, writeRecordSet } from '../export/plugin-kit';
import { ConfigBuilder } from '../export/translate-kit';
import type { CredentialSpec, MigrationPlugin, PluginContext } from '../framework/plugin';

/**
 * `atlas migrate onelogin` — a OneLogin account: users and roles through API
 * v2 with API credentials on this machine, the `onelogin` bridge preset
 * (OIDC v2 tokens verified against the account's keys) and lazy migration
 * through OneLogin's session-login-token API (OneLogin never exports hashes).
 */

const SUBDOMAIN: CredentialSpec = { flag: 'onelogin-subdomain', env: 'ONELOGIN_SUBDOMAIN', label: 'your OneLogin subdomain (acme for acme.onelogin.com)', required: true };
const CLIENT_ID: CredentialSpec = { flag: 'onelogin-client-id', env: 'ONELOGIN_CLIENT_ID', label: 'an API credential client id', required: true };
const CLIENT_SECRET: CredentialSpec = { flag: 'onelogin-client-secret', env: 'ONELOGIN_CLIENT_SECRET', label: 'the API credential client secret', required: true, secret: true };

const subdomain = (p: PluginContext) => oneLoginSubdomain(need(p, SUBDOMAIN));

export const oneLoginPlugin: MigrationPlugin = {
  vendor: 'onelogin',
  source: 'onelogin',
  label: 'OneLogin',
  help: 'Move a OneLogin account: users with their login, email, name, phone, status (suspended and locked carry over) and custom attributes, roles as app roles, a zero-logout bridge for OneLogin OIDC tokens, and lazy migration for passwords (OneLogin never exports hashes). Your API credentials stay on this machine. Apps connected through OneLogin\'s SAML / OIDC are moved with atlas migrate saml / oidc using the app\'s metadata.',
  config: {
    reads: 'your OneLogin subdomain (the API exposes no policy settings to read)',
    credentials: [SUBDOMAIN],
    async translate(p) {
      const sub = subdomain(p);
      const b = new ConfigBuilder();
      b.set('strategies.password', true);
      b.add('differs', 'authentication', 'password', 'OneLogin never exports password hashes: the onelogin lazy-migration preset checks each password against OneLogin on first sign-in.', 'auth_config.strategies.password');
      b.add('manual', 'security policies', 'user security policies (password, MFA, session)', 'The OneLogin API does not expose security policies: read them in the admin portal and set Atlas\'s passwordPolicy, MFA policy and session lifetimes in auth_config.');
      b.add('manual', 'apps', 'SAML / OIDC connectors', 'Download each app\'s metadata and move it with atlas migrate saml export (or oidc export).');
      return b.result(`OneLogin account ${sub}.onelogin.com`, {
        bridge: { preset: 'onelogin', vars: { subdomain: sub } },
        lazy: { preset: 'onelogin', config: { subdomain: sub, client_id: need(p, CLIENT_ID) } },
      });
    },
  },
  export: {
    reads: 'your OneLogin account through API v2 (users, roles)',
    credentials: [SUBDOMAIN, CLIENT_ID, CLIENT_SECRET],
    limits: [
      'Password hashes are never exported by OneLogin: passwords move by lazy migration (preset onelogin).',
      'MFA secrets cannot be exported: users enrol their second factor again.',
      'OneLogin does not say which addresses were confirmed: they import unverified.',
    ],
    async run(p, writer, resume) {
      const set = await vendorStep('OneLogin', () =>
        exportOneLogin({ subdomain: need(p, SUBDOMAIN), clientId: need(p, CLIENT_ID), clientSecret: need(p, CLIENT_SECRET), fetchImpl: p.fetch, onProgress: (m) => p.say(`  reading ${m}`) }),
      );
      await writeRecordSet(set, writer, resume, p.say);
    },
  },
  bridge: {
    preset: 'onelogin',
    vars: (p, t) => ({ subdomain: subdomain(p), ...t?.bridge?.vars }),
  },
  lazy: {
    preset: 'onelogin',
    config: (p, t) => ({ subdomain: subdomain(p), client_id: need(p, CLIENT_ID), ...t?.lazy?.config }),
    secret: CLIENT_SECRET,
  },
};
