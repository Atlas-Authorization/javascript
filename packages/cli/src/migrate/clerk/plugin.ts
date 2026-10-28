import { exportClerk } from '../export/clerk';
import { fetchClerkConfig, translateClerkConfig } from '../export/clerk-config';
import { clerkFrontendApiFromPublishableKey } from '@atlasauth/backend';
import { CliError } from '../../errors';
import type { CredentialSpec, MigrationPlugin, PluginContext } from '../framework/plugin';
import { flag, localFile, vendorStep, writeRecordSet } from '../export/plugin-kit';

/**
 * `atlas migrate clerk` — Clerk's Backend API (secret key) plus the dashboard
 * CSV export (the only source of password digests and TOTP secrets), the
 * `clerk` JWT bridge preset (session tokens verified against the Frontend
 * API's JWKS), lazy password verification through Clerk's verify_password
 * for users the CSV does not cover, and the `clerk` codemod.
 */

const SECRET_KEY: CredentialSpec = { flag: '--clerk-secret-key', env: 'CLERK_SECRET_KEY', label: 'your Clerk secret key (sk_…)', required: false, secret: true };
const PUBLISHABLE_KEY: CredentialSpec = { flag: '--clerk-publishable-key', env: 'CLERK_PUBLISHABLE_KEY', label: 'your Clerk publishable key (pk_…)', required: false };
const CSV: CredentialSpec = { flag: '--clerk-csv', env: 'CLERK_CSV_EXPORT', label: 'the Clerk dashboard CSV export (Users → Export)', required: false };

/** The publishable key from the flag / CLERK_PUBLISHABLE_KEY, else the framework-prefixed env vars apps already have. */
function publishableKey(p: PluginContext): string | undefined {
  return (
    p.credential(PUBLISHABLE_KEY) ??
    ['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'VITE_CLERK_PUBLISHABLE_KEY', 'PUBLIC_CLERK_PUBLISHABLE_KEY', 'EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY'].map((k) => p.ctx.env[k]?.trim()).find(Boolean)
  );
}

export const clerkPlugin: MigrationPlugin = {
  vendor: 'clerk',
  source: 'clerk',
  label: 'Clerk',
  help: 'Move a Clerk instance: its settings (social connections, sign-in methods, MFA, organizations, JWT templates), its users with their password digests and TOTP secrets from the dashboard CSV export, organizations, members, roles, invitations, enterprise connections and API keys from the Backend API, a zero-logout bridge for signed-in users, and the code. Your secret key stays on this machine.',
  config: {
    reads: 'your Clerk instance (the public environment via the publishable key, plus JWT templates, redirect URLs and roles with the secret key)',
    credentials: [PUBLISHABLE_KEY, SECRET_KEY],
    async translate(p) {
      const pk = publishableKey(p);
      if (!pk) throw new CliError('Clerk: the publishable key is needed (--clerk-publishable-key, CLERK_PUBLISHABLE_KEY or NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY).');
      const snap = await vendorStep('Clerk', () => fetchClerkConfig({ publishableKey: pk, secretKey: p.credential(SECRET_KEY), fetchImpl: p.fetch }));
      return translateClerkConfig(snap);
    },
  },
  export: {
    reads: 'the Clerk Backend API (secret key) and/or the dashboard CSV export (--clerk-csv)',
    credentials: [SECRET_KEY, CSV],
    limits: [
      'Password digests and TOTP secrets only come from the dashboard CSV export (Users → Export); without it, users keep their passwords through lazy migration (verify_password) instead.',
      'Passkeys (only their names are readable) and backup codes cannot be exported: those users enrol again.',
      'Sessions are not exported: Clerk session tokens are JWTs, exchanged by the clerk bridge preset.',
    ],
    async run(p, writer, resume) {
      const secretKey = p.credential(SECRET_KEY);
      const csv = localFile(p, CSV, 'text');
      if (!secretKey && !csv) throw new CliError('Clerk: pass the secret key (--clerk-secret-key / CLERK_SECRET_KEY), the dashboard CSV export (--clerk-csv), or both.');
      const set = await vendorStep('Clerk', () =>
        exportClerk({ secretKey, csv, fetchImpl: p.fetch, skipApiKeys: flag(p, 'skip-api-keys'), onProgress: (m) => p.say(`  reading ${m}`) }),
      );
      await writeRecordSet(set, writer, resume, p.say);
    },
  },
  bridge: {
    preset: 'clerk',
    vars(p, t) {
      const pk = publishableKey(p);
      const fromKey = pk ? clerkFrontendApiFromPublishableKey(pk) : null;
      const frontend_api = t?.bridge?.vars.frontend_api ?? fromKey;
      const vars: Record<string, string> = {};
      if (frontend_api) vars.frontend_api = frontend_api;
      return vars;
    },
  },
  lazy: {
    preset: 'clerk',
    config: () => ({}),
    secret: { ...SECRET_KEY, required: true },
  },
  codemod: 'clerk',
};
