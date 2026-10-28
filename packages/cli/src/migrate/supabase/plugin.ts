import { resolve } from 'node:path';
import { exportSupabase } from '../export/supabase';
import { fetchSupabaseAuthConfig, settingsFromToml, translateSupabaseConfig } from '../export/supabase-config';
import { CliError } from '../../errors';
import type { CredentialSpec, MigrationPlugin, PluginContext } from '../framework/plugin';
import { vendorStep, writeRecordSet } from '../export/plugin-kit';

/**
 * `atlas migrate supabase` — Supabase Auth, hosted or self-hosted: its
 * `config.toml` (or the hosted project's settings through the Management
 * API) as Atlas config; users with their bcrypt / argon2 / Firebase-scrypt
 * hashes, identities, SAML connections, TOTP secrets, phone and WebAuthn
 * factors, recovery-code hashes and live sessions from a dump of the auth
 * schema made on this machine; the `supabase` bridge preset (a Supabase
 * access token becomes an Atlas session); lazy migration when only the Admin
 * API is available; and the code. Nothing here connects to the database.
 */

const PROJECT_URL: CredentialSpec = { flag: '--supabase-url', env: 'SUPABASE_URL', label: 'your project URL (https://<ref>.supabase.co)', required: false };
const DUMP: CredentialSpec = { flag: '--supabase-dump', env: 'SUPABASE_DUMP_DIR', label: 'a folder of auth-schema table dumps (users.csv, identities.csv, …)', required: false };
const SERVICE_ROLE: CredentialSpec = { flag: '--supabase-service-role-key', env: 'SUPABASE_SERVICE_ROLE_KEY', label: 'the service_role / secret key (Admin API export only)', required: false, secret: true };
const CONFIG_FILE: CredentialSpec = { flag: '--supabase-config', env: 'SUPABASE_CONFIG_TOML', label: 'supabase/config.toml', required: false };
const ACCESS_TOKEN: CredentialSpec = { flag: '--supabase-access-token', env: 'SUPABASE_ACCESS_TOKEN', label: 'a personal access token (Management API)', required: false, secret: true };
const PROJECT_REF: CredentialSpec = { flag: '--supabase-project-ref', env: 'SUPABASE_PROJECT_REF', label: 'the project ref (the subdomain of <ref>.supabase.co)', required: false };
const ANONYMOUS: CredentialSpec = { flag: '--supabase-anonymous', env: 'SUPABASE_ANONYMOUS', label: '"include" to export anonymous users too', required: false };
const ANON_KEY: CredentialSpec = { flag: '--supabase-anon-key', env: 'SUPABASE_ANON_KEY', label: 'the anon / publishable key, for lazy migration', required: false };
const DB_KEYS: CredentialSpec = { flag: '--supabase-db-encryption-keys', env: 'GOTRUE_SECURITY_DB_ENCRYPTION_KEYS', label: 'GoTrue column-encryption keys, comma-separated key_id:key (only when GOTRUE_SECURITY_DB_ENCRYPTION_ENCRYPT is on)', required: false, secret: true };
const BRIDGE: CredentialSpec = { flag: '--supabase-bridge', env: 'SUPABASE_BRIDGE', label: 'what the bridge exchanges: access-token (default; up to a week past expiry) or refresh-token (the sessions the dump imported)', required: false };
const AUTH_URL: CredentialSpec = { flag: '--supabase-auth-url', env: 'SUPABASE_AUTH_URL', label: 'self-hosted or custom domain: the Auth URL (https://db.example.com/auth/v1)', required: false };
const COOKIE_NAME: CredentialSpec = { flag: '--supabase-cookie-name', env: 'SUPABASE_COOKIE_NAME', label: 'self-hosted: the SSR cookie name (sb-<first label of the host>-auth-token)', required: false };
const RP_ID: CredentialSpec = { flag: '--rp-id', env: 'ATLAS_MIGRATE_RP_ID', label: 'the WebAuthn relying party id passkeys were registered for', required: false };

/** The project ref, from the flag or a hosted URL. */
function refOf(p: PluginContext): string | undefined {
  const ref = p.credential(PROJECT_REF);
  if (ref) return ref.trim();
  const url = p.credential(PROJECT_URL);
  return url ? /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/.exec(url.trim())?.[1] : undefined;
}

/**
 * `supabase` (hosted access tokens), `supabase_self_hosted` (an Auth URL of
 * your own) or `supabase_refresh_token` (refresh tokens among the sessions the
 * dump imported; hosted cookie names).
 */
function bridgePreset(p: PluginContext): string {
  const mode = (p.credential(BRIDGE) ?? 'access-token').trim().toLowerCase();
  if (mode === 'refresh-token') {
    if (p.credential(AUTH_URL)) throw new CliError('Supabase: --set supabase-bridge=refresh-token reads the hosted cookie (sb-<ref>-auth-token); for a self-hosted project use the access-token bridge, or set the preset and cookie name through the bridge API.');
    return 'supabase_refresh_token';
  }
  if (mode !== 'access-token') throw new CliError(`Supabase: --set supabase-bridge takes access-token or refresh-token (got ${mode}).`);
  return p.credential(AUTH_URL) ? 'supabase_self_hosted' : 'supabase';
}

