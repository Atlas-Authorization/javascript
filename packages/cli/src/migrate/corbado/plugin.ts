import { corbadoHttp, exportCorbado } from '../export/corbado';
import { fetchCorbadoConfig, translateCorbadoConfig } from '../export/corbado-config';
import type { CredentialSpec, MigrationPlugin, PluginContext } from '../framework/plugin';
import { need, vendorStep, writeRecordSet } from '../export/plugin-kit';

/**
 * `atlas migrate corbado` — users with their verified emails, phones and
 * usernames AND their passkeys (credential ids and public keys, which
 * Corbado's Backend API exports), the sign-in methods inferred from your
 * users' identifiers, and the `corbado` bridge preset (short-session JWTs
 * verified against the project's JWKS). Corbado holds no passwords.
 */

const PROJECT_ID: CredentialSpec = { flag: '--corbado-project-id', env: 'CORBADO_PROJECT_ID', label: 'your Corbado project id (pro-…)', required: true };
const API_SECRET: CredentialSpec = { flag: '--corbado-api-secret', env: 'CORBADO_API_SECRET', label: 'your Corbado API secret', required: true, secret: true };
const RP_ID: CredentialSpec = { flag: '--corbado-rp-id', env: 'CORBADO_RP_ID', label: 'the relying-party id (domain) your passkeys were registered for', required: false };
const BASE_URL: CredentialSpec = { flag: '--corbado-base-url', env: 'CORBADO_BASE_URL', label: 'the Corbado Backend API origin', required: false };

function projectId(p: PluginContext): string {
  return p.credential({ ...PROJECT_ID, required: false }) ?? (p.ctx.env.NEXT_PUBLIC_CORBADO_PROJECT_ID?.trim() || p.ctx.env.VITE_CORBADO_PROJECT_ID?.trim() || need(p, PROJECT_ID));
}

export const corbadoPlugin: MigrationPlugin = {
  vendor: 'corbado',
  source: 'corbado',
  label: 'Corbado',
  help: 'Move a Corbado project: users with their verified emails, phone numbers and usernames, and their passkeys (credential ids and public keys) so members keep signing in with the passkey they have; the sign-in methods as Atlas config; a zero-logout bridge for Corbado session tokens; and the code. Your API secret stays on this machine.',
  config: {
    reads: 'your Corbado project via the Backend API (login identifier counts)',
    credentials: [PROJECT_ID, API_SECRET, RP_ID, BASE_URL],
    async translate(p) {
      const pid = projectId(p);
      const http = corbadoHttp({ projectId: pid, apiSecret: need(p, API_SECRET), baseUrl: p.credential(BASE_URL), fetchImpl: p.fetch });
      const snap = await vendorStep('Corbado', () => fetchCorbadoConfig(http, pid, p.credential(RP_ID)));
      return translateCorbadoConfig(snap);
    },
  },
  export: {
    reads: 'the Corbado Backend API (users, identifiers, passkeys)',
    credentials: [PROJECT_ID, API_SECRET, RP_ID, BASE_URL],
    limits: [
      'Passkeys are exported with their public keys but are bound to your relying-party id (--corbado-rp-id): Atlas must be served from that domain, or a subdomain, for them to keep working. Without the flag, members register passkeys again.',
      'Corbado keeps no passwords, authenticator-app secrets, organizations or API keys.',
      'Linked social accounts are not returned: they relink by verified email on first social sign-in.',
      'Sessions are not exported: Corbado session tokens are JWTs, exchanged by the corbado bridge preset.',
    ],
    async run(p, writer, resume) {
      const set = await vendorStep('Corbado', () =>
        exportCorbado({
          projectId: projectId(p),
          apiSecret: need(p, API_SECRET),
          baseUrl: p.credential(BASE_URL),
          rpId: p.credential(RP_ID),
          fetchImpl: p.fetch,
          onProgress: (m) => p.say(`  reading ${m}`),
        }),
      );
      await writeRecordSet(set, writer, resume, p.say);
    },
  },
  bridge: {
    preset: 'corbado',
    vars: (p, t) => ({ ...t?.bridge?.vars, project_id: t?.bridge?.vars.project_id ?? projectId(p) }),
  },
  codemod: 'corbado',
};
