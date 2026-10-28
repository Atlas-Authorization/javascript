import { exportPropelauth, normalizeAuthUrl, propelauthHttp } from '../export/propelauth';
import { fetchPropelauthConfig, translatePropelauthConfig } from '../export/propelauth-config';
import type { CredentialSpec, MigrationPlugin, PluginContext } from '../framework/plugin';
import { localFile, need, vendorStep, writeRecordSet } from '../export/plugin-kit';

/**
 * `atlas migrate propelauth` — users, organizations, roles and pending
 * invitations through PropelAuth's backend API (auth URL + API key, on this
 * machine), password hashes from the export PropelAuth support provides when
 * the owner has it, and the `propelauth` bridge preset (RS256 access tokens
 * verified with the project's verifier key). PropelAuth has no password-verify
 * API, so there is no lazy-migration preset.
 */

const AUTH_URL: CredentialSpec = { flag: '--propelauth-auth-url', env: 'PROPELAUTH_AUTH_URL', label: 'your PropelAuth auth URL (https://123456.propelauthtest.com)', required: true };
const API_KEY: CredentialSpec = { flag: '--propelauth-api-key', env: 'PROPELAUTH_API_KEY', label: 'a PropelAuth backend API key', required: true, secret: true };
const HASHES_FILE: CredentialSpec = { flag: '--propelauth-hashes-file', env: 'PROPELAUTH_HASHES_FILE', label: 'the password-hash export from PropelAuth support', required: false };

/** The auth URL from the flag or env, else the one the app already uses (`NEXT_PUBLIC_AUTH_URL`). */
function authUrl(p: PluginContext): string {
  const raw = p.credential({ ...AUTH_URL, required: false }) ?? (p.ctx.env.NEXT_PUBLIC_AUTH_URL?.trim() || need(p, AUTH_URL));
  return normalizeAuthUrl(raw);
}

export const propelauthPlugin: MigrationPlugin = {
  vendor: 'propelauth',
  source: 'propelauth',
  label: 'PropelAuth',
  help: 'Move a PropelAuth project: users with their verified emails, usernames and metadata, organizations with members, roles and permissions, pending invitations, password hashes from the export PropelAuth support provides, a zero-logout bridge for PropelAuth access tokens, and the code. Your API key stays on this machine.',
  config: {
    reads: 'your PropelAuth project via the backend API (role mappings, organizations with SAML)',
    credentials: [AUTH_URL, API_KEY],
    async translate(p) {
      const url = authUrl(p);
      const http = propelauthHttp({ authUrl: url, apiKey: need(p, API_KEY), fetchImpl: p.fetch });
      return translatePropelauthConfig(await vendorStep('PropelAuth', () => fetchPropelauthConfig(http, url)));
    },
  },
  export: {
    reads: 'the PropelAuth backend API (users, organizations, invitations) and the support hash export (--propelauth-hashes-file)',
    credentials: [AUTH_URL, API_KEY, HASHES_FILE],
    limits: [
      'PropelAuth has no password-verify API and does not return hashes: PropelAuth support can export them on request. Pass that file with --propelauth-hashes-file; without it members set a password again on first sign-in.',
      'TOTP secrets, social-account ids and end-user API key secrets cannot be exported: members enrol their second factor again, relink social accounts by verified email and reissue API keys.',
      'SAML connections cannot be read back (the IdP settings are write-only): set each one up again in Atlas.',
      'Sessions are not exported: PropelAuth access tokens are exchanged by the propelauth bridge preset, which needs your project\'s verifier key.',
    ],
    async run(p, writer, resume) {
      const set = await vendorStep('PropelAuth', () =>
        exportPropelauth({
          authUrl: authUrl(p),
          apiKey: need(p, API_KEY),
          hashesText: localFile(p, HASHES_FILE, 'text'),
          fetchImpl: p.fetch,
          onProgress: (m) => p.say(`  reading ${m}`),
        }),
      );
      await writeRecordSet(set, writer, resume, p.say);
    },
  },
  bridge: {
    preset: 'propelauth',
    vars(p, t) {
      return { ...t?.bridge?.vars, auth_url: t?.bridge?.vars.auth_url ?? authUrl(p) };
    },
  },
  codemod: 'propelauth',
};
