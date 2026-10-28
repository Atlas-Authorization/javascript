import { exportPingOne, pingOneHttp, pingOneList, pingOneToken, pingRegion } from '../export/pingone';
import { need, vendorStep, writeRecordSet } from '../export/plugin-kit';
import { ConfigBuilder, socialKey } from '../export/translate-kit';
import { isObj, str, type Obj } from '../export/record-set';
import { ssoConnectionOf } from '../export/pingone';
import type { CredentialSpec, MigrationPlugin, PluginContext } from '../framework/plugin';

/**
 * `atlas migrate ping-identity` — a PingOne environment: password policy,
 * social providers and SAML / OIDC connections as Atlas config; users, groups
 * (roles) and enterprise connections through the management API with a worker
 * application on this machine; the `ping_identity` bridge preset (PingOne
 * access / ID tokens verified against the environment's keys) and lazy
 * migration through PingOne's password check. PingFederate keeps users in your
 * directory: export that as LDIF (`atlas migrate ldap`) and its SAML
 * connections as metadata (`atlas migrate saml`).
 */

const ENVIRONMENT: CredentialSpec = { flag: 'pingone-environment-id', env: 'PINGONE_ENVIRONMENT_ID', label: 'your PingOne environment id', required: true };
const CLIENT_ID: CredentialSpec = { flag: 'pingone-client-id', env: 'PINGONE_CLIENT_ID', label: 'a PingOne worker application client id', required: true };
const CLIENT_SECRET: CredentialSpec = { flag: 'pingone-client-secret', env: 'PINGONE_CLIENT_SECRET', label: 'the worker application client secret', required: true, secret: true };
const REGION: CredentialSpec = { flag: 'pingone-region', env: 'PINGONE_REGION', label: 'the PingOne region (com, eu, asia, ca, com.au)', required: false };
const GROUPS: CredentialSpec = { flag: 'pingone-groups', env: 'PINGONE_GROUPS', label: 'read each user\'s group memberships (true by default; false for very large environments)', required: false };

const region = (p: PluginContext) => pingRegion(p.credential(REGION));
const creds = (p: PluginContext) => ({ environmentId: need(p, ENVIRONMENT), clientId: need(p, CLIENT_ID), clientSecret: need(p, CLIENT_SECRET), region: region(p), fetchImpl: p.fetch });

export const pingIdentityPlugin: MigrationPlugin = {
  vendor: 'ping-identity',
  source: 'ping_identity',
  label: 'Ping Identity (PingOne, PingFederate)',
  help: 'Move a PingOne environment: password policy and social providers as Atlas config, SAML / OIDC identity providers as SSO connections, users with their login, verified email, phones, state and population, groups as roles, a zero-logout bridge for PingOne tokens, and lazy migration for passwords (PingOne never exports hashes). Your worker application credentials stay on this machine. PingFederate: export your directory as LDIF (atlas migrate ldap) and its connection metadata (atlas migrate saml).',
  config: {
    reads: 'your PingOne environment (password policies, identity providers)',
    credentials: [ENVIRONMENT, CLIENT_ID, CLIENT_SECRET, REGION],
    async translate(p) {
      const c = creds(p);
      const { policies, idps } = await vendorStep('PingOne', async () => {
        const http = pingOneHttp(c, await pingOneToken(c));
        const safe = async (path: string, key: string) => {
          try {
            return await pingOneList(http, path, key);
          } catch {
            return [] as Obj[];
          }
        };
        return { policies: await safe('/passwordPolicies', 'passwordPolicies'), idps: await safe('/identityProviders', 'identityProviders') };
      });
      const b = new ConfigBuilder();
      b.set('strategies.password', true);
      b.add('differs', 'authentication', 'password', 'PingOne never exports password hashes: the ping_identity lazy-migration preset checks each password against PingOne on first sign-in.', 'auth_config.strategies.password');
      const policy = policies.find((x) => x.default === true) ?? policies[0];
      if (policy) {
        const min = Number(isObj(policy.length) ? policy.length.min : 8);
        b.set('passwordPolicy.minLength', Math.max(8, Number.isFinite(min) ? min : 8));
        b.add(min < 8 ? 'differs' : 'mapped', `passwordPolicies ${str(policy.name) ?? ''}`.trim(), 'length.min', `${min}${min < 8 ? ' (Atlas requires at least 8; existing passwords still sign in)' : ''}.`, 'auth_config.passwordPolicy.minLength');
        b.add('differs', `passwordPolicies ${str(policy.name) ?? ''}`.trim(), 'minCharacters / excludesCommonlyUsed', 'Atlas follows NIST 800-63B: length and breached-password checks, no character-class rules.', 'auth_config.passwordPolicy');
      }
      for (const idp of idps) {
        const type = str(idp.type) ?? '';
        const name = str(idp.name) ?? type;
        if (ssoConnectionOf(idp)) {
          b.add('mapped', 'identityProviders', `${name} (${type})`, 'Enterprise IdP: moves with the data export as an Atlas SSO connection; update the IdP with Atlas\'s ACS URL / redirect URI, and replace PingOne routing with the connection\'s domains.', 'sso_connections');
        } else if (socialKey(type)) {
          b.socialProvider({ atlasKey: socialKey(type)!, vendorName: name, area: 'identityProviders', setting: `${name} (${type})`, clientId: str(idp.clientId) });
        } else b.add('manual', 'identityProviders', `${name} (${type})`, 'No Atlas counterpart for this provider type: add it as a custom OAuth provider.');
      }
      b.add('manual', 'authentication', 'sign-on policies / MFA policies / DaVinci flows', 'PingOne sign-on policies, MFA policies and DaVinci flows are not translated: set Atlas\'s MFA policy and sign-in methods in auth_config.');
      return b.result(`PingOne environment ${c.environmentId}`, {
        bridge: { preset: 'ping_identity', vars: { environment_id: c.environmentId, region: c.region } },
        lazy: { preset: 'ping_identity', config: { environment_id: c.environmentId, region: c.region, client_id: c.clientId } },
      });
    },
  },
  export: {
    reads: 'your PingOne environment through the management API (users, groups, identity providers)',
    credentials: [ENVIRONMENT, CLIENT_ID, CLIENT_SECRET, REGION, GROUPS],
    limits: [
      'Password hashes are never exported by PingOne: passwords move by lazy migration (preset ping_identity).',
      'TOTP secrets, FIDO2 credentials and mobile-app pairings cannot be exported: users enrol their second factor again.',
      'PingFederate has no user store of its own: export your directory (LDIF) and the SAML connection metadata with atlas migrate ldap / saml.',
    ],
    async run(p, writer, resume) {
      const set = await vendorStep('PingOne', () => exportPingOne({ ...creds(p), groups: p.credential(GROUPS) !== 'false', onProgress: (m) => p.say(`  reading ${m}`) }));
      await writeRecordSet(set, writer, resume, p.say);
    },
  },
  bridge: {
    preset: 'ping_identity',
    vars: (p, t) => ({ environment_id: need(p, ENVIRONMENT), region: region(p), ...t?.bridge?.vars }),
  },
  lazy: {
    preset: 'ping_identity',
    config: (p, t) => ({ environment_id: need(p, ENVIRONMENT), region: region(p), client_id: need(p, CLIENT_ID), ...t?.lazy?.config }),
    secret: CLIENT_SECRET,
  },
};
