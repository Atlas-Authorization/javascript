import { exportKinde, m2mToken } from '../export/kinde';
import { fetchKindeConfig, translateKindeConfig } from '../export/kinde-descope-config';
import { CliError } from '../../errors';
import type { CredentialSpec, MigrationPlugin, PluginContext } from '../framework/plugin';
import { flag, hostOf, localFile, need, vendorStep, writeRecordSet } from '../export/plugin-kit';
import { VendorHttp } from '../export/vendor-http';

/**
 * `atlas migrate kinde` — Kinde's "All data" export (Settings → Business →
 * Export data: an AES-256-CTR encrypted zip holding users.ndjson with bcrypt
 * hashes and organizations.ndjson; the Key and IV are shown at download),
 * merged with what the Management API adds (identities, organizations,
 * members, roles, permissions, invitations). Kinde has no password grant, so
 * there is no lazy-migration preset: passwords move with the export. The
 * `kinde` bridge preset verifies Kinde's access and ID tokens against the
 * business's JWKS.
 */

const DOMAIN: CredentialSpec = { flag: '--kinde-domain', env: 'KINDE_ISSUER_URL', label: 'your Kinde domain (https://example.kinde.com)', required: false };
const CLIENT_ID: CredentialSpec = { flag: '--kinde-client-id', env: 'KINDE_M2M_CLIENT_ID', label: 'the client id of a machine-to-machine app authorized for the Kinde Management API', required: false };
const CLIENT_SECRET: CredentialSpec = { flag: '--kinde-client-secret', env: 'KINDE_M2M_CLIENT_SECRET', label: 'that app\'s client secret', required: false, secret: true };
const EXPORT_FILE: CredentialSpec = { flag: '--kinde-export', env: 'KINDE_EXPORT_FILE', label: 'the Kinde data export (.dat, or the decrypted .zip)', required: false };
const EXPORT_KEY: CredentialSpec = { flag: '--kinde-export-key', env: 'KINDE_EXPORT_KEY', label: 'the Key Kinde showed with the export (hex)', required: false, secret: true };
const EXPORT_IV: CredentialSpec = { flag: '--kinde-export-iv', env: 'KINDE_EXPORT_IV', label: 'the IV Kinde showed with the export (hex)', required: false };

function domainOf(p: PluginContext): string | undefined {
  const raw = p.credential(DOMAIN) ?? p.ctx.env.KINDE_DOMAIN?.trim();
  return raw ? hostOf(raw) : undefined;
}

export const kindePlugin: MigrationPlugin = {
  vendor: 'kinde',
  source: 'kinde',
  label: 'Kinde',
  help: 'Move a Kinde business: applications, connections, roles, permissions and APIs as Atlas config; users with their bcrypt password hashes from Kinde\'s encrypted data export, plus organizations, members and roles from the Management API (social accounts relink by verified email); a zero-logout bridge for Kinde tokens; and the code. The export key and API credentials stay on this machine.',
  config: {
    reads: 'your Kinde business via the Management API (applications, connections, roles, permissions, APIs)',
    credentials: [DOMAIN, CLIENT_ID, CLIENT_SECRET],
    async translate(p) {
      const domain = domainOf(p);
      if (!domain) throw new CliError('Kinde: your Kinde domain is needed (--kinde-domain or KINDE_ISSUER_URL).');
      const clientId = need(p, CLIENT_ID);
      const clientSecret = need(p, CLIENT_SECRET);
      const base = `https://${domain}`;
      let token: string | undefined;
      const http = new VendorHttp({
        vendor: 'Kinde',
        baseUrl: `${base}/api/v1`,
        headers: async () => ({ authorization: `Bearer ${(token ??= await m2mToken(base, { clientId, clientSecret, fetchImpl: p.fetch }))}` }),
        fetchImpl: p.fetch,
      });
      const snap = await vendorStep('Kinde', () => fetchKindeConfig(http, domain));
      return translateKindeConfig(snap);
    },
  },
  export: {
    reads: 'the Kinde data export (--kinde-export with its Key and IV) and/or the Kinde Management API',
    credentials: [DOMAIN, CLIENT_ID, CLIENT_SECRET, EXPORT_FILE, EXPORT_KEY, EXPORT_IV],
    limits: [
      'Password hashes only come from the "All data" export (Settings → Business → Export data), which the business owner approves; Kinde has no password grant, so without it users set a new password (or sign in with a code / social login).',
      'MFA secrets and passkeys are not exportable: users enrol again.',
      'Sessions are not exported: Kinde tokens are JWTs, exchanged by the kinde bridge preset.',
    ],
    async run(p, writer, resume) {
      const file = localFile(p, EXPORT_FILE, 'bytes');
      const domain = domainOf(p);
      const clientId = p.credential(CLIENT_ID);
      const clientSecret = p.credential(CLIENT_SECRET);
      if (!file && !(domain && clientId && clientSecret)) {
        throw new CliError('Kinde: pass the data export (--kinde-export with --kinde-export-key and --kinde-export-iv), Management API credentials (KINDE_ISSUER_URL, KINDE_M2M_CLIENT_ID, KINDE_M2M_CLIENT_SECRET), or both.');
      }
      let encryptedExport: { data: Buffer; key: string; iv: string } | undefined;
      let zip: Buffer | undefined;
      if (file) {
        // A zip (already decrypted) starts with PK\x03\x04; anything else is the encrypted .dat.
        if (file.length >= 4 && file.readUInt32LE(0) === 0x04034b50) zip = file;
        else encryptedExport = { data: file, key: need(p, EXPORT_KEY), iv: need(p, EXPORT_IV) };
      }
      const set = await vendorStep('Kinde', () =>
        exportKinde({
          domain,
          clientId,
          clientSecret,
          encryptedExport,
          zip,
          includeDefaultOrganization: flag(p, 'kinde-include-default-org'),
          fetchImpl: p.fetch,
          onProgress: (m) => p.say(`  reading ${m}`),
        }),
      );
      await writeRecordSet(set, writer, resume, p.say);
    },
  },
  bridge: {
    preset: 'kinde',
    vars(p, t) {
      const domain = domainOf(p) ?? t?.bridge?.vars.domain;
      const vars: Record<string, string> = {};
      if (domain) vars.domain = domain;
      return vars;
    },
  },
  codemod: 'kinde',
};
