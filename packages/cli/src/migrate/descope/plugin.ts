import { exportDescope } from '../export/descope';
import { fetchDescopeConfig, translateDescopeConfig } from '../export/kinde-descope-config';
import type { CredentialSpec, MigrationPlugin, PluginContext } from '../framework/plugin';
import { localFile, need, vendorStep, writeRecordSet } from '../export/plugin-kit';
import { VendorHttp } from '../export/vendor-http';

/**
 * `atlas migrate descope` — users, tenants, roles and permissions through the
 * Descope Management API (project id + management key, on this machine),
 * password hashes from the export Descope support provides when the owner
 * has it, the `descope` bridge preset (DS session JWTs verified against the
 * project's keys) and lazy migration through Descope's password sign-in for
 * every other password.
 */

const PROJECT_ID: CredentialSpec = { flag: '--descope-project-id', env: 'DESCOPE_PROJECT_ID', label: 'your Descope project id (P…)', required: true };
const MANAGEMENT_KEY: CredentialSpec = { flag: '--descope-management-key', env: 'DESCOPE_MANAGEMENT_KEY', label: 'a Descope management key', required: true, secret: true };
const BASE_URL: CredentialSpec = { flag: '--descope-base-url', env: 'DESCOPE_BASE_URL', label: 'the Descope API base URL (regional or custom domain)', required: false };
const HASHES_FILE: CredentialSpec = { flag: '--descope-hashes-file', env: 'DESCOPE_HASHES_FILE', label: 'the password-hash export from Descope support', required: false };

function projectId(p: PluginContext): string {
  return p.credential({ ...PROJECT_ID, required: false }) ?? (p.ctx.env.NEXT_PUBLIC_DESCOPE_PROJECT_ID?.trim() || need(p, PROJECT_ID));
}

function baseUrl(p: PluginContext): string | undefined {
  return (p.credential(BASE_URL) ?? (p.ctx.env.NEXT_PUBLIC_DESCOPE_BASE_URL?.trim() || undefined))?.replace(/\/+$/, '');
}

export const descopePlugin: MigrationPlugin = {
  vendor: 'descope',
  source: 'descope',
  label: 'Descope',
  help: 'Move a Descope project: password policy, roles and permissions as Atlas config; users with their login ids, verified emails and phones, social and SSO links, tenants (as organizations), roles and custom attributes; password hashes from the export Descope support provides; a zero-logout bridge for DS session tokens; lazy migration for the other passwords; and the code. Your management key stays on this machine.',
  config: {
    reads: 'your Descope project via the Management API (password settings, roles, permissions)',
    credentials: [PROJECT_ID, MANAGEMENT_KEY],
    async translate(p) {
      const pid = projectId(p);
      const http = new VendorHttp({ vendor: 'Descope', baseUrl: baseUrl(p) ?? 'https://api.descope.com', headers: { authorization: `Bearer ${pid}:${need(p, MANAGEMENT_KEY)}` }, fetchImpl: p.fetch });
      const snap = await vendorStep('Descope', () => fetchDescopeConfig(http, pid));
      return translateDescopeConfig(snap);
    },
  },
  export: {
    reads: 'the Descope Management API (users, tenants, roles) and the support hash export (--descope-hashes-file)',
    credentials: [PROJECT_ID, MANAGEMENT_KEY, HASHES_FILE],
    limits: [
      'Password hashes are not returned by the Management API: Descope support can export them on request. Pass that file with --descope-hashes-file; without it, passwords move by lazy migration.',
      'TOTP seeds, passkeys and magic-link / OTP state cannot be exported: users enrol their second factor and passkeys again (email and SMS codes simply work).',
      'Sessions are not exported: Descope session tokens are JWTs, exchanged by the descope bridge preset.',
    ],
    async run(p, writer, resume) {
      const set = await vendorStep('Descope', () =>
        exportDescope({
          projectId: projectId(p),
          managementKey: need(p, MANAGEMENT_KEY),
          baseUrl: baseUrl(p),
          hashesText: localFile(p, HASHES_FILE, 'text'),
          fetchImpl: p.fetch,
          onProgress: (m) => p.say(`  reading ${m}`),
        }),
      );
      await writeRecordSet(set, writer, resume, p.say);
    },
  },
  bridge: {
    preset: 'descope',
    vars(p, t) {
      const vars: Record<string, string> = { ...t?.bridge?.vars, project_id: t?.bridge?.vars.project_id ?? projectId(p) };
      const base = baseUrl(p);
      if (base) vars.base_url = base;
      return vars;
    },
  },
  lazy: {
    preset: 'descope',
    config(p, t) {
      const config: Record<string, string> = { ...t?.lazy?.config, project_id: t?.lazy?.config.project_id ?? projectId(p) };
      const base = baseUrl(p);
      if (base) config.base_url = base;
      return config;
    },
  },
  codemod: 'descope',
};
