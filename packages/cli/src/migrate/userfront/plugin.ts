import { checkTenantId, exportUserfront, userfrontHttp } from '../export/userfront';
import { fetchUserfrontConfig, translateUserfrontConfig } from '../export/userfront-config';
import type { CredentialSpec, MigrationPlugin, PluginContext } from '../framework/plugin';
import { need, vendorStep, writeRecordSet } from '../export/plugin-kit';

/**
 * `atlas migrate userfront` — users, sub-tenants (as organizations) and roles
 * through Userfront's admin API (tenant id + admin key, on this machine), and
 * lazy migration through Userfront's password sign-in for every password:
 * Userfront never returns hashes. There is no bridge preset: Userfront tokens
 * carry no issuer claim, which the zero-logout bridge requires.
 */

const TENANT_ID: CredentialSpec = { flag: '--userfront-tenant-id', env: 'USERFRONT_TENANT_ID', label: 'your Userfront tenant id', required: true };
const API_KEY: CredentialSpec = { flag: '--userfront-api-key', env: 'USERFRONT_API_KEY', label: 'a Userfront admin API key (uf_live_admin_…)', required: true, secret: true };

/** The tenant id from the flag or env, else the one the app already uses. */
function tenantId(p: PluginContext): string {
  const env = p.ctx.env;
  const raw =
    p.credential({ ...TENANT_ID, required: false }) ??
    (env.NEXT_PUBLIC_USERFRONT_TENANT_ID ?? env.REACT_APP_USERFRONT_TENANT_ID ?? env.VITE_USERFRONT_TENANT_ID)?.trim() ??
    need(p, TENANT_ID);
  return checkTenantId(raw);
}

export const userfrontPlugin: MigrationPlugin = {
  vendor: 'userfront',
  source: 'userfront',
  label: 'Userfront',
  help: 'Move a Userfront tenant: users with their verified emails and phones, usernames and custom data, sub-tenants as organizations with member roles, roles as Atlas roles, lazy migration through Userfront\'s own sign-in for every password (Userfront never returns hashes), and the code. Your admin key stays on this machine.',
  config: {
    reads: 'your Userfront tenant via the admin API (roles)',
    credentials: [TENANT_ID, API_KEY],
    async translate(p) {
      const tid = tenantId(p);
      const http = userfrontHttp({ apiKey: need(p, API_KEY), fetchImpl: p.fetch });
      return translateUserfrontConfig(await vendorStep('Userfront', () => fetchUserfrontConfig(http, tid)));
    },
  },
  export: {
    reads: 'the Userfront admin API (users, sub-tenants, roles)',
    credentials: [TENANT_ID, API_KEY],
    limits: [
      'Userfront never returns password hashes: passwords move by lazy migration (the userfront preset checks each one against Userfront on the first Atlas sign-in).',
      'Second factors, passkeys and social-account ids cannot be exported: members enrol again, register passkeys again and relink social accounts by verified email.',
      'Pending invitations cannot be listed (Userfront can only create them): invite members again from Atlas.',
      'Sessions are not exported: Userfront tokens carry no issuer claim, so there is no zero-logout bridge; users sign in once after the switch.',
    ],
    async run(p, writer, resume) {
      const set = await vendorStep('Userfront', () =>
        exportUserfront({ tenantId: tenantId(p), apiKey: need(p, API_KEY), fetchImpl: p.fetch, onProgress: (m) => p.say(`  reading ${m}`) }),
      );
      await writeRecordSet(set, writer, resume, p.say);
    },
  },
  lazy: {
    preset: 'userfront',
    config(p, t) {
      return { ...t?.lazy?.config, tenant_id: t?.lazy?.config.tenant_id ?? tenantId(p) };
    },
  },
  codemod: 'userfront',
};
