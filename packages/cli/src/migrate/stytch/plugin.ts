import { detectStytchProduct, exportStytch, stytchHttp, type StytchProduct } from '../export/stytch';
import { fetchStytchConfig, translateStytchConfig } from '../export/stytch-config';
import type { CredentialSpec, MigrationPlugin, PluginContext } from '../framework/plugin';
import { localFile, need, vendorStep, writeRecordSet } from '../export/plugin-kit';

/**
 * `atlas migrate stytch` — a Stytch project (consumer or B2B) through the
 * Stytch API with the project id and secret (on this machine): users with
 * verified emails and phones, OAuth identities, organizations, members, roles
 * and SSO connections as data, RBAC as Atlas config; password hashes from the
 * export Stytch support provides; the `stytch` bridge preset (session JWTs
 * verified against the project's JWKS) and lazy migration through Stytch's
 * password authentication.
 */

const PROJECT_ID: CredentialSpec = { flag: '--stytch-project-id', env: 'STYTCH_PROJECT_ID', label: 'your Stytch project id (project-live-…)', required: true };
const SECRET: CredentialSpec = { flag: '--stytch-secret', env: 'STYTCH_SECRET', label: 'your Stytch project secret', required: true, secret: true };
const HASHES: CredentialSpec = { flag: '--stytch-hashes', env: 'STYTCH_HASHES_FILE', label: 'the password-hash export from Stytch support', required: false };
const PRODUCT: CredentialSpec = { flag: '--stytch-product', env: 'STYTCH_PRODUCT', label: 'consumer or b2b (detected when omitted)', required: false };
const BASE_URL: CredentialSpec = { flag: '--stytch-base-url', env: 'STYTCH_BASE_URL', label: 'the Stytch API base URL (custom domain)', required: false };

function baseUrl(p: PluginContext): string | undefined {
  return p.credential(BASE_URL)?.replace(/\/+$/, '');
}

function productOpt(p: PluginContext): StytchProduct | undefined {
  const v = p.credential(PRODUCT)?.trim().toLowerCase();
  if (v === undefined || v === '') return undefined;
  if (v !== 'consumer' && v !== 'b2b') throw new Error(`${PRODUCT.flag} must be "consumer" or "b2b"`);
  return v;
}

function http(p: PluginContext) {
  return stytchHttp({ projectId: need(p, PROJECT_ID), secret: need(p, SECRET), baseUrl: baseUrl(p), fetchImpl: p.fetch });
}

export const stytchPlugin: MigrationPlugin = {
  vendor: 'stytch',
  source: 'stytch',
  label: 'Stytch',
  help: 'Move a Stytch project (consumer or B2B): users with verified emails and phones and OAuth identities, organizations with members, roles and SSO connections, RBAC as Atlas config, password hashes from the export Stytch support provides, a zero-logout bridge for Stytch session JWTs, lazy migration through Stytch password authentication, and the code. Your project secret stays on this machine.',
  config: {
    reads: 'your Stytch project via the API (RBAC policy, organizations, SSO connections)',
    credentials: [PROJECT_ID, SECRET, PRODUCT, BASE_URL],
    async translate(p) {
      const projectId = need(p, PROJECT_ID);
      const client = http(p);
      const snap = await vendorStep('Stytch', async () => fetchStytchConfig(client, projectId, productOpt(p) ?? (await detectStytchProduct(client))));
      return translateStytchConfig(snap);
    },
  },
  export: {
    reads: 'the Stytch API (users, or organizations, members and SSO connections, plus the RBAC policy) and, if you have one, the support hash export (--stytch-hashes)',
    credentials: [PROJECT_ID, SECRET, HASHES, PRODUCT, BASE_URL],
    limits: [
      'Stytch only provides password hashes through support (support@stytch.com): pass that file with --stytch-hashes; otherwise passwords move by lazy migration (checked against Stytch on each user\'s first sign-in).',
      'TOTP secrets, passkeys (WebAuthn) and crypto wallets are not exportable: users enrol again.',
      'SCIM bearer tokens and OIDC client secrets are not returned: recreate those connections in Atlas.',
      'Sessions are not exported: Stytch session JWTs are exchanged by the stytch bridge preset.',
    ],
    async run(p, writer, resume) {
      const set = await vendorStep('Stytch', () =>
        exportStytch({
          projectId: need(p, PROJECT_ID),
          secret: need(p, SECRET),
          product: productOpt(p),
          baseUrl: baseUrl(p),
          hashesText: localFile(p, HASHES, 'text'),
          fetchImpl: p.fetch,
          onProgress: (m) => p.say(`  reading ${m}`),
        }),
      );
      await writeRecordSet(set, writer, resume, p.say);
    },
  },
  bridge: {
    preset: 'stytch',
    vars(p, t) {
      if (t?.bridge) return t.bridge.vars;
      const projectId = need(p, PROJECT_ID);
      return {
        project_id: projectId,
        ...(projectId.startsWith('project-test-') ? { api_host: 'test.stytch.com' } : {}),
        ...(productOpt(p) === 'b2b' ? { jwks_path: 'b2b/sessions' } : {}),
      };
    },
  },
  lazy: {
    preset: 'stytch',
    config(p, t) {
      if (t?.lazy) return t.lazy.config;
      const product = productOpt(p);
      return { project_id: need(p, PROJECT_ID), ...(product ? { product } : {}) };
    },
    secret: SECRET,
  },
  codemod: 'stytch',
};