export const supabasePlugin: MigrationPlugin = {
  vendor: 'supabase',
  source: 'supabase',
  label: 'Supabase Auth',
  help: 'Move Supabase Auth (hosted or self-hosted): config.toml or the hosted project settings as Atlas config; users with their password hashes, social and SAML identities, TOTP secrets, phone and WebAuthn factors and live sessions from a dump of the auth schema you make with psql; a zero-logout bridge for Supabase access tokens; lazy migration when you only have the Admin API; and the code. Database access stays on this machine.',
  config: {
    reads: 'supabase/config.toml (or the hosted project through the Management API)',
    credentials: [CONFIG_FILE, ACCESS_TOKEN, PROJECT_REF, PROJECT_URL],
    async translate(p) {
      const token = p.credential(ACCESS_TOKEN);
      const ref = refOf(p);
      if (token && ref) {
        return translateSupabaseConfig(await vendorStep('Supabase', () => fetchSupabaseAuthConfig({ projectRef: ref, accessToken: token, fetchImpl: p.fetch })));
      }
      const path = p.credential(CONFIG_FILE) ?? `${p.project}/supabase/config.toml`;
      let text: string;
      try {
        text = p.ctx.readFile(resolve(path));
      } catch {
        throw new CliError(`Supabase: no config.toml at ${path}. Pass --set supabase-config=<path>, or a personal access token and project ref to read the hosted project.`);
      }
      const settings = settingsFromToml(text, path);
      return translateSupabaseConfig(ref ? { ...settings, projectRef: ref } : settings);
    },
  },
  export: {
    reads: 'a dump of the auth schema (psql \\copy of auth.users, identities, mfa_factors, sessions, refresh_tokens, sso_*, webauthn_credentials) or the Admin API',
    credentials: [DUMP, PROJECT_URL, SERVICE_ROLE, ANONYMOUS, RP_ID, DB_KEYS],
    limits: [
      'Password hashes, TOTP secrets and sessions live only in the database: dump the auth schema (see the guide). The Admin API export has none of them, and passwords then move by lazy migration.',
      'Values encrypted with GoTrue column encryption (GOTRUE_SECURITY_DB_ENCRYPTION_*) are decrypted on this machine with --set supabase-db-encryption-keys=<key_id>:<key>; without the keys those passwords move by lazy migration and those TOTP users enrol again.',
      'Recovery codes move as their argon2id hashes; passkeys and WebAuthn factors only with --rp-id and when Atlas serves sign-in on that domain.',
      'Refresh tokens in the newer signed format (no auth.refresh_tokens row) cannot be exported; the supabase bridge still exchanges the access token.',
    ],
    async run(p, writer, resume) {
      const dump = p.credential(DUMP);
      const url = p.credential(PROJECT_URL);
      const key = dump ? undefined : p.credential(SERVICE_ROLE);
      if (!dump && !(url && key)) {
        throw new CliError('Supabase: pass a folder of auth-schema dumps (--set supabase-dump=<folder>), or the project URL and service_role key for an Admin API export without password hashes.');
      }
      const set = await vendorStep('Supabase', () =>
        exportSupabase({
          dumpDir: dump ? resolve(dump) : undefined,
          url,
          serviceRoleKey: key,
          rpId: p.credential(RP_ID),
          includeAnonymous: p.credential(ANONYMOUS) === 'include',
          dbEncryptionKeys: p.credential(DB_KEYS)?.split(',').map((k) => k.trim()).filter(Boolean),
          fetchImpl: p.fetch,
          onProgress: (m) => p.say(`  reading ${m}`),
        }),
      );
      await writeRecordSet(set, writer, resume, p.say);
    },
  },
  bridge: {
    preset: 'supabase',
    presetFor: bridgePreset,
    vars(p, t) {
      const vars: Record<string, string> = { ...t?.bridge?.vars };
      const preset = bridgePreset(p);
      if (preset === 'supabase_self_hosted') {
        const authUrl = p.credential(AUTH_URL)!.trim().replace(/\/+$/, '');
        delete vars.project_ref;
        vars.auth_url = authUrl;
        const host = /^https?:\/\/([^/:]+)/i.exec(authUrl)?.[1];
        if (!host) throw new CliError(`Supabase: --set supabase-auth-url must be an https URL ending in /auth/v1 (got ${authUrl}).`);
        // @supabase/ssr names the cookie after the first label of the project host.
        vars.cookie_name = p.credential(COOKIE_NAME)?.trim() ?? `sb-${host.split('.')[0]}-auth-token`;
        return vars;
      }
      const ref = refOf(p);
      if (ref) vars.project_ref = ref;
      return vars;
    },
  },
  lazy: {
    preset: 'supabase',
    config(p, t) {
      const config: Record<string, string> = { ...t?.lazy?.config };
      const url = p.credential(PROJECT_URL);
      if (url) config.url = url.trim().replace(/\/+$/, '');
      const anon = p.credential(ANON_KEY);
      if (anon) config.anon_key = anon;
      return config;
    },
  },
  codemod: 'supabase',
};
